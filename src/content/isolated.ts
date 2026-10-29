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
});

// The navigation-time snapshot can be stale (e.g. Strict cookies are left off a
// cross-site navigation), so container documents always ask for a fresh one.
const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
if (nav?.serverTiming.some((t) => t.name === MARKER) || /^(about|blob|data):/.test(location.protocol)) {
  void refresh();
}
