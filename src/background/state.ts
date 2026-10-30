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
  /** Shown in the popup and menus, and in front of the tab group's name. */
  emoji?: string;
  /** Prefix for the container's site storage; changes on a key reset. Defaults to id. */
  storageId?: string;
  /** Last change to anything that syncs (name, colour, emoji, order, its site assignments). */
  updatedAt?: number;
}

/** "Always open this host in a container." Hosts are exact. */
export interface Assignment {
  containerId: string;
  /** false: switch without asking ("remember my choice" + open). */
  ask: boolean;
  /** true: never prompt for this host ("remember my choice" + stay). */
  allowElsewhere?: boolean;
}

/** The tab group title for a container: its emoji, if any, then its name. */
export function groupTitle(c: Pick<Container, "name" | "emoji">): string {
  return c.emoji ? `${c.emoji} ${c.name}` : c.name;
}

/** Splits a tab group title back into emoji and name (inverse of groupTitle). */
export function parseGroupTitle(title: string): { emoji?: string; name: string } {
  const trimmed = title.trim();
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  if (first && /\p{Extended_Pictographic}/u.test(first.segment)) {
    const name = trimmed.slice(first.segment.length).trim();
    if (name) return { emoji: first.segment, name };
  }
  return { name: trimmed };
}

const listeners: (() => void)[] = [];

/** Called after any change to containers or site assignments (menus, sync). */
export function onChange(fn: () => void): void {
  listeners.push(fn);
}

function changed(): void {
  for (const fn of listeners) fn();
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
/**
 * containerId -> origins it opened as pages. Together with the container's
 * cookie domains, these are the sites kept free of service workers in normal
 * tabs; they're forgotten when the container is deleted or reset.
 */
let containerOrigins: Record<string, string[]> = {};
let assignments: Record<string, Assignment> = {};
/** containerId -> when it was deleted, so sync can delete it elsewhere too. */
let deletedContainers: Record<string, number> = {};
let session: SessionState = { tabContainer: {}, defaultTabs: [] };

const jarKey = (id: string) => `jar:${id}`;
const keyKey = (id: string) => `key:${id}`;
const newStorageId = () => crypto.randomUUID().slice(0, 8);

export const ready: Promise<void> = (async () => {
  const local = await chrome.storage.local.get(["containers", "lastUsed", "containerOrigins", "assignments", "deletedContainers"]);
  containers = (local.containers as Container[] | undefined) ?? [];
  assignments = (local.assignments as Record<string, Assignment> | undefined) ?? {};
  deletedContainers = (local.deletedContainers as Record<string, number> | undefined) ?? {};
  // Before per-container tracking this was one ever-growing list; start over.
  const storedOrigins = local.containerOrigins;
  containerOrigins = storedOrigins && !Array.isArray(storedOrigins) ? (storedOrigins as Record<string, string[]>) : {};
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

export async function createContainer(
  name: string,
  color: GroupColor,
  emoji?: string,
  id: string = crypto.randomUUID().slice(0, 8),
  updatedAt = Date.now(),
): Promise<Container> {
  name = name.trim();
  if (!name) throw new Error("Give the container a name");
  // Tab groups are matched back to containers by name after a restart.
  if (containers.some((c) => c.name === name)) throw new Error(`A container named "${name}" already exists`);
  const container: Container = { id, name, color, storageId: newStorageId(), updatedAt, ...(emoji && { emoji }) };
  containers = [...containers, container];
  const key = newKey();
  keys.set(container.id, key);
  jars.set(container.id, []);
  lastUsed[container.id] = Date.now();
  delete deletedContainers[container.id];
  await chrome.storage.local.set({ containers, [keyKey(container.id)]: key, lastUsed, deletedContainers });
  await saveJar(container.id);
  changed();
  return container;
}

export async function deleteContainer(id: string, deletedAt = Date.now()): Promise<number[]> {
  if (!getContainer(id)) return [];
  containers = containers.filter((c) => c.id !== id);
  for (const [host, a] of Object.entries(assignments)) if (a.containerId === id) delete assignments[host];
  deletedContainers[id] = deletedAt;
  jars.delete(id);
  keys.delete(id);
  delete lastUsed[id];
  await forgetContainerOrigins(id);
  const orphanTabs = tabsOf(id);
  for (const tabId of orphanTabs) delete session.tabContainer[tabId];
  await Promise.all([
    chrome.storage.local.set({ containers, lastUsed, assignments, deletedContainers }),
    chrome.storage.local.remove([jarKey(id), keyKey(id)]),
    saveSession(),
  ]);
  changed();
  return orphanTabs;
}

export function deletedContainerTimes(): Record<string, number> {
  return deletedContainers;
}

/** Puts containers in this order (ids not listed keep their place at the end). */
export async function reorderContainers(ids: string[]): Promise<void> {
  const rank = (c: Container) => (ids.includes(c.id) ? ids.indexOf(c.id) : ids.length);
  const now = Date.now();
  const next = [...containers].sort((a, b) => rank(a) - rank(b));
  containers = next.map((c, i) => (containers[i]?.id === c.id ? c : { ...c, updatedAt: now }));
  await chrome.storage.local.set({ containers });
  changed();
}

/** Applies an order that came from elsewhere (sync) without marking anything changed. */
export async function applyOrder(ids: string[]): Promise<void> {
  const rank = (c: Container) => (ids.includes(c.id) ? ids.indexOf(c.id) : ids.length);
  const next = [...containers].sort((a, b) => rank(a) - rank(b));
  if (next.every((c, i) => c === containers[i])) return;
  containers = next;
  await chrome.storage.local.set({ containers });
  changed();
}

// --- Site assignments ----------------------------------------------------------

export function getAssignment(host: string): Assignment | undefined {
  return assignments[host.toLowerCase()];
}

export function listAssignments(): Record<string, Assignment> {
  return assignments;
}

export function assignmentsOf(containerId: string): Record<string, Assignment> {
  return Object.fromEntries(Object.entries(assignments).filter(([, a]) => a.containerId === containerId));
}

async function touch(containerIds: string[]): Promise<void> {
  const now = Date.now();
  containers = containers.map((c) => (containerIds.includes(c.id) ? { ...c, updatedAt: now } : c));
  await chrome.storage.local.set({ containers, assignments });
  changed();
}

export async function setAssignment(host: string, assignment: Assignment | null): Promise<void> {
  host = host.toLowerCase();
  const before = assignments[host]?.containerId;
  if (assignment) {
    if (!getContainer(assignment.containerId)) throw new Error(`no container ${assignment.containerId}`);
    assignments[host] = assignment;
  } else {
    delete assignments[host];
  }
  await touch([before, assignment?.containerId].filter((id): id is string => !!id));
}

/** Replaces one container's assignments wholesale (sync, import). */
export async function replaceAssignmentsOf(containerId: string, next: Record<string, Omit<Assignment, "containerId">>): Promise<void> {
  for (const [host, a] of Object.entries(assignments)) if (a.containerId === containerId) delete assignments[host];
  for (const [host, a] of Object.entries(next)) assignments[host.toLowerCase()] = { ...a, containerId };
  await chrome.storage.local.set({ assignments });
  changed();
}

/** Renames, recolours or re-emojis a container. Names must stay unique. */
export async function updateContainer(
  id: string,
  changes: Partial<Pick<Container, "name" | "color" | "emoji">>,
  updatedAt = Date.now(),
): Promise<Container> {
  const current = getContainer(id);
  if (!current) throw new Error(`no container ${id}`);
  if (changes.name !== undefined) {
    changes = { ...changes, name: changes.name.trim() };
    if (!changes.name) throw new Error("Give the container a name");
    if (containers.some((c) => c.id !== id && c.name === changes.name)) {
      throw new Error(`A container named "${changes.name}" already exists`);
    }
  }
  const updated: Container = { ...current, ...changes, updatedAt };
  if (!updated.emoji) delete updated.emoji;
  containers = containers.map((c) => (c.id === id ? updated : c));
  await chrome.storage.local.set({ containers });
  changed();
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
  await forgetContainerOrigins(id);
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

/** Every origin some existing container opened as a page. */
export function listContainerOrigins(): string[] {
  return [...new Set(Object.values(containerOrigins).flat())];
}

/** Records that a container opened an origin; true if no container had before. */
export async function addContainerOrigin(containerId: string, origin: string): Promise<boolean> {
  const mine = containerOrigins[containerId] ?? [];
  if (mine.includes(origin)) return false;
  const isNew = !listContainerOrigins().includes(origin);
  containerOrigins = { ...containerOrigins, [containerId]: [...mine, origin] };
  await chrome.storage.local.set({ containerOrigins });
  return isNew;
}

async function forgetContainerOrigins(containerId: string): Promise<void> {
  if (!(containerId in containerOrigins)) return;
  const { [containerId]: _, ...rest } = containerOrigins;
  containerOrigins = rest;
  await chrome.storage.local.set({ containerOrigins });
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
