// Persistent and per-session state for the service worker. The worker can be
// killed at any time, so everything lives in chrome.storage and is reloaded
// lazily; the in-memory copy is just a cache.

import type { Cookie } from "../shared/cookie.ts";
import { type Sealed, isSealed, newKey, seal, unseal } from "../shared/crypto.ts";

export type GroupColor = `${chrome.tabGroups.Color}`;

export interface Container {
  id: string;
  name: string;
  color: GroupColor;
  /** Prefix for the container's site storage; changes on a key reset. Defaults to id. */
  storageId?: string;
}

interface SessionState {
  /** tabId -> containerId */
  tabContainer: Record<string, string>;
  /** Tabs classified as default (no container). */
  defaultTabs: number[];
  /** groupId -> containerId, for groups known to belong to a container. */
  groupContainer?: Record<string, string>;
}

let containers: Container[] = [];
const jars = new Map<string, Cookie[]>();
/** containerId -> base64 AES key for its jar at rest. */
const keys = new Map<string, string>();
/** containerId -> epoch ms a tab in it was last used. */
let lastUsed: Record<string, number> = {};
let lastUsedSaved = 0;
/** Origins ever opened in a container; their service workers are kept out of normal tabs. */
let containerOrigins: string[] = [];
let session: SessionState = { tabContainer: {}, defaultTabs: [] };

const jarKey = (id: string) => `jar:${id}`;
const keyKey = (id: string) => `key:${id}`;
const newStorageId = () => crypto.randomUUID().slice(0, 8);

export const ready: Promise<void> = (async () => {
  const local = await chrome.storage.local.get(["containers", "lastUsed", "containerOrigins"]);
  containers = (local.containers as Container[] | undefined) ?? [];
  containerOrigins = (local.containerOrigins as string[] | undefined) ?? [];
  lastUsed = (local.lastUsed as Record<string, number> | undefined) ?? {};
  const stored = await chrome.storage.local.get(containers.flatMap((c) => [jarKey(c.id), keyKey(c.id)]));
  const now = Date.now();
  for (const c of containers) {
    // Containers from before use was tracked start their idle clock now.
    lastUsed[c.id] ??= now;
    let key = stored[keyKey(c.id)] as string | undefined;
    const raw = stored[jarKey(c.id)] as Sealed | Cookie[] | undefined;
    let jar: Cookie[] = [];
    if (Array.isArray(raw)) {
      jar = raw; // written before jars were encrypted; sealed below
    } else if (raw && isSealed(raw) && key) {
      jar = await unseal<Cookie[]>(key, raw).catch((e) => {
        console.error(`jar for ${c.name} unreadable; starting empty`, e);
        return [];
      });
    }
    if (!key) {
      key = newKey();
      await chrome.storage.local.set({ [keyKey(c.id)]: key });
    }
    keys.set(c.id, key);
    jars.set(c.id, jar);
    if (Array.isArray(raw)) void saveJar(c.id);
  }
  await chrome.storage.local.set({ lastUsed });
  const s = await chrome.storage.session.get("state");
  if (s.state) session = s.state as SessionState;
})();

const saving = new Map<string, Promise<void>>();

/**
 * Seals and writes a container's jar. Writes are chained per container and
 * each one seals the jar as it is when it runs, so the last write always wins.
 */
function saveJar(id: string): Promise<void> {
  const next = (saving.get(id) ?? Promise.resolve()).then(async () => {
    const key = keys.get(id);
    if (!key || !jars.has(id)) return;
    await chrome.storage.local.set({ [jarKey(id)]: await seal(key, jars.get(id)) });
  });
  saving.set(id, next.catch(() => {}));
  return next;
}

const saveSession = () => chrome.storage.session.set({ state: session });

export function listContainers(): Container[] {
  return containers;
}

export function getContainer(id: string): Container | undefined {
  return containers.find((c) => c.id === id);
}

export async function createContainer(name: string, color: GroupColor): Promise<Container> {
  // Tab groups are matched back to containers by name after a restart.
  if (containers.some((c) => c.name === name)) throw new Error(`A container named "${name}" already exists`);
  const container: Container = { id: crypto.randomUUID().slice(0, 8), name, color, storageId: newStorageId() };
  containers = [...containers, container];
  const key = newKey();
  keys.set(container.id, key);
  jars.set(container.id, []);
  lastUsed[container.id] = Date.now();
  await chrome.storage.local.set({ containers, [keyKey(container.id)]: key, lastUsed });
  await saveJar(container.id);
  return container;
}

export async function deleteContainer(id: string): Promise<number[]> {
  containers = containers.filter((c) => c.id !== id);
  jars.delete(id);
  keys.delete(id);
  delete lastUsed[id];
  const orphanTabs = tabsOf(id);
  for (const tabId of orphanTabs) delete session.tabContainer[tabId];
  await Promise.all([
    chrome.storage.local.set({ containers, lastUsed }),
    chrome.storage.local.remove([jarKey(id), keyKey(id)]),
    saveSession(),
  ]);
  return orphanTabs;
}

/** Renames or recolours a container. Names must stay unique. */
export async function updateContainer(id: string, changes: Partial<Pick<Container, "name" | "color">>): Promise<Container> {
  const current = getContainer(id);
  if (!current) throw new Error(`no container ${id}`);
  if (changes.name !== undefined && containers.some((c) => c.id !== id && c.name === changes.name)) {
    throw new Error(`A container named "${changes.name}" already exists`);
  }
  const updated = { ...current, ...changes };
  containers = containers.map((c) => (c.id === id ? updated : c));
  await chrome.storage.local.set({ containers });
  return updated;
}

/**
 * Full sign-out: a new key (the old jar becomes unreadable), an empty jar, and
 * a new storage prefix, so site storage written under the old one (where many
 * sites keep their login tokens) is no longer reachable. Name and colour stay.
 */
export async function resetContainer(id: string): Promise<void> {
  const current = getContainer(id);
  if (!current) return;
  containers = containers.map((c) => (c.id === id ? { ...c, storageId: newStorageId() } : c));
  const key = newKey();
  keys.set(id, key);
  jars.set(id, []);
  lastUsed[id] = Date.now();
  await chrome.storage.local.set({ containers, [keyKey(id)]: key, lastUsed });
  await saveJar(id);
}

/** Containers with no use for at least `maxIdleMs`. */
export function idleContainers(maxIdleMs: number, now = Date.now()): Container[] {
  return containers.filter((c) => now - lastUsedAt(c.id) >= maxIdleMs);
}

export function lastUsedAt(id: string): number {
  return lastUsed[id] ?? 0;
}

/** Records use of a container; persisted at most every few minutes. */
export async function markUsed(id: string, now = Date.now()): Promise<void> {
  lastUsed[id] = now;
  if (now - lastUsedSaved < 5 * 60_000) return;
  lastUsedSaved = now;
  await chrome.storage.local.set({ lastUsed });
}

export function listContainerOrigins(): string[] {
  return containerOrigins;
}

/** Returns true if the origin is new. */
export async function addContainerOrigin(origin: string): Promise<boolean> {
  if (containerOrigins.includes(origin)) return false;
  containerOrigins = [...containerOrigins, origin];
  await chrome.storage.local.set({ containerOrigins });
  return true;
}

export function getJar(id: string): Cookie[] {
  return jars.get(id) ?? [];
}

export async function setJar(id: string, jar: Cookie[]): Promise<void> {
  jars.set(id, jar);
  await saveJar(id);
}

/** Test hook: pretend a container was last used `ms` ago. */
export function backdateUse(id: string, ms: number): void {
  lastUsed[id] = Date.now() - ms;
}

/** Session cookies die with the browser session, as they would natively. */
export async function dropSessionCookies(): Promise<void> {
  for (const c of containers) {
    const jar = getJar(c.id);
    const kept = jar.filter((k) => k.expires !== null);
    if (kept.length !== jar.length) await setJar(c.id, kept);
  }
}

export function groupOwner(groupId: number): string | undefined {
  return session.groupContainer?.[groupId];
}

export function groupsOf(containerId: string): number[] {
  return Object.entries(session.groupContainer ?? {})
    .filter(([, cid]) => cid === containerId)
    .map(([groupId]) => Number(groupId));
}

export async function setGroupOwner(groupId: number, containerId: string | null): Promise<void> {
  session.groupContainer ??= {};
  if (containerId) session.groupContainer[groupId] = containerId;
  else delete session.groupContainer[groupId];
  await saveSession();
}

export function containerOfTab(tabId: number): string | undefined {
  return session.tabContainer[tabId];
}

export function tabsOf(containerId: string): number[] {
  return Object.entries(session.tabContainer)
    .filter(([, cid]) => cid === containerId)
    .map(([tabId]) => Number(tabId));
}

export function isKnownTab(tabId: number): boolean {
  return tabId in session.tabContainer || session.defaultTabs.includes(tabId);
}

export function knownTabIds(): number[] {
  return [...Object.keys(session.tabContainer).map(Number), ...session.defaultTabs];
}

export async function classifyTab(tabId: number, containerId: string | null): Promise<void> {
  session.defaultTabs = session.defaultTabs.filter((t) => t !== tabId);
  delete session.tabContainer[tabId];
  if (containerId) session.tabContainer[tabId] = containerId;
  else session.defaultTabs.push(tabId);
  await saveSession();
}

export async function forgetTab(tabId: number): Promise<void> {
  session.defaultTabs = session.defaultTabs.filter((t) => t !== tabId);
  delete session.tabContainer[tabId];
  await saveSession();
}

/**
 * Drops tabs that no longer exist and classifies ones we never saw, returning
 * the newly classified tab ids.
 */
export async function reconcileTabs(
  openTabs: chrome.tabs.Tab[],
  containerFor: (tab: chrome.tabs.Tab) => string | null,
): Promise<number[]> {
  const open = new Set(openTabs.map((t) => t.id!));
  for (const tabId of knownTabIds()) if (!open.has(tabId)) await forgetTab(tabId);
  const added: number[] = [];
  for (const t of openTabs) {
    if (isKnownTab(t.id!)) continue;
    const containerId = containerFor(t);
    if (containerId) session.tabContainer[t.id!] = containerId;
    else session.defaultTabs.push(t.id!);
    added.push(t.id!);
  }
  await saveSession();
  return added;
}
