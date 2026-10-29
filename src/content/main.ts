// MAIN-world shim, injected at document_start into every frame.
//
// It must decide synchronously, before any page script runs, which container
// the document belongs to. The DNR rules append Server-Timing entries to every
// container document response (the container id plus a snapshot of the
// script-visible cookies), and Server-Timing is readable from the navigation
// timing entry from the very first script.
//
// In a container: document.cookie is served from that snapshot, and Web Storage
// and IndexedDB keys are prefixed per container. In a default tab: container
// keys are hidden so the real profile can't read them.

import { domainMatch, isLocalhost, parseSetCookie, pathMatch } from "../shared/cookie.ts";
import {
  EV_TO_ISOLATED,
  EV_TO_MAIN,
  MARKER,
  NO_SW,
  SNAPSHOT,
  type SnapshotCookie,
  type ToIsolated,
  type ToMain,
} from "../shared/messages.ts";

const NS = "__mac_";
const STATE = Symbol.for("__mac_state");

interface ShimState {
  container: string | null;
  /** A normal-tab page of a site that is used in containers. */
  noServiceWorker?: boolean;
  url: string;
  cookies: SnapshotCookie[];
}

const timingDesc = Object.getOwnPropertyDescriptor(PerformanceResourceTiming.prototype, "serverTiming")!;

function inheritedState(): ShimState | null {
  if (!/^(about|blob|data):/.test(location.protocol)) return null;
  const source = window.parent !== window ? window.parent : window.opener;
  try {
    return (source?.[STATE] as ShimState | undefined) ?? null;
  } catch {
    return null; // cross-origin
  }
}

function detect(): ShimState {
  const inherited = inheritedState();
  if (inherited) return inherited;
  const state: ShimState = { container: null, url: location.href, cookies: [] };
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const entries: PerformanceServerTiming[] = nav ? timingDesc.get!.call(nav) : [];
  // Ours are appended after any the site sent, so the last one wins.
  for (const t of entries) {
    if (t.name === MARKER) state.container = decodeURIComponent(t.description);
    else if (t.name === SNAPSHOT) state.cookies = JSON.parse(decodeURIComponent(t.description));
    else if (t.name === NO_SW) state.noServiceWorker = true;
  }
  return state;
}

const state = detect();
Object.defineProperty(window, STATE, { value: state });
const prefix = state.container ? `${NS}${state.container}__` : null;

// --- Hide our Server-Timing entries ------------------------------------------

Object.defineProperty(PerformanceResourceTiming.prototype, "serverTiming", {
  ...timingDesc,
  get(this: PerformanceResourceTiming) {
    return (timingDesc.get!.call(this) as PerformanceServerTiming[]).filter(
      (t) => t.name !== MARKER && t.name !== SNAPSHOT && t.name !== NO_SW,
    );
  },
});

// --- Web Storage -----------------------------------------------------------------

const S = Storage.prototype;
const real = { get: S.getItem, set: S.setItem, remove: S.removeItem, key: S.key };
const realLength = Object.getOwnPropertyDescriptor(S, "length")!.get!;

function wrapStorage(store: Storage): Storage {
  // Default tabs see unprefixed keys only; a key in our namespace is unreachable.
  const toReal = (k: string): string | null => (prefix ? prefix + k : k.startsWith(NS) ? null : k);
  const keys = (): string[] => {
    const out: string[] = [];
    const n = realLength.call(store) as number;
    for (let i = 0; i < n; i++) {
      const k = real.key.call(store, i)!;
      if (prefix ? k.startsWith(prefix) : !k.startsWith(NS)) out.push(prefix ? k.slice(prefix.length) : k);
    }
    return out;
  };
  const api = {
    getItem(k: string) {
      const r = toReal(String(k));
      return r === null ? null : real.get.call(store, r);
    },
    setItem(k: string, v: string) {
      const r = toReal(String(k));
      if (r !== null) real.set.call(store, r, String(v));
    },
    removeItem(k: string) {
      const r = toReal(String(k));
      if (r !== null) real.remove.call(store, r);
    },
    clear() {
      for (const k of keys()) real.remove.call(store, toReal(k)!);
    },
    key(i: number) {
      return keys()[i] ?? null;
    },
  };
  return new Proxy(Object.create(Storage.prototype) as Storage, {
    get(target, p) {
      if (typeof p === "symbol") return Reflect.get(target, p);
      if (p === "length") return keys().length;
      if (Object.hasOwn(api, p)) return api[p as keyof typeof api];
      if (p in target) return Reflect.get(target, p);
      return api.getItem(p) ?? undefined;
    },
    set(target, p, v) {
      if (typeof p === "symbol") return Reflect.set(target, p, v);
      api.setItem(p, v);
      return true;
    },
    deleteProperty(_target, p) {
      if (typeof p === "string") api.removeItem(p);
      return true;
    },
    has(target, p) {
      return typeof p === "string" ? Object.hasOwn(api, p) || p in target || api.getItem(p) !== null : p in target;
    },
    ownKeys() {
      return keys();
    },
    getOwnPropertyDescriptor(_target, p) {
      if (typeof p !== "string") return undefined;
      const value = api.getItem(p);
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
  });
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  let store: Storage;
  try {
    store = window[name];
  } catch {
    continue; // opaque origin: access throws natively, keep that behavior
  }
  const wrapped = wrapStorage(store);
  Object.defineProperty(window, name, { get: () => wrapped, configurable: true, enumerable: true });
}

// --- IndexedDB -----------------------------------------------------------------

{
  // Default tabs that use our namespace get escaped into their own corner.
  const ESC = `${NS}d__`;
  const toReal = (n: string) => (prefix ? prefix + n : n.startsWith(NS) ? ESC + n : n);
  const fromReal = (n: string): string | null => {
    if (prefix) return n.startsWith(prefix) ? n.slice(prefix.length) : null;
    if (n.startsWith(ESC)) return n.slice(ESC.length);
    return n.startsWith(NS) ? null : n;
  };
  const F = IDBFactory.prototype;
  const { open, deleteDatabase, databases } = F;
  F.open = function (this: IDBFactory, name: string, version?: number) {
    return version === undefined ? open.call(this, toReal(String(name))) : open.call(this, toReal(String(name)), version);
  };
  F.deleteDatabase = function (this: IDBFactory, name: string) {
    return deleteDatabase.call(this, toReal(String(name)));
  };
  if (databases) {
    F.databases = async function (this: IDBFactory) {
      const list = await databases.call(this);
      return list.flatMap((d) => {
        const name = d.name === undefined ? null : fromReal(d.name);
        return name === null ? [] : [{ ...d, name }];
      });
    };
  }
  const nameDesc = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "name")!;
  Object.defineProperty(IDBDatabase.prototype, "name", {
    ...nameDesc,
    get(this: IDBDatabase) {
      const n = nameDesc.get!.call(this) as string;
      return fromReal(n) ?? n;
    },
  });
}

// --- Container-only: cookies, CookieStore, service workers ----------------------

if (state.container) {
  // --- Round trips to the worker, with a timeout so a dead worker can't hang the page.
  let nextId = 0;
  const waiting = new Map<number, () => void>();
  const toIsolated = (msg: ToIsolated) =>
    document.dispatchEvent(new CustomEvent(EV_TO_ISOLATED, { detail: JSON.stringify(msg) }));
  const roundTrip = (make: (id: number) => ToIsolated) =>
    new Promise<void>((resolve) => {
      const id = ++nextId;
      const timer = setTimeout(done, 2000);
      function done() {
        clearTimeout(timer);
        waiting.delete(id);
        resolve();
      }
      waiting.set(id, done);
      toIsolated(make(id));
    });

  document.addEventListener(EV_TO_MAIN, (e) => {
    const msg = JSON.parse((e as CustomEvent<string>).detail) as ToMain;
    if (msg.type === "snapshot") state.cookies = msg.cookies;
    else if (msg.type === "ack") waiting.get(msg.id)?.();
  });

  /** document.cookie writes the worker has not yet turned into rules. */
  const pendingWrites = new Set<Promise<void>>();
  const writesSettled = () => (pendingWrites.size ? Promise.all(pendingWrites) : null);

  // fetch waits for pending cookie writes before sending, and for the worker to
  // absorb any Set-Cookie on the response before the page sees it.
  const realFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    await writesSettled();
    const response = await realFetch.apply(this, args);
    await roundTrip((id) => ({ type: "barrier", id }));
    return response;
  };

  // Async XHR only gets the first half: send() waits for pending cookie writes.
  const realSend = XMLHttpRequest.prototype.send;
  const asyncXhr = new WeakSet<XMLHttpRequest>();
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    if (args[2] !== false) asyncXhr.add(this);
    else asyncXhr.delete(this);
    return (realOpen as (...a: unknown[]) => void).apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const settled = asyncXhr.has(this) && writesSettled();
    if (!settled) return realSend.call(this, body);
    void settled.then(() => realSend.call(this, body));
  };

  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  const docUrl = () => new URL(state.url);

  const read = () => {
    const now = Date.now();
    return state.cookies
      .filter(([, , expires]) => !expires || expires > now)
      .map(([name, value]) => (name ? `${name}=${value}` : value))
      .join("; ");
  };

  const write = (str: string) => {
    const url = docUrl();
    const cookie = parseSetCookie(str, url, { fromScript: true });
    if (!cookie) return;
    const host = url.hostname.toLowerCase();
    const visibleHere =
      domainMatch(host, cookie) &&
      pathMatch(url.pathname || "/", cookie.path) &&
      (!cookie.secure || url.protocol === "https:" || isLocalhost(host));
    if (visibleHere) {
      const rest = state.cookies.filter(([name]) => name !== cookie.name);
      const expired = cookie.expires !== null && cookie.expires <= Date.now();
      state.cookies = expired ? rest : [...rest, [cookie.name, cookie.value, cookie.expires ?? 0]];
    }
    const written: Promise<void> = roundTrip((id) => ({ type: "set-cookie", id, cookie: str, url: state.url }))
      .finally(() => pendingWrites.delete(written));
    pendingWrites.add(written);
  };

  Object.defineProperty(Document.prototype, "cookie", {
    configurable: true,
    enumerable: cookieDesc.enumerable,
    get(this: Document) {
      return this === document ? read() : cookieDesc.get!.call(this);
    },
    set(this: Document, v: string) {
      if (this === document) write(String(v));
      else cookieDesc.set!.call(this, v);
    },
  });

  // The async CookieStore API would bypass the jar; sites fall back to document.cookie.
  delete (window as { cookieStore?: unknown }).cookieStore;
  if ("cookieStore" in window) Object.defineProperty(window, "cookieStore", { value: undefined, configurable: true });

}

// A service worker's own fetches carry no tab id, so DNR can't give them a
// container's cookies, and one registered from either side would serve the
// other side's tabs. No registrations from container pages, nor from normal
// pages of sites that are used in containers.
function refuseServiceWorkers(): void {
  if (typeof ServiceWorkerContainer === "undefined") return;
  ServiceWorkerContainer.prototype.register = function () {
    return Promise.reject(new DOMException("Service workers are disabled for sites used in containers", "SecurityError"));
  };
}

if (state.container || state.noServiceWorker) {
  refuseServiceWorkers();
} else {
  // A normal page that was already open when its site was first used in a container.
  document.addEventListener(EV_TO_MAIN, (e) => {
    if ((JSON.parse((e as CustomEvent<string>).detail) as ToMain).type === "no-sw") refuseServiceWorkers();
  });
}
