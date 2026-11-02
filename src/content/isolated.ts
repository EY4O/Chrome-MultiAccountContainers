// ISOLATED-world bridge: relays document.cookie writes from the MAIN-world shim
// to the worker, and pushes fresh cookie snapshots back when the jar changes.

import {
  EV_TO_ISOLATED,
  EV_TO_MAIN,
  MARKER,
  type BgMessage,
  type SnapshotReply,
  type ToIsolated,
  type ToMain,
} from "../shared/messages.ts";

const send = (msg: BgMessage) => chrome.runtime.sendMessage(msg);

/** about:blank-style frames act for their parent (or opener) document. */
function effectiveUrl(): string {
  if (!/^(about|blob|data):/.test(location.protocol)) return location.href;
  try {
    const source = window.parent !== window ? window.parent : window.opener;
    return source?.location.href ?? location.href;
  } catch {
    return location.href;
  }
}

const toMain = (msg: ToMain) => document.dispatchEvent(new CustomEvent(EV_TO_MAIN, { detail: JSON.stringify(msg) }));

// Both requests resolve only once the worker's rules reflect the change, which
// is what lets the shim hold back fetches until cookies are really in place.
document.addEventListener(EV_TO_ISOLATED, (e) => {
  const msg = JSON.parse((e as CustomEvent<string>).detail) as ToIsolated;
  const done = msg.type === "set-cookie"
    ? send({ type: "mac:set-cookie", cookie: msg.cookie, url: msg.url })
    : send({ type: "mac:barrier" });
  done.catch(() => {}).finally(() => toMain({ type: "ack", id: msg.id }));
});

async function refresh(): Promise<void> {
  const reply = (await send({ type: "mac:get-snapshot", url: effectiveUrl() }).catch(() => null)) as SnapshotReply | null;
  if (!reply?.container) return;
  toMain({ type: "snapshot", cookies: reply.cookies });
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg.type === "mac:jar-changed") void refresh();
  if (msg.type === "mac:no-sw") toMain({ type: "no-sw" });
});

// The navigation-time snapshot can be stale (e.g. Strict cookies are left off a
// cross-site navigation), so container documents always ask for a fresh one.
const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
const inContainer = nav?.serverTiming.some((t) => t.name === MARKER);
if (inContainer || /^(about|blob|data):/.test(location.protocol)) {
  void refresh();
}

// A person clicking, typing or scrolling keeps the container from signing out
// as idle; a page polling in the background doesn't. At most once a minute.
let lastActivity = 0;
function activity(e: Event): void {
  if (!e.isTrusted || Date.now() - lastActivity < 60_000) return;
  lastActivity = Date.now();
  send({ type: "mac:activity" }).catch(() => {});
}
if (inContainer) {
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(type, activity, { capture: true, passive: true });
}
