// Options page: sync, backup, keyboard shortcuts, and what the extension
// stores, in chrome://settings's card-of-rows layout.

import type { Backup, BgMessage, SyncStatus } from "../shared/messages.ts";
import type { Resolved, SettingKey, Settings } from "../shared/settings.ts";
import { h, icon, send } from "../ui/dom.ts";

const app = document.getElementById("app")!;

/** Effective settings and which ones an administrator has set. */
let settings: Resolved;
const isLocked = (key: SettingKey) => settings.locked.includes(key);

async function setSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  settings = await send<Resolved>({ type: "mac:set-setting", key, value } as BgMessage);
}

function lockedNote(): HTMLElement {
  return h("p", { class: "secondary locked-note" }, icon("lock"), "Set by your organization");
}

type BoolKey = { [K in SettingKey]: Settings[K] extends boolean ? K : never }[SettingKey];

/** A switch row for a yes/no setting; disabled, with a note, when it's managed. */
function switchRow(key: BoolKey, title: string, detail: string, extra: Node | null = null, after?: () => void | Promise<void>): HTMLElement {
  const toggle = h("input", { type: "checkbox", role: "switch", "aria-label": title, checked: settings.values[key], disabled: isLocked(key),
    onchange: async () => {
      toggle.disabled = true;
      try {
        await setSetting(key, toggle.checked);
      } finally {
        toggle.checked = settings.values[key];
        toggle.disabled = isLocked(key);
      }
      await after?.();
    } });
  return row(title, detail, h("label", { class: "switch" }, toggle, h("span", {})), h("div", {}, isLocked(key) ? lockedNote() : null, extra));
}

function ago(ms: number): string {
  if (!ms) return "not yet";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const hrs = Math.round(m / 60);
  return hrs < 24 ? `${hrs} hour${hrs === 1 ? "" : "s"} ago` : new Date(ms).toLocaleString();
}

function row(title: string, detail: Node | string | null, trailing: Node | null, extra: Node | null = null): HTMLElement {
  return h("div", { class: "card-row" },
    h("div", { class: "grow" }, h("p", { class: "title" }, title), detail && h("p", { class: "secondary" }, detail), extra),
    trailing);
}

async function syncSection(): Promise<HTMLElement> {
  const line = h("p", { class: "secondary status-line", role: "status" });
  async function paint(): Promise<void> {
    const status = await send<SyncStatus>({ type: "mac:sync-status" });
    if (!status.enabled) line.replaceChildren(h("span", { class: "status-ok" }, "Off. Changes stay on this computer."));
    else if (status.error) line.replaceChildren(h("span", { class: "status-bad" }, `Couldn't sync: ${status.error}`));
    else line.replaceChildren(h("span", { class: "status-ok" }, `On. Last synced ${ago(Math.max(status.lastPush, status.lastPull))}.`));
  }
  await paint();
  return h("section", {},
    h("h2", {}, "Sync"),
    h("div", { class: "card" },
      switchRow("syncEnabled", "Sync containers and site assignments",
        "Sends container names, colours, emoji and the addresses of “always open” sites to the Google account this Chrome profile is signed in to, so your other computers get them. Sign-ins and cookies never leave this computer. Turning sync off removes them from the account.",
        line, paint)));
}

const IDLE_CHOICES = [60, 120, 240, 480, 1440, 10080, 43200];

/** "4 hours", "1 day", "90 minutes". */
function duration(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

function idleRow(): HTMLElement {
  const current = settings.values.idleTimeoutMinutes;
  const choices = IDLE_CHOICES.includes(current) ? IDLE_CHOICES : [...IDLE_CHOICES, current].sort((a, b) => a - b);
  const select = h("select", { class: "select", "aria-label": "Sign out a container after it's unused for", disabled: isLocked("idleTimeoutMinutes"),
    onchange: async () => {
      select.disabled = true;
      try {
        await setSetting("idleTimeoutMinutes", Number(select.value));
      } finally {
        select.value = String(settings.values.idleTimeoutMinutes);
        select.disabled = isLocked("idleTimeoutMinutes");
      }
    } }, ...choices.map((m) => h("option", { value: String(m), selected: m === current }, duration(m))));
  return row("Sign out a container after it's unused for",
    "Using a container means switching to one of its tabs, or clicking, typing or scrolling in it. Pages that refresh themselves in the background don't count.",
    select, isLocked("idleTimeoutMinutes") ? lockedNote() : null);
}

/** How long container sign-ins last. */
function signInSection(): HTMLElement {
  const keep = h("input", { type: "checkbox", role: "switch", "aria-label": "Stay signed in after Chrome closes",
    checked: settings.values.keyStorage === "disk", disabled: isLocked("keyStorage"),
    onchange: async () => {
      keep.disabled = true;
      try {
        await setSetting("keyStorage", keep.checked ? "disk" : "memory");
      } finally {
        keep.checked = settings.values.keyStorage === "disk";
        keep.disabled = isLocked("keyStorage");
      }
    } });
  return h("section", {},
    h("h2", {}, "Sign-ins"),
    h("div", { class: "card" },
      row("Stay signed in after Chrome closes",
        "When this is off, each container's key is kept only while Chrome is open, so closing Chrome signs every container out. When it's on, keys are saved on this computer next to the encrypted cookies.",
        h("label", { class: "switch" }, keep, h("span", {})), isLocked("keyStorage") ? lockedNote() : null),
      idleRow(),
      switchRow("signOutOnLock", "Sign out when this computer locks",
        "Every container signs out of every site when you lock the computer or it locks itself.")));
}

/** The device-identity headers kept out of container tabs (see rules.ts). */
function deviceSection(): HTMLElement {
  return h("section", {},
    h("h2", {}, "Device sign-in"),
    h("div", { class: "card" },
      switchRow("stripMicrosoftDeviceHeaders", "Keep Windows' Microsoft sign-in out of containers",
        "Stops Windows signing container tabs in with this computer's own work account. While this is on, sites that require a compliant device won't accept container tabs."),
      switchRow("stripDbscHeaders", "Keep device-bound sessions out of containers",
        "Stops Chrome tying a container's sign-in to this profile's own cookies. While this is on, container tabs don't get Chrome's protection against stolen session cookies.")));
}

/** Why a backup button is unavailable. */
function turnedOff(key: "allowBackupExport" | "allowBackupImport"): HTMLElement {
  return isLocked(key) ? lockedNote() : h("p", { class: "secondary" }, "Turned off.");
}

function backupSection(): HTMLElement {
  const result = h("p", { class: "secondary", role: "status" });
  const file = h("input", { type: "file", accept: "application/json,.json", class: "visually-hidden", tabindex: "-1",
    onchange: async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try {
        const backup = JSON.parse(await chosen.text()) as Backup;
        const r = await send<{ added: number; updated: number; sites: number }>({ type: "mac:import", backup });
        result.className = "secondary";
        result.textContent = `Imported: ${r.added} new, ${r.updated} updated, ${r.sites} site${r.sites === 1 ? "" : "s"}.`;
      } catch (e) {
        result.className = "error-text";
        result.textContent = `Couldn't import ${chosen.name}: ${(e as Error).message}`;
      } finally {
        file.value = "";
      }
    } });
  const exportBtn = h("button", { class: "btn", type: "button", disabled: !settings.values.allowBackupExport, onclick: async () => {
    const backup = await send<Backup>({ type: "mac:export" });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `containers-${backup.exportedAt.slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
    result.className = "secondary";
    result.textContent = `Exported ${backup.containers.length} container${backup.containers.length === 1 ? "" : "s"}.`;
  } }, icon("download"), "Export");
  return h("section", {},
    h("h2", {}, "Backup"),
    h("div", { class: "card" },
      row("Export containers and site assignments", "Saves a file you can import on another computer. It contains no sign-ins.", exportBtn,
        settings.values.allowBackupExport ? null : turnedOff("allowBackupExport")),
      row("Import from a file", result,
        h("button", { class: "btn", type: "button", disabled: !settings.values.allowBackupImport, onclick: () => file.click() }, icon("upload"), "Import"),
        settings.values.allowBackupImport ? null : turnedOff("allowBackupImport")),
      file));
}

async function shortcutsSection(): Promise<HTMLElement> {
  const commands = await chrome.commands.getAll();
  const set = commands.filter((c) => c.shortcut);
  const label = (c: chrome.commands.Command) =>
    c.name === "_execute_action" ? "Open this popup" : c.description || c.name || "";
  return h("section", {},
    h("h2", {}, "Keyboard shortcuts"),
    h("div", { class: "card" },
      ...(set.length
        ? set.map((c) => h("div", { class: "card-row" }, h("p", { class: "grow" }, label(c)), h("kbd", {}, c.shortcut!)))
        : [h("div", { class: "card-row" }, h("p", { class: "grow secondary" }, "No shortcuts are set."))]),
      h("button", { class: "card-row link-row", type: "button", onclick: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) },
        h("span", { class: "grow" }, "Change keyboard shortcuts"), icon("external"))));
}

function privacySection(): HTMLElement {
  return h("section", {},
    h("h2", {}, "Privacy"),
    h("div", { class: "card" },
      h("div", { class: "card-row note" }, icon("lock"), h("div", { class: "grow" },
        h("p", {}, "Container sign-ins are encrypted on this computer"),
        h("p", { class: "secondary" }, "Each container's cookies are stored encrypted with their own key, separate from Chrome's."))),
      h("div", { class: "card-row note" }, icon("signOut"), h("div", { class: "grow" },
        h("p", {}, `Unused containers sign out after ${duration(settings.values.idleTimeoutMinutes)}`),
        h("p", { class: "secondary" }, "Signing out empties the container's cookies and makes its site data unreachable. Its name, colour and sites stay.")))));
}

async function main(): Promise<void> {
  settings = await send<Resolved>({ type: "mac:settings" });
  app.replaceChildren(signInSection(), await syncSection(), deviceSection(), backupSection(), await shortcutsSection(), privacySection());
}

void main();
