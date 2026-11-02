import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, resolveSettings } from "../../src/shared/settings.ts";

test("with nothing set, every setting is its default and nothing is locked", () => {
  const { values, locked } = resolveSettings({}, {});
  assert.deepEqual(values, DEFAULTS);
  assert.deepEqual(locked, []);
});

test("the user's choice beats the default", () => {
  const { values, locked } = resolveSettings({}, { keyStorage: "disk", idleTimeoutMinutes: 60, stripDbscHeaders: false });
  assert.equal(values.keyStorage, "disk");
  assert.equal(values.idleTimeoutMinutes, 60);
  assert.equal(values.stripDbscHeaders, false);
  assert.deepEqual(locked, []);
});

test("a managed value beats the user's choice and locks the setting", () => {
  const { values, locked } = resolveSettings(
    { syncEnabled: false, keyStorage: "memory" },
    { syncEnabled: true, keyStorage: "disk", allowBackupExport: false },
  );
  assert.equal(values.syncEnabled, false);
  assert.equal(values.keyStorage, "memory");
  assert.equal(values.allowBackupExport, false, "unmanaged settings still follow the user");
  assert.deepEqual(locked.sort(), ["keyStorage", "syncEnabled"]);
});

test("invalid values are ignored, never coerced, at both levels", () => {
  const { values, locked } = resolveSettings(
    { keyStorage: "cloud", idleTimeoutMinutes: 5, syncEnabled: "false", unknownPolicy: true },
    { idleTimeoutMinutes: 90.5, stripMicrosoftDeviceHeaders: 0 },
  );
  assert.deepEqual(values, DEFAULTS);
  assert.deepEqual(locked, []);
});

test("an invalid managed value falls back to the user's valid one", () => {
  const { values, locked } = resolveSettings({ idleTimeoutMinutes: 99999 }, { idleTimeoutMinutes: 480 });
  assert.equal(values.idleTimeoutMinutes, 480);
  assert.deepEqual(locked, []);
});
