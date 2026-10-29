// Persistent and per-session state for the service worker. The worker can be
// killed at any time, so everything lives in chrome.storage and is reloaded
// lazily; the in-memory copy is just a cache.

import type { Cookie } from "../shared/cookie.ts";

export type GroupColor = `${chrome.tabGroups.Color}`;

export interface Container {
  id: string;
  name: string;
  color: GroupColor;
}

interface SessionState {
  /** tabId -> containerId */
  tabContainer: Record<string, string>;
  /** Tabs classified as default (no container). */
  defaultTabs: number[];
}

let containers: Container[] = [];
const jars = new Map<string, Cookie[]>();
let session: SessionState = { tabContainer: {}, defaultTabs: [] };

const jarKey = (id: string) => `jar:${id}`;

export const ready: Promise<void> = (async () => {
  const local = await chrome.storage.local.get("containers");
  containers = (local.containers as Container[] | undefined) ?? [];
  const jarData = await chrome.storage.local.get(containers.map((c) => jarKey(c.id)));
  for (const c of containers) jars.set(c.id, (jarData[jarKey(c.id)] as Cookie[] | undefined) ?? []);
  const s = await chrome.storage.session.get("state");
  if (s.state) session = s.state as SessionState;
})();

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
  const container = { id: crypto.randomUUID().slice(0, 8), name, color };
  containers = [...containers, container];
  jars.set(container.id, []);
  await chrome.storage.local.set({ containers, [jarKey(container.id)]: [] });
  return container;
}

export async function deleteContainer(id: string): Promise<number[]> {
  containers = containers.filter((c) => c.id !== id);
  jars.delete(id);
  const orphanTabs = tabsOf(id);
  for (const tabId of orphanTabs) delete session.tabContainer[tabId];
  await Promise.all([chrome.storage.local.set({ containers }), chrome.storage.local.remove(jarKey(id)), saveSession()]);
  return orphanTabs;
}

export function getJar(id: string): Cookie[] {
  return jars.get(id) ?? [];
}

export async function setJar(id: string, jar: Cookie[]): Promise<void> {
  jars.set(id, jar);
  await chrome.storage.local.set({ [jarKey(id)]: jar });
}

/** Session cookies die with the browser session, as they would natively. */
export async function dropSessionCookies(): Promise<void> {
  for (const c of containers) {
    const jar = getJar(c.id);
    const kept = jar.filter((k) => k.expires !== null);
    if (kept.length !== jar.length) await setJar(c.id, kept);
  }
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
