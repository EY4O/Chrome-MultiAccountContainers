// Service worker: the container engine. It owns the per-container cookie jars,
// keeps DNR session rules in step with jars and tab assignments, and answers
// the content scripts and the popup.

import {
  type Cookie,
  type SiteContext,
  applyCookie,
  cookiesForUrl,
  parseSetCookie,
  siteOf,
} from "../shared/cookie.ts";
import type { BgMessage, SnapshotReply } from "../shared/messages.ts";
import { LOCKDOWN_RULE, buildRules, ruleUsage } from "./rules.ts";
import * as state from "./state.ts";

export const stats = {
  syncs: 0,
  lastSyncMs: 0,
  ruleCount: 0,
  regexRuleCount: 0,
  setCookieSeen: 0,
  setCookieIgnored: 0,
  renavigations: 0,
  staleNavigations: 0,
  restoredIntoContainers: 0,
  lockdown: false,
  /** Containers whose cookie rules didn't fit Chrome's limits (their tabs send no cookies). */
  overBudget: [] as string[],
  lastError: "",
};

// --- Rule sync -------------------------------------------------------------

let syncing: Promise<void> | null = null;
let dirty = false;
let consecutiveFailures = 0;

async function setLockdown(on: boolean): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [LOCKDOWN_RULE.id],
    addRules: on ? [LOCKDOWN_RULE] : [],
  });
  stats.lockdown = on;
}

/** Coalesces bursts of changes into as few updateSessionRules calls as possible. */
function scheduleSync(): Promise<void> {
  dirty = true;
  syncing ??= (async () => {
    while (dirty) {
      dirty = false;
      await syncRules();
    }
    syncing = null;
  })();
  return syncing;
}

/** Resolves once in-flight Set-Cookie captures are in the jar and the rules match it. */
async function barrier(): Promise<void> {
  await Promise.all(captures);
  await (syncing ?? Promise.resolve());
}

// Chrome's session-rule limits. Overridable so tests can reach them.
const limits = {
  total: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES ?? 5000,
  regex: chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES ?? 1000,
};

const fits = (rules: chrome.declarativeNetRequest.Rule[]) => {
  const usage = ruleUsage(rules);
  return usage.total <= limits.total && usage.regex <= limits.regex;
};

/** Rule inputs for every container, optionally with one more tab assigned. */
function ruleInputs(extra?: { tabId: number; containerId: string }) {
  return state.listContainers().map((c) => ({
    id: c.id,
    storageId: c.storageId,
    tabIds: [...state.tabsOf(c.id), ...(extra?.containerId === c.id ? [extra.tabId] : [])],
    cookies: state.getJar(c.id),
  }));
}

/** Whether adding a tab to this container keeps the rules within Chrome's limits. */
function roomFor(containerId: string): boolean {
  if (state.tabsOf(containerId).length) return true; // already has rules
  return fits(buildRules({
    containers: ruleInputs({ tabId: 0, containerId }),
    knownTabIds: state.knownTabIds(),
    noServiceWorkerHosts: serviceWorkerHosts(),
  }));
}

/**
 * Builds the rules; if they don't fit, the least recently used containers lose
 * their cookie rules (their tabs then send no cookies: signed out, not leaked).
 */
function buildWithinBudget(): chrome.declarativeNetRequest.Rule[] {
  const inputs = ruleInputs();
  const knownTabIds = state.knownTabIds();
  const noServiceWorkerHosts = serviceWorkerHosts();
  let rules = buildRules({ containers: inputs, knownTabIds, noServiceWorkerHosts });
  const dropped: string[] = [];
  const byAge = inputs.filter((c) => c.tabIds.length).sort((a, b) => state.lastUsedAt(a.id) - state.lastUsedAt(b.id));
  while (!fits(rules) && byAge.length) {
    const victim = byAge.shift()!;
    victim.cookies = [];
    dropped.push(state.getContainer(victim.id)?.name ?? victim.id);
    rules = buildRules({ containers: inputs, knownTabIds, noServiceWorkerHosts });
  }
  if (dropped.join() !== stats.overBudget.join()) {
    stats.overBudget = dropped;
    void chrome.action.setBadgeText({ text: dropped.length ? "!" : "" });
    void chrome.action.setTitle({
      title: dropped.length
        ? `Too many open containers for Chrome's rule limit; signed out until you close some: ${dropped.join(", ")}`
        : "Containers",
    });
  }
  return rules;
}

async function syncRules(): Promise<void> {
  const t0 = performance.now();
  const rules = buildWithinBudget();
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: rules,
    });
    stats.lastError = "";
    consecutiveFailures = 0;
    // Installed only once the allow rule exists, so a fresh install never
    // blocks tabs that were open before it. Persists across restarts.
    if (!stats.lockdown) await setLockdown(true).catch((e) => console.error("lockdown failed", e));
  } catch (e) {
    stats.lastError = String(e);
    console.error("rule sync failed", e, rules);
    // Retry once; after that fail open rather than leave every tab blocked.
    if (++consecutiveFailures === 1) dirty = true;
    else if (stats.lockdown) await setLockdown(false).catch(() => {});
  }
  stats.syncs++;
  stats.ruleCount = rules.length;
  stats.regexRuleCount = rules.filter((r) => r.condition.regexFilter).length;
  stats.lastSyncMs = Math.round(performance.now() - t0);
}

// --- Jar changes -------------------------------------------------------------

const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function commitJar(containerId: string, jar: Cookie[]): Promise<void> {
  const saved = state.setJar(containerId, jar);
  void scheduleSync();
  clearTimeout(notifyTimers.get(containerId));
  notifyTimers.set(containerId, setTimeout(() => {
    for (const tabId of state.tabsOf(containerId)) {
      chrome.tabs.sendMessage(tabId, { type: "mac:jar-changed" }).catch(() => {});
    }
  }, 30));
  await saved;
}

const captures = new Set<Promise<void>>();

/** Navigations sent with stale cookies: whatever their responses set is discarded. */
const staleRequests = new Set<string>();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const p = captureSetCookie(details).finally(() => captures.delete(p));
    captures.add(p);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

async function captureSetCookie(details: chrome.webRequest.OnHeadersReceivedDetails): Promise<void> {
  if (details.tabId < 0) return;
  await state.ready;
  const containerId = state.containerOfTab(details.tabId);
  if (!containerId) return;
  const headers = (details.responseHeaders ?? [])
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .flatMap((h) => (h.value ?? "").split("\n"));
  if (!headers.length) return;
  stats.setCookieSeen += headers.length;
  if (staleRequests.has(details.requestId)) {
    stats.setCookieIgnored += headers.length;
    return;
  }

  const url = new URL(details.url);
  let jar = state.getJar(containerId);
  let changed = false;
  for (const header of headers) {
    const cookie = parseSetCookie(header, url);
    const next = cookie && applyCookie(jar, cookie);
    if (next) {
      jar = next;
      changed = true;
    }
  }
  if (changed) await commitJar(containerId, jar);
}

// The rules lag the jar by one updateSessionRules call, so a request sent right
// after a Set-Cookie (classically: login POST -> 302 + Set-Cookie -> GET /home)
// can leave without the new cookie. For top-level GET navigations we notice,
// discard whatever cookies the stale response tries to set (often a fresh
// anonymous session that would clobber the login), and replay the navigation.
chrome.webRequest.onSendHeaders.addListener(
  (details) => void checkStaleNavigation(details),
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["requestHeaders", "extraHeaders"],
);

const replayedAt = new Map<string, number>();

async function checkStaleNavigation(details: chrome.webRequest.OnSendHeadersDetails): Promise<void> {
  if (details.tabId < 0 || details.method !== "GET") return;
  await Promise.all(captures);
  const containerId = state.containerOfTab(details.tabId);
  if (!containerId) return;
  void state.markUsed(containerId);
  const url = new URL(details.url);
  const sameSite = !details.initiator || siteOf(new URL(details.initiator).hostname) === siteOf(url.hostname);
  const expected = cookiesForUrl(state.getJar(containerId), url, sameSite ? "same-site" : "cross-site-navigation");
  const sentHeader = details.requestHeaders?.find((h) => h.name.toLowerCase() === "cookie")?.value ?? "";
  const sent = new Set(sentHeader.split(/;\s*/));
  const stale = expected.some((c) => !sent.has(c.name ? `${c.name}=${c.value}` : c.value));
  if (!stale) return;

  const key = `${details.tabId} ${details.url}`;
  if (Date.now() - (replayedAt.get(key) ?? 0) < 5000) return; // never loop
  replayedAt.set(key, Date.now());
  stats.staleNavigations++;
  staleRequests.add(details.requestId);
  setTimeout(() => staleRequests.delete(details.requestId), 60_000);
  await barrier();
  chrome.tabs.update(details.tabId, { url: details.url }).catch(() => {});
}

// --- Tabs ----------------------------------------------------------------------

/** Recent tab-lifecycle events, for diagnosing assignments (mac.events()). */
const events: Record<string, unknown>[] = [];
function logEvent(ev: string, data: Record<string, unknown>): void {
  events.push({ t: new Date().toISOString().slice(11, 23), ev, ...data });
  if (events.length > 300) events.shift();
}

const classifiedAt = new Map<number, number>();
const classifying = new Map<number, Promise<void>>();
const blockedNav = new Map<number, string>();
const renavigated = new Set<number>();

/** Assigns a tab and resolves once the rules know about it. */
function classify(tabId: number, containerId: string | null): Promise<void> {
  logEvent("classify", { tabId, containerId, was: state.containerOfTab(tabId) ?? (state.isKnownTab(tabId) ? "default" : "unknown") });
  const done = (async () => {
    await state.classifyTab(tabId, containerId);
    classifiedAt.set(tabId, Date.now());
    await scheduleSync();
    const url = blockedNav.get(tabId);
    if (url) {
      blockedNav.delete(tabId);
      renavigate(tabId, url);
    }
  })();
  classifying.set(tabId, done);
  void done.finally(() => {
    if (classifying.get(tabId) === done) classifying.delete(tabId);
  });
  return done;
}

function renavigate(tabId: number, url: string): void {
  if (renavigated.has(tabId)) return;
  renavigated.add(tabId);
  stats.renavigations++;
  logEvent("replay", { tabId, url: url.slice(0, 80) });
  chrome.tabs.update(tabId, { url }).catch(() => {});
}

chrome.tabs.onCreated.addListener((tab) => void onTabCreated(tab));

// Chrome sets openerTabId on lots of tabs that a page did not open (tabs made
// by extensions or DevTools, for instance), so a container is only inherited
// when webNavigation confirms the page opened the tab. Until then the tab
// stays unclassified, which keeps it quarantined.
const awaitingNavTarget = new Map<number, ReturnType<typeof setTimeout>>();

async function onTabCreated(tab: chrome.tabs.Tab): Promise<void> {
  await startup;
  if (tab.id === undefined || state.isKnownTab(tab.id)) return;
  const tabId = tab.id;
  // A tab Chrome creates inside a container's group (e.g. "New tab to the
  // right") belongs to that container, as it would after a restart.
  const groupContainer = await containerOfGroup(tab.groupId);
  if (state.isKnownTab(tabId)) return;
  if (groupContainer) return classify(tabId, groupContainer);
  const openerContainer = tab.openerTabId === undefined ? undefined : state.containerOfTab(tab.openerTabId);
  if (!openerContainer) return classify(tabId, null);
  awaitingNavTarget.set(tabId, setTimeout(() => {
    awaitingNavTarget.delete(tabId);
    if (!state.isKnownTab(tabId)) void classify(tabId, null);
  }, 500));
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => void (async () => {
  await startup;
  clearTimeout(awaitingNavTarget.get(details.tabId));
  awaitingNavTarget.delete(details.tabId);
  if (state.isKnownTab(details.tabId)) return;
  const containerId = state.containerOfTab(details.sourceTabId) ?? null;
  await classify(details.tabId, containerId);
  if (containerId) void groupTab(details.tabId, containerId);
})());

// A tab created by a container tab may start loading before we classify it;
// the quarantine rule blocks that load and we replay it here.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => void onRequestError(details),
  { urls: ["<all_urls>"], types: ["main_frame"] },
);

async function onRequestError(details: chrome.webRequest.OnErrorOccurredDetails): Promise<void> {
  if (details.tabId < 0 || details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
  await startup;
  const inProgress = classifying.get(details.tabId);
  if (inProgress) {
    await inProgress;
    renavigate(details.tabId, details.url);
  } else if (!state.isKnownTab(details.tabId)) {
    blockedNav.set(details.tabId, details.url);
  } else if (Date.now() - (classifiedAt.get(details.tabId) ?? 0) < 3000) {
    renavigate(details.tabId, details.url);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => void (async () => {
  await startup;
  const containerId = state.containerOfTab(tabId);
  if (containerId) await state.markUsed(containerId);
})());

chrome.tabs.onRemoved.addListener((tabId) => void (async () => {
  await startup;
  logEvent("removed", { tabId, containerId: state.containerOfTab(tabId) ?? null });
  classifiedAt.delete(tabId);
  renavigated.delete(tabId);
  await state.forgetTab(tabId);
  await scheduleSync();
})());

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void (async () => {
  await startup;
  logEvent("replaced", { addedTabId, removedTabId, removedContainer: state.containerOfTab(removedTabId) ?? null,
    addedContainer: state.containerOfTab(addedTabId) ?? null, removedKnown: state.isKnownTab(removedTabId) });
  const removedKnown = state.isKnownTab(removedTabId);
  const containerId = state.containerOfTab(removedTabId) ?? null;
  await state.forgetTab(removedTabId);
  if (removedKnown) {
    await classify(addedTabId, containerId);
  } else if (!state.isKnownTab(addedTabId)) {
    // Session restore swaps tabs before the worker is running; the old id
    // never meant anything to us, so go by the replacement's group.
    const tab = await chrome.tabs.get(addedTabId).catch(() => null);
    await classify(addedTabId, await containerOfGroup(tab?.groupId));
  }
  // Otherwise startup already assigned the replacement; an unknown old id must
  // not overwrite that. A load blocked under the old id has to be replayed on
  // the new one.
  await replayIfBlocked(addedTabId);
})());

/** Replays a tab's load if it ended on an error page (e.g. blocked by the lockdown). */
async function replayIfBlocked(tabId: number): Promise<void> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const top = frames?.find((f) => f.frameId === 0);
  if (top?.errorOccurred && /^https?:/.test(top.url)) renavigate(tabId, top.url);
}

/** Container whose name and colour match the tab group, if any. */
async function containerOfGroup(groupId: number | undefined): Promise<string | null> {
  if (groupId === undefined || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return null;
  const owner = state.groupOwner(groupId);
  if (owner && state.getContainer(owner)) return owner;
  try {
    const group = await chrome.tabGroups.get(groupId);
    const match = state.listContainers().find((c) => c.name === group.title && c.color === group.color);
    if (!match) return null;
    await state.setGroupOwner(groupId, match.id);
    return match.id;
  } catch {
    return null;
  }
}

/** Tabs the worker is moving into a group, and groups it is still naming. */
const grouping = new Map<number, Promise<void>>();
const namingGroups = new Set<number>();

function groupTab(tabId: number, containerId: string): Promise<void> {
  const done = groupTabNow(tabId, containerId);
  grouping.set(tabId, done);
  void done.finally(() => {
    if (grouping.get(tabId) === done) grouping.delete(tabId);
  });
  return done;
}

async function groupTabNow(tabId: number, containerId: string): Promise<void> {
  const container = state.getContainer(containerId);
  if (!container) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    let groupId: number | undefined;
    for (const owned of state.groupsOf(containerId)) {
      const group = await chrome.tabGroups.get(owned).catch(() => null);
      if (group?.windowId === tab.windowId) groupId = owned;
    }
    groupId ??= (await chrome.tabGroups.query({ windowId: tab.windowId, title: container.name }))
      .find((g) => g.color === container.color)?.id;
    if (groupId !== undefined) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
      await state.setGroupOwner(groupId, containerId);
      return;
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    namingGroups.add(groupId);
    try {
      await state.setGroupOwner(groupId, containerId);
      await chrome.tabGroups.update(groupId, { title: container.name, color: container.color as chrome.tabGroups.Color });
    } finally {
      namingGroups.delete(groupId);
    }
  } catch (e) {
    console.warn("grouping failed", e);
  }
}

// --- Live group sync ---------------------------------------------------------
// A tab's group is its container: dragging a tab into a container's group
// moves it into that container, dragging it out makes it a normal tab, and
// either way it reloads under the new identity.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId !== undefined) void onTabGroupChanged(tabId);
});

async function onTabGroupChanged(tabId: number): Promise<void> {
  await startup;
  await grouping.get(tabId);
  await classifying.get(tabId);
  if (!state.isKnownTab(tabId)) return; // still being created; onTabCreated decides
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const target = await containerOfGroup(tab.groupId);
  const current = state.containerOfTab(tabId) ?? null;
  if (target === current) return;
  if (target && !roomFor(target)) {
    logEvent("group-move-refused", { tabId, to: target });
    void chrome.action.setBadgeText({ text: "!" });
    void chrome.action.setTitle({ title: "Chrome's rule limit is full, so that tab stayed where it was. Close a container's tabs first." });
    if (current) await groupTab(tabId, current);
    else await chrome.tabs.ungroup(tabId).catch(() => {});
    return;
  }
  logEvent("group-move", { tabId, from: current, to: target });
  await classify(tabId, target);
  if (/^https?:/.test(tab.url ?? "")) await chrome.tabs.reload(tabId).catch(() => {});
}

// Renaming or recolouring a container's group renames or recolours the
// container. An empty name, or one another container already has, is put back.
chrome.tabGroups.onUpdated.addListener((group) => void onGroupEdited(group.id));
chrome.tabGroups.onRemoved.addListener((group) => void state.setGroupOwner(group.id, null));

async function onGroupEdited(groupId: number): Promise<void> {
  await startup;
  if (namingGroups.has(groupId)) return;
  const containerId = state.groupOwner(groupId);
  const container = containerId && state.getContainer(containerId);
  if (!container) return;
  const group = await chrome.tabGroups.get(groupId).catch(() => null); // the event's copy may be stale
  if (!group) return;
  const title = (group.title ?? "").trim();
  const nameTaken = state.listContainers().some((c) => c.id !== container.id && c.name === title);
  const name = title && !nameTaken ? title : container.name;
  const color = group.color as state.GroupColor;
  if (name !== container.name || color !== container.color) {
    await state.updateContainer(container.id, { name, color });
    logEvent("container-edited", { containerId: container.id, name, color });
  }
  for (const owned of state.groupsOf(container.id)) {
    const other = await chrome.tabGroups.get(owned).catch(() => null);
    if (other && (other.title !== name || other.color !== color)) {
      await chrome.tabGroups.update(owned, { title: name, color: color as chrome.tabGroups.Color }).catch(() => {});
    }
  }
}

/** Opens `url` in a new tab that belongs to the container from its first request. */
export async function openTab(url: string, containerId: string, windowId?: number): Promise<number> {
  await startup;
  if (!state.getContainer(containerId)) throw new Error(`no container ${containerId}`);
  if (!roomFor(containerId)) {
    throw new Error("Chrome's rule limit is full. Close the tabs of a container you're not using, then try again.");
  }
  await noteContainerOrigin(url); // before the first request, so no worker answers it
  const tab = await chrome.tabs.create({ url: "about:blank", windowId });
  await classify(tab.id!, containerId);
  await chrome.tabs.update(tab.id!, { url });
  void groupTab(tab.id!, containerId);
  return tab.id!;
}

// --- Messages ----------------------------------------------------------------

function frameUrl(sender: chrome.runtime.MessageSender, claimed?: string): URL | null {
  if (sender.url && /^https?:/.test(sender.url)) return new URL(sender.url);
  // about:blank / srcdoc frames report their own URL; trust the claimed one
  // only if it has the frame's (inherited) origin.
  if (claimed && /^https?:/.test(claimed) && new URL(claimed).origin === sender.origin) return new URL(claimed);
  return null;
}

function snapshotFor(sender: chrome.runtime.MessageSender, claimed?: string): SnapshotReply {
  const containerId = sender.tab?.id === undefined ? undefined : state.containerOfTab(sender.tab.id);
  const url = frameUrl(sender, claimed);
  if (!containerId || !url) return { container: containerId ?? null, cookies: [] };
  const topHost = sender.tab?.url ? new URL(sender.tab.url).hostname : url.hostname;
  const ctx: SiteContext = sender.frameId === 0 || siteOf(topHost) === siteOf(url.hostname) ? "same-site" : "cross-site";
  const cookies = cookiesForUrl(state.getJar(containerId), url, ctx).filter((c) => !c.httpOnly);
  return { container: containerId, cookies: cookies.map((c) => [c.name, c.value, c.expires ?? 0]) };
}

const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
  !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(""));

async function handle(msg: BgMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await startup;
  switch (msg.type) {
    case "mac:get-snapshot":
      return snapshotFor(sender, msg.url);

    case "mac:set-cookie": {
      const containerId = sender.tab?.id === undefined ? undefined : state.containerOfTab(sender.tab.id);
      const url = frameUrl(sender, msg.url);
      if (!containerId || !url) return null;
      const cookie = parseSetCookie(msg.cookie, url, { fromScript: true });
      const next = cookie && applyCookie(state.getJar(containerId), cookie, { fromScript: true });
      if (next) await commitJar(containerId, next);
      await barrier();
      return null;
    }

    case "mac:barrier":
      await barrier();
      return null;
  }

  if (!fromExtensionPage(sender)) return null;
  switch (msg.type) {
    case "mac:list":
      return {
        containers: state.listContainers(),
        current: msg.tabId === undefined ? null : state.containerOfTab(msg.tabId) ?? null,
      };
    case "mac:create":
      return state.createContainer(msg.name, msg.color);
    case "mac:delete": {
      const orphans = await state.deleteContainer(msg.id);
      await scheduleSync();
      // Their pages hold the deleted container's identity in memory; close them.
      if (orphans.length) await chrome.tabs.remove(orphans).catch(() => {});
      return null;
    }
    case "mac:open":
      return openTab(msg.url ?? "about:blank", msg.id, msg.windowId);
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg: BgMessage, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

// --- Lifecycle -----------------------------------------------------------------

// Runs on every worker start. After a browser restart or an extension reload
// the session state and session rules are gone, and the lockdown rule is
// blocking every tab. Restored tabs get their container back from the tab
// group they were restored into; then the blocked loads are replayed.
const startup: Promise<{ httpTabs: number }> = state.ready
  .then(async () => {
    const tabs = await chrome.tabs.query({});
    const groupContainer = new Map<number, string>();
    for (const tab of tabs) {
      if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !groupContainer.has(tab.groupId)) {
        const containerId = await containerOfGroup(tab.groupId);
        if (containerId) groupContainer.set(tab.groupId, containerId);
      }
    }
    const added = await state.reconcileTabs(tabs, (tab) => groupContainer.get(tab.groupId) ?? null);
    await scheduleSync();
    const now = Date.now();
    for (const tabId of added) classifiedAt.set(tabId, now);
    for (const [tabId, url] of blockedNav) {
      blockedNav.delete(tabId);
      renavigate(tabId, url);
    }
    // Restored tabs that loaded while the extension was still starting were
    // blocked before the worker could hear about it; find their error pages.
    for (const tabId of added) await replayIfBlocked(tabId);
    logEvent("startup", { assigned: added.map((tabId) => [tabId, state.containerOfTab(tabId) ?? null]) });
    stats.restoredIntoContainers += added.filter((tabId) => state.containerOfTab(tabId)).length;
    return { httpTabs: tabs.filter((t) => /^https?:/.test(t.url || t.pendingUrl || "")).length };
  })
  .catch((e) => {
    console.error("startup failed", e);
    stats.lastError = `startup: ${e}`;
    return { httpTabs: 0 };
  });

// --- Service workers for container sites -------------------------------------------

const serviceWorkerHosts = () => [...new Set(state.listContainerOrigins().map((o) => new URL(o).hostname))];

/** Removes the profile's service workers for these origins. */
function removeServiceWorkers(origins: string[]): Promise<void> {
  const web = origins.filter((o) => /^https?:/.test(o));
  if (!web.length) return Promise.resolve();
  return chrome.browsingData.remove({ origins: web as [string, ...string[]] }, { serviceWorkers: true }).catch((e) => {
    console.warn("could not remove service workers", e);
  });
}

/** First use of a site in a container: evict its service workers from normal tabs. */
async function noteContainerOrigin(url: string): Promise<void> {
  if (!/^https?:/.test(url)) return;
  const origin = new URL(url).origin;
  if (!(await state.addContainerOrigin(origin))) return;
  logEvent("container-site", { origin });
  // Normal pages already open on this site loaded without the marker.
  const host = new URL(origin).hostname;
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || state.containerOfTab(tab.id) || !/^https?:/.test(tab.url ?? "")) continue;
    const tabHost = new URL(tab.url!).hostname;
    if (tabHost === host || tabHost.endsWith("." + host)) {
      chrome.tabs.sendMessage(tab.id, { type: "mac:no-sw" }).catch(() => {});
    }
  }
  await removeServiceWorkers([origin]);
  await scheduleSync();
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    void state.ready.then(() => {
      if (state.containerOfTab(details.tabId)) void noteContainerOrigin(details.url);
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
);

// Once per browser session, catch workers registered while we weren't looking.
void startup.then(async () => {
  const { swPurged } = await chrome.storage.session.get("swPurged");
  if (swPurged) return;
  await removeServiceWorkers(state.listContainerOrigins());
  await chrome.storage.session.set({ swPurged: true });
});

// --- Idle reset ------------------------------------------------------------------

/** A container nobody has used for this long signs out of everything. */
const MAX_IDLE_MS = 30 * 24 * 60 * 60_000;

async function resetIdleContainers(): Promise<string[]> {
  await startup;
  const reset: string[] = [];
  for (const container of state.idleContainers(MAX_IDLE_MS)) {
    await state.resetContainer(container.id);
    reset.push(container.name);
    logEvent("idle-reset", { containerId: container.id });
  }
  if (reset.length) {
    await scheduleSync();
    // Open pages hold the old storage prefix and cookies in memory.
    for (const container of state.listContainers()) {
      if (!reset.includes(container.name)) continue;
      for (const tabId of state.tabsOf(container.id)) chrome.tabs.reload(tabId).catch(() => {});
    }
  }
  return reset;
}

chrome.alarms.create("idle-reset", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "idle-reset") void resetIdleContainers();
});
void resetIdleContainers();

// Like Chrome's "Continue where you left off": if the session came back,
// session cookies come back with it; a fresh session starts without them.
chrome.runtime.onStartup.addListener(() => void startup.then(async ({ httpTabs }) => {
  if (!httpTabs) await state.dropSessionCookies();
}));

// Test hook: the e2e suite drives the engine through the worker's global scope.
Object.assign(globalThis, {
  mac: {
    stats,
    openTab,
    scheduleSync,
    createContainer: async (name: string, color: state.GroupColor = "blue") => {
      await state.ready;
      return state.createContainer(name, color);
    },
    getJar: state.getJar,
    containerOfTab: state.containerOfTab,
    rules: () => chrome.declarativeNetRequest.getSessionRules(),
    setLimits: (next: Partial<typeof limits>) => Object.assign(limits, next),
    backdateUse: state.backdateUse,
    resetIdleContainers,
    buildId: __BUILD_ID__,
    listContainers: state.listContainers,
    events: () => events,
  },
});
