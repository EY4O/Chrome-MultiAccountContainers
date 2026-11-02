import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBackup } from "../../src/shared/backup.ts";

const good = () => ({
  format: "containers-backup",
  version: 1,
  exportedAt: "2026-11-02T00:00:00.000Z",
  containers: [
    { id: "0a1b2c3d", name: "Contoso", color: "red", emoji: "🏢" },
    { id: "4e5f6a7b", name: "Fabrikam", color: "green" },
  ],
  assignments: {
    "portal.contoso.com": { containerId: "0a1b2c3d", ask: true },
    "admin.fabrikam.com": { containerId: "4e5f6a7b", ask: false, allowElsewhere: true },
    "localhost": { containerId: "99aabbcc", ask: true },
  },
});

const refuses = (mutate: (b: ReturnType<typeof good>) => void, pattern: RegExp) => {
  const b = good();
  mutate(b);
  assert.throws(() => validateBackup(b, ["99aabbcc"]), pattern);
};

test("a sound file passes, including a site for a container already on this computer", () => {
  assert.equal(validateBackup(good(), ["99aabbcc"]).containers.length, 2);
});

test("a file with no sites passes", () => {
  const b: Record<string, unknown> = good();
  delete b.assignments;
  assert.doesNotThrow(() => validateBackup(b, []));
});

test("something that isn't a backup is refused", () => {
  assert.throws(() => validateBackup({ nope: true }, []), /isn't a containers backup/);
  assert.throws(() => validateBackup(null, []), /isn't a containers backup/);
  assert.throws(() => validateBackup({ ...good(), version: 2 }, []), /newer version/);
});

test("colours must be Chrome's tab group colours", () => {
  refuses((b) => { b.containers[0].color = "magenta"; }, /Container 1 \("Contoso"\) has a colour/);
  refuses((b) => { (b.containers[1] as Record<string, unknown>).color = undefined; }, /Container 2 \("Fabrikam"\) has a colour/);
});

test("names must be non-empty and at most 64 characters", () => {
  refuses((b) => { b.containers[0].name = "   "; }, /Container 1 has no name/);
  refuses((b) => { (b.containers[0] as Record<string, unknown>).name = 42; }, /Container 1 has no name/);
  refuses((b) => { b.containers[0].name = "x".repeat(65); }, /longer than 64/);
  assert.doesNotThrow(() => validateBackup({ ...good(), containers: [{ id: "0a1b2c3d", name: "x".repeat(64), color: "red" }], assignments: {} }, []));
});

test("emoji must be short", () => {
  refuses((b) => { b.containers[0].emoji = "🏢🏢🏢🏢🏢🏢🏢🏢🏢"; }, /emoji/);
  refuses((b) => { (b.containers[0] as Record<string, unknown>).emoji = 7; }, /emoji/);
});

test("ids must match the format and be unique in the file", () => {
  refuses((b) => { b.containers[0].id = "imp1"; }, /id that isn't valid/);
  refuses((b) => { b.containers[0].id = "../../x"; }, /id that isn't valid/);
  refuses((b) => { b.containers[1].id = "0a1b2c3d"; }, /same id/);
});

test("sites must be bare hostnames", () => {
  for (const host of ["https://portal.contoso.com", "portal.contoso.com/login", "portal.contoso.com:443", "*.contoso.com", "", "a..b", "-bad.com"]) {
    refuses((b) => { (b.assignments as Record<string, unknown>)[host] = { containerId: "0a1b2c3d", ask: true }; }, /isn't a site address/);
  }
});

test("sites must point at a container in the file or on this computer", () => {
  refuses((b) => { b.assignments["portal.contoso.com"].containerId = "deadbeef"; }, /isn't in the file or on this computer/);
});

test("site entries must have the right shape", () => {
  refuses((b) => { (b.assignments as Record<string, unknown>)["portal.contoso.com"] = "0a1b2c3d"; }, /isn't valid/);
  refuses((b) => { (b.assignments["portal.contoso.com"] as Record<string, unknown>).ask = "yes"; }, /isn't valid/);
});
