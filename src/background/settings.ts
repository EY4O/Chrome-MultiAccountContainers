// The worker's view of the settings: managed policy over the user's choice
// over the default (see shared/settings.ts). Everything that depends on a
// setting reads it here and subscribes to changes, whether they come from the
// options page or from a policy update.

import { type Resolved, type SettingKey, type Settings, resolveSettings, validValue } from "../shared/settings.ts";

/** Before the settings layer, the sync switch was its own key. */
const LEGACY_SYNC = "syncEnabled";

let current: Resolved = resolveSettings({}, {});
const listeners: ((next: Settings, prev: Settings) => void | Promise<void>)[] = [];

/** Stands in for policy in the e2e tests, which can't set real Chrome policy. */
let managedForTest: Record<string, unknown> | null = null;

async function readManaged(): Promise<Record<string, unknown>> {
  if (managedForTest) return managedForTest;
  // Throws when no policy schema applies (some platforms, tests); no policy then.
  return chrome.storage.managed.get(null).catch(() => ({}));
}

async function readUser(): Promise<Record<string, unknown>> {
  const local = await chrome.storage.local.get(["settings", LEGACY_SYNC]);
  const user = { ...((local.settings as Record<string, unknown> | undefined) ?? {}) };
  // Keep a choice the user made before settings existed.
  if (!("syncEnabled" in user) && typeof local[LEGACY_SYNC] === "boolean") user.syncEnabled = local[LEGACY_SYNC];
  return user;
}

let reloading: Promise<void> = Promise.resolve();

/** Re-reads both sources. Chained, so overlapping changes notify once each, in order. */
function reload(): Promise<void> {
  reloading = reloading.then(async () => {
    const prev = current.values;
    current = resolveSettings(await readManaged(), await readUser());
    if (JSON.stringify(prev) === JSON.stringify(current.values)) return;
    for (const fn of listeners) await Promise.resolve(fn(current.values, prev)).catch((e) => console.warn(e));
  });
  return reloading;
}

// Registered synchronously so a policy change can wake the worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed" || (area === "local" && ("settings" in changes || LEGACY_SYNC in changes))) void ready.then(reload);
});

export const ready: Promise<void> = (async () => {
  current = resolveSettings(await readManaged(), await readUser());
})();

export function get(): Settings {
  return current.values;
}

export function resolved(): Resolved {
  return current;
}

/** Runs after any effective setting changes, with the old values for comparison. */
export function onSettingsChange(fn: (next: Settings, prev: Settings) => void | Promise<void>): void {
  listeners.push(fn);
}

/** Stores the user's choice. Refused for a setting an administrator has set. */
export async function setUserSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<Resolved> {
  await ready;
  if (current.locked.includes(key)) throw new Error("Your organization manages this setting");
  if (validValue(key, value) === undefined) throw new Error(`Invalid value for ${key}`);
  const user = await readUser();
  await chrome.storage.local.set({ settings: { ...user, [key]: value } });
  await chrome.storage.local.remove(LEGACY_SYNC);
  await reload();
  return current;
}

/** Test hook: pretend these values came from policy (null: back to real policy). */
export async function setManagedForTest(values: Record<string, unknown> | null): Promise<Resolved> {
  await ready; // else the first read could finish after this and overwrite it
  managedForTest = values;
  await reload();
  return current;
}
