// Syncs container definitions and site assignments through the user's Chrome
// account (chrome.storage.sync). Cookies, keys and site storage never sync.
//
// One sync item per container ("c:<id>": name, colour, emoji, order and its
// assignments) keeps each under Chrome's 8 KB per-item limit; "meta" carries
// deletion times so a container deleted on one computer goes everywhere.
// Each container carries updatedAt; the newer side wins, per container.

import type { SyncStatus } from "../shared/messages.ts";
import * as settings from "./settings.ts";
import * as state from "./state.ts";

interface SyncedContainer {
  id: string;
  name: string;
  color: state.GroupColor;
  emoji?: string;
  order: number;
  updatedAt: number;
  assignments: Record<string, { ask: boolean; allowElsewhere?: boolean }>;
}

interface SyncMeta {
  deleted: Record<string, number>;
}

const PREFIX = "c:";
const META = "meta";
/** Tombstones older than this are dropped; a computer offline longer re-adds the container. */
const TOMBSTONE_MS = 90 * 24 * 60 * 60_000;

export const syncStatus: SyncStatus = { enabled: false, lastPush: 0, lastPull: 0, error: "" };

export interface SyncHooks {
  /** Delete a container here because it was deleted elsewhere (closes its tabs). */
  deleteContainer(id: string, deletedAt: number): Promise<void>;
  /** A container's name, colour or emoji changed elsewhere: retitle its groups here. */
  refreshGroups(id: string): Promise<void>;
}

let hooks: SyncHooks;
let applying = false;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function localItems(): Record<string, SyncedContainer> {
  const out: Record<string, SyncedContainer> = {};
  state.listContainers().forEach((c, order) => {
    const assignments = Object.fromEntries(
      Object.entries(state.assignmentsOf(c.id)).map(([host, a]) => [host, { ask: a.ask, ...(a.allowElsewhere && { allowElsewhere: true }) }]),
    );
    out[PREFIX + c.id] = {
      id: c.id, name: c.name, color: c.color, order, updatedAt: c.updatedAt ?? 0, assignments,
      ...(c.emoji && { emoji: c.emoji }),
    };
  });
  return out;
}

export async function push(): Promise<void> {
  if (!syncStatus.enabled) return;
  try {
    const remote = await chrome.storage.sync.get(null);
    const items = localItems();
    const changed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(items)) {
      const theirs = remote[key] as SyncedContainer | undefined;
      // Never overwrite a newer remote copy; pull will take it instead.
      if (theirs && theirs.updatedAt > item.updatedAt) continue;
      if (JSON.stringify(theirs) !== JSON.stringify(item)) changed[key] = item;
    }
    const now = Date.now();
    const deleted = Object.fromEntries(
      Object.entries({ ...((remote[META] as SyncMeta | undefined)?.deleted ?? {}), ...state.deletedContainerTimes() })
        .filter(([, at]) => now - at < TOMBSTONE_MS),
    );
    if (JSON.stringify((remote[META] as SyncMeta | undefined)?.deleted ?? {}) !== JSON.stringify(deleted)) {
      changed[META] = { deleted } satisfies SyncMeta;
    }
    const gone = Object.keys(remote).filter((k) => k.startsWith(PREFIX) && !(k in items) && deleted[k.slice(PREFIX.length)]);
    if (Object.keys(changed).length) await chrome.storage.sync.set(changed);
    if (gone.length) await chrome.storage.sync.remove(gone);
    syncStatus.lastPush = now;
    syncStatus.error = "";
  } catch (e) {
    syncStatus.error = String(e instanceof Error ? e.message : e);
  }
}

export async function pull(): Promise<void> {
  if (!syncStatus.enabled) return;
  applying = true;
  try {
    const remote = await chrome.storage.sync.get(null);
    const deleted = (remote[META] as SyncMeta | undefined)?.deleted ?? {};
    for (const [id, at] of Object.entries(deleted)) {
      const local = state.getContainer(id);
      if (local && (local.updatedAt ?? 0) <= at) await hooks.deleteContainer(id, at);
    }
    const items = Object.entries(remote)
      .filter(([k]) => k.startsWith(PREFIX))
      .map(([, v]) => v as SyncedContainer);
    let reorder = false;
    for (const item of items) {
      if ((state.deletedContainerTimes()[item.id] ?? 0) >= item.updatedAt) continue;
      const local = state.getContainer(item.id);
      try {
        if (!local) {
          // A different local container may already use the name.
          const taken = state.listContainers().some((c) => c.name === item.name);
          await state.createContainer(taken ? `${item.name} (synced)` : item.name, item.color, item.emoji, item.id, item.updatedAt);
          await state.replaceAssignmentsOf(item.id, item.assignments);
          reorder = true;
        } else if (item.updatedAt > (local.updatedAt ?? 0)) {
          await state.updateContainer(item.id, { name: item.name, color: item.color, emoji: item.emoji ?? "" }, item.updatedAt);
          await state.replaceAssignmentsOf(item.id, item.assignments);
          await hooks.refreshGroups(item.id);
          reorder = true;
        }
      } catch (e) {
        syncStatus.error = `"${item.name}": ${e instanceof Error ? e.message : e}`;
      }
    }
    if (reorder) {
      const rank = new Map(items.map((i) => [i.id, i.order]));
      await state.applyOrder([...state.listContainers()].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)).map((c) => c.id));
    }
    syncStatus.lastPull = Date.now();
  } catch (e) {
    syncStatus.error = String(e instanceof Error ? e.message : e);
  } finally {
    applying = false;
  }
}

function schedulePush(): void {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push(), 1000);
}

export async function installSync(h: SyncHooks): Promise<void> {
  hooks = h;
  await settings.ready;
  syncStatus.enabled = settings.get().syncEnabled;
  // The switch on the options page, or a policy, turns sync on or off.
  settings.onSettingsChange(async (next, prev) => {
    if (next.syncEnabled === prev.syncEnabled) return;
    syncStatus.enabled = next.syncEnabled;
    if (next.syncEnabled) {
      await pull();
      await push();
    }
  });
  state.onChange(() => {
    if (!applying) schedulePush();
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync" && !applying) void pull();
  });
  await pull();
  await push();
}
