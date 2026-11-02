import assert from "node:assert/strict";
import { test } from "node:test";
import { idleIds } from "../../src/shared/idle.ts";

const now = 1_700_000_000_000;
const min = 60_000;

test("the 4-hour default: idle at 4 hours, not a minute before", () => {
  const lastUsed = { a: now - 240 * min, b: now - 239 * min, c: now - 5 * min };
  assert.deepEqual(idleIds(lastUsed, ["a", "b", "c"], 240, now), ["a"]);
});

test("the threshold follows the setting", () => {
  const lastUsed = { a: now - 61 * min, b: now - 30 * min };
  assert.deepEqual(idleIds(lastUsed, ["a", "b"], 60, now), ["a"]);
  assert.deepEqual(idleIds(lastUsed, ["a", "b"], 15, now), ["a", "b"]);
  assert.deepEqual(idleIds(lastUsed, ["a", "b"], 43200, now), []);
});

test("a container with no recorded use counts as idle", () => {
  assert.deepEqual(idleIds({}, ["x"], 240, now), ["x"]);
});
