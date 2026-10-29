import assert from "node:assert/strict";
import { test } from "node:test";
import { isSealed, newKey, seal, unseal } from "../../src/shared/crypto.ts";

test("seal and unseal round-trip, with fresh IVs", async () => {
  const key = newKey();
  const value = [{ name: "sid", value: "secret-session" }];
  const a = await seal(key, value);
  const b = await seal(key, value);
  assert.ok(isSealed(a));
  assert.notEqual(a.iv, b.iv);
  assert.ok(!JSON.stringify(a).includes("secret-session"), "no plaintext at rest");
  assert.deepEqual(await unseal(key, a), value);
});

test("a different key (after a reset) can't read the old jar", async () => {
  const sealed = await seal(newKey(), ["x"]);
  await assert.rejects(unseal(newKey(), sealed));
});

test("tampering is detected", async () => {
  const key = newKey();
  const sealed = await seal(key, ["x"]);
  const bytes = Uint8Array.from(atob(sealed.data), (c) => c.charCodeAt(0));
  bytes[0] ^= 1;
  await assert.rejects(unseal(key, { ...sealed, data: btoa(String.fromCharCode(...bytes)) }));
});
