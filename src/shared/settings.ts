// Settings and how their effective values are chosen. An administrator's value
// (chrome.storage.managed, set by Chrome policy) wins over the user's choice,
// which wins over the default; a managed setting is locked in the options page.
// Pure, so the precedence rules can be unit-tested outside Chrome.

export interface Settings {
  /** Sync container names, colours, emoji and site assignments through the Chrome account. */
  syncEnabled: boolean;
  /** Where each container's cookie-jar key lives: "memory" signs everything out when Chrome closes. */
  keyStorage: "memory" | "disk";
  /** Sign a container out after this long without being used. */
  idleTimeoutMinutes: number;
  /** Sign every container out when the computer locks. */
  signOutOnLock: boolean;
  /** Keep Windows' Microsoft device sign-in (x-ms-RefreshTokenCredential, x-ms-DeviceCredential) out of container tabs. */
  stripMicrosoftDeviceHeaders: boolean;
  /** Keep Chrome's Device Bound Session Credentials (Sec-Session-*) out of container tabs. */
  stripDbscHeaders: boolean;
  allowBackupExport: boolean;
  allowBackupImport: boolean;
}

export type SettingKey = keyof Settings;

export const DEFAULTS: Readonly<Settings> = {
  syncEnabled: false,
  keyStorage: "memory",
  idleTimeoutMinutes: 240,
  signOutOnLock: true,
  stripMicrosoftDeviceHeaders: true,
  stripDbscHeaders: true,
  allowBackupExport: true,
  allowBackupImport: true,
};

export const SETTING_KEYS = Object.keys(DEFAULTS) as SettingKey[];

/** Idle timeouts are checked every 15 minutes, so shorter ones can't be honoured. */
export const IDLE_MIN = 15;
export const IDLE_MAX = 60 * 24 * 30;

/** The value if it's valid for that setting, else undefined (ignored, never coerced). */
export function validValue<K extends SettingKey>(key: K, value: unknown): Settings[K] | undefined {
  switch (key) {
    case "keyStorage":
      return (value === "memory" || value === "disk" ? value : undefined) as Settings[K] | undefined;
    case "idleTimeoutMinutes":
      return (Number.isInteger(value) && (value as number) >= IDLE_MIN && (value as number) <= IDLE_MAX ? value : undefined) as Settings[K] | undefined;
    default:
      return (typeof value === "boolean" ? value : undefined) as Settings[K] | undefined;
  }
}

export interface Resolved {
  values: Settings;
  /** Settings an administrator has set; the user can't change them. */
  locked: SettingKey[];
}

/** Effective settings: managed value if set and valid, else the user's, else the default. */
export function resolveSettings(managed: Record<string, unknown>, user: Record<string, unknown>): Resolved {
  const values = { ...DEFAULTS } as Record<SettingKey, unknown>;
  const locked: SettingKey[] = [];
  for (const key of SETTING_KEYS) {
    const m = validValue(key, managed[key]);
    if (m !== undefined) {
      values[key] = m;
      locked.push(key);
      continue;
    }
    const u = validValue(key, user[key]);
    if (u !== undefined) values[key] = u;
  }
  return { values: values as unknown as Settings, locked };
}
