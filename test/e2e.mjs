// End-to-end isolation checks: loads dist/ into Chrome for Testing, drives the
// engine through the service worker, and probes the harness from default and
// container tabs. Run `npm run build` first.
//
// "check" failures fail the run; "measure" results are informational (races).

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer";
import { start } from "../harness/server.mjs";

const PORT = 8787;
const u = (host, path) => `http://${host}.localhost:${PORT}${path}`;
const enc = encodeURIComponent;

const results = [];
function check(name, ok, detail) {
  results.push({ kind: "check", name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}
function measure(name, detail) {
  results.push({ kind: "measure", name, detail });
  console.log(`INFO  ${name}: ${JSON.stringify(detail)}`);
}

const server = await start(PORT);
const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [resolve("dist")],
  executablePath: process.env.CHROME_PATH,
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 10_000 },
  );
  const sw = await swTarget.worker();
  await sw.evaluate(() => globalThis.mac.scheduleSync());

  let n = 0;
  const fresh = (host, path) => `${u(host, path)}${path.includes("?") ? "&" : "?"}n=${++n}`;

  async function pageFor(url) {
    const target = await browser.waitForTarget((t) => t.url() === url, { timeout: 10_000 });
    const page = await target.page();
    await page.waitForFunction(() => document.readyState === "complete", { timeout: 10_000 });
    return page;
  }

  async function openDefault(host, path = "/page") {
    const page = await browser.newPage();
    // A tab whose opener is a container tab stays quarantined until the worker
    // rules out a page-opened tab (500 ms); don't navigate before that.
    await sleep(700);
    await page.goto(fresh(host, path));
    return page;
  }

  async function openIn(containerId, host, path = "/page") {
    const url = fresh(host, path);
    await sw.evaluate((url, id) => globalThis.mac.openTab(url, id), url, containerId);
    return pageFor(url);
  }

  async function reopen(page, host, path = "/page") {
    await page.goto(fresh(host, path));
    return page;
  }

  const get = (page, path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
  const echo = async (page, path = "/echo") => (await get(page, path)).cookie;
  const settle = () => sleep(250);

  const c1 = await sw.evaluate(() => globalThis.mac.createContainer("Personal", "blue"));
  const c2 = await sw.evaluate(() => globalThis.mac.createContainer("Work", "red"));

  // --- HTTP cookies ----------------------------------------------------------
  const dflt = await openDefault("a");
  await get(dflt, `/set?c=${enc("sid=default; Path=/")}`);
  const p1 = await openIn(c1.id, "a");
  const p2 = await openIn(c2.id, "a");
  check("container tab does not receive the profile's cookies", (await echo(p1)) === "", await echo(p1));

  await get(p1, `/set?c=${enc("sid=one; Path=/")}&c=${enc("ho=1; Path=/; HttpOnly")}`);
  await get(p2, `/set?c=${enc("sid=two; Path=/")}`);
  await settle();
  check("C1 sees only its own HTTP cookies", (await echo(p1)) === "sid=one; ho=1", await echo(p1));
  check("C2 sees only its own HTTP cookies", (await echo(p2)) === "sid=two", await echo(p2));
  check("default tab still sees only the profile cookie", (await echo(dflt)) === "sid=default", await echo(dflt));

  const realCookies = (await browser.cookies()).map((c) => `${c.name}=${c.value}`);
  check("container cookies never reach the real cookie store", realCookies.join() === "sid=default", realCookies);

  // --- document.cookie -------------------------------------------------------
  await reopen(p1, "a");
  const early = await p1.evaluate(() => window.__early);
  check("document.cookie is correct in the first inline script", early.cookie === "sid=one", early);
  check("HttpOnly cookie hidden from document.cookie but sent to server",
    !early.cookie.includes("ho=") && (await p1.evaluate(() => window.__serverCookie)).includes("ho=1"), early);
  check("Server-Timing markers hidden from the page", !early.serverTiming.some((s) => s.startsWith("__mac")), early.serverTiming);

  const immediate = await p1.evaluate(async () => {
    document.cookie = "js=1; path=/";
    return { view: document.cookie, sent: (await (await fetch("/echo")).json()).cookie };
  });
  check("document.cookie write is visible to script immediately", immediate.view.includes("js=1"), immediate);
  check("document.cookie write present on an immediate fetch", immediate.sent.includes("js=1"), immediate);
  const xhrSent = await p1.evaluate(() => new Promise((ok) => {
    document.cookie = "xhr=1; path=/";
    const x = new XMLHttpRequest();
    x.open("GET", "/echo");
    x.onload = () => ok(JSON.parse(x.responseText).cookie);
    x.send();
  }));
  check("document.cookie write present on an immediate async XHR", xhrSent.includes("xhr=1"), xhrSent);
  await settle();
  check("document.cookie write reaches the server", (await echo(p1)).includes("js=1"), await echo(p1));
  check("document.cookie write does not leak to default", !(await echo(dflt)).includes("js="), await echo(dflt));
  check("default tab document.cookie untouched", (await dflt.evaluate(() => document.cookie)) === "sid=default",
    await dflt.evaluate(() => document.cookie));

  // --- Browser identity headers (Chrome sign-in, device-bound sessions)
  const identityHeaders = (p) => p.evaluate(async () => {
    const r = await fetch("/identity");
    return [r.headers.get("x-chrome-id-consistency-response"), r.headers.get("sec-session-registration")];
  });
  const containerIdentity = await identityHeaders(p1);
  check("Chrome sign-in and session-registration headers stripped in a container", containerIdentity.every((h) => h === null), containerIdentity);
  const defaultIdentity = await identityHeaders(dflt);
  check("the same headers untouched in a default tab", defaultIdentity.every((h) => h !== null), defaultIdentity);

  // --- Set-Cookie -> next request race --------------------------------------
  let raceHits = 0;
  for (let i = 0; i < 10; i++) {
    const hit = await p1.evaluate(async (i) => {
      await fetch(`/set?c=${encodeURIComponent(`race${i}=1; Path=/`)}`);
      return (await (await fetch("/echo")).json()).cookie.includes(`race${i}=1`);
    }, i);
    if (hit) raceHits++;
  }
  check("Set-Cookie from a fetch is visible on the very next fetch", raceHits === 10, `${raceHits}/10`);

  const redirected = await get(p1, `/redirect?to=/echo&c=${enc("rd=1; Path=/")}`);
  measure("cookie set by a redirect present on the redirected request", redirected.cookie.includes("rd=1"));
  await settle();
  check("cookie set by a redirect is captured", (await echo(p1)).includes("rd=1"), await echo(p1));

  // --- Login flow: 302 + Set-Cookie, then a page that hands out anonymous sessions
  // The engine replays a navigation that went out with stale cookies, which
  // aborts Puppeteer's own goto; that is expected.
  await p1.goto(u("a", "/login")).catch(() => {});
  await sleep(1000);
  await p1.waitForFunction(() => window.__serverCookie?.includes("session=auth"), { timeout: 5000 }).catch(() => {});
  const home = await p1.evaluate(() => window.__serverCookie);
  const jarSession = (await sw.evaluate((id) => globalThis.mac.getJar(id), c1.id)).find((c) => c.name === "session")?.value;
  check("login redirect: home page ends up loaded with session=auth", home.includes("session=auth"), home);
  check("login redirect: stale page's anonymous session did not clobber the login", jarSession === "auth", jarSession);

  // --- Domain and path scoping -----------------------------------------------
  const x1 = await openIn(c1.id, "x.site");
  await get(x1, `/set?c=${enc("dc=1; Domain=site.localhost; Path=/")}&c=${enc("p=1; Path=/app")}`);
  await settle();
  const y1 = await openIn(c1.id, "y.site");
  check("domain cookie reaches a sibling subdomain in the same container", (await echo(y1)) === "dc=1", await echo(y1));
  check("path cookie excluded outside its path", (await echo(x1)) === "dc=1", await echo(x1));
  check("path cookie sent inside its path", (await echo(x1, "/app/echo")) === "p=1; dc=1", await echo(x1, "/app/echo"));
  const yDefault = await openDefault("y.site");
  check("domain cookie does not leak to default", (await echo(yDefault)) === "", await echo(yDefault));

  // --- Web Storage and IndexedDB ---------------------------------------------
  await dflt.evaluate(() => localStorage.setItem("who", "default"));
  await p1.evaluate(() => localStorage.setItem("who", "one"));
  await p2.evaluate(() => localStorage.setItem("who", "two"));
  const ls = await Promise.all([dflt, p1, p2].map((p) => p.evaluate(() => localStorage.getItem("who"))));
  check("localStorage isolated per container", ls.join() === "default,one,two", ls);
  const dfltKeys = await dflt.evaluate(() => Object.keys(localStorage));
  check("default tab cannot see container localStorage keys", dfltKeys.join() === "who", dfltKeys);
  await reopen(p1, "a");
  const early2 = await p1.evaluate(() => window.__early);
  check("localStorage shim active in the first inline script", early2.ls === "one" && early2.lsKeys.join() === "who", early2);
  const propAccess = await p2.evaluate(() => {
    localStorage.viaProp = "x";
    const r = { get: localStorage.getItem("viaProp"), keys: Object.keys(localStorage).sort(), len: localStorage.length };
    delete localStorage.viaProp;
    return r;
  });
  check("localStorage property-style access works", propAccess.get === "x" && propAccess.len === 2, propAccess);

  const idbWrite = (p, value) => p.evaluate((value) => new Promise((ok, fail) => {
    const req = indexedDB.open("db", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, "who");
      tx.oncomplete = () => { req.result.close(); ok(); };
    };
  }), value);
  const idbRead = (p) => p.evaluate(() => new Promise((ok, fail) => {
    const req = indexedDB.open("db", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const get = req.result.transaction("kv").objectStore("kv").get("who");
      get.onsuccess = () => { const name = req.result.name; req.result.close(); ok({ name, value: get.result ?? null }); };
    };
  }));
  await idbWrite(dflt, "default");
  await idbWrite(p1, "one");
  await idbWrite(p2, "two");
  const idb = await Promise.all([dflt, p1, p2].map(idbRead));
  check("IndexedDB isolated per container", idb.map((r) => r.value).join() === "default,one,two", idb);
  check("IDBDatabase.name shows the unprefixed name", idb.every((r) => r.name === "db"), idb);
  const dbs = await Promise.all([dflt, p1].map((p) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))));
  check("indexedDB.databases() lists only the tab's own databases", dbs.every((d) => d.join() === "db"), dbs);

  // --- Child tabs, frames, service workers -----------------------------------
  await reopen(p1, "a");
  await p1.bringToFront(); // users click links in the active tab
  const [childTarget] = await Promise.all([
    browser.waitForTarget((t) => t.url().endsWith("/child"), { timeout: 10_000 }),
    p1.click("#blank"),
  ]);
  const child = await childTarget.page();
  await child.waitForFunction(() => window.__serverCookie !== undefined, { timeout: 10_000 }).catch(async (e) => {
    const tabs = await sw.evaluate(async () =>
      (await chrome.tabs.query({})).map((t) => [t.id, t.url, t.openerTabId, globalThis.mac.containerOfTab(t.id)]));
    measure("child tab diagnostics", { url: child.url(), stats: await sw.evaluate(() => ({ ...globalThis.mac.stats })), tabs });
    throw e;
  });
  const childCookie = await child.evaluate(() => window.__serverCookie);
  check("target=_blank tab inherits the container", childCookie.includes("sid=one") && !childCookie.includes("default"), childCookie);
  measure("worker stats", await sw.evaluate(() => ({ ...globalThis.mac.stats })));

  const b1 = await openIn(c1.id, "b");
  await get(b1, `/set?c=${enc("bc=1; Path=/; SameSite=None; Secure")}`);
  await settle();
  await reopen(p1, "a", `/frame?src=${enc(u("b", "/page"))}`);
  await p1.waitForFunction(() => window.__frameReport !== undefined, { timeout: 10_000 });
  const frameData = await p1.evaluate(() => window.__frameReport);
  check("cross-site iframe gets the container's SameSite=None cookie", frameData.server === "bc=1", frameData);
  check("cross-site iframe document.cookie served from the container", frameData.early.cookie === "bc=1", frameData);

  const swResult = await p1.evaluate(() => navigator.serviceWorker.register("/sw.js").then(() => "registered", (e) => e.name));
  check("service worker registration refused in a container", swResult === "SecurityError", swResult);

  const fetchCost = (p) => p.evaluate(async () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) await (await fetch("/echo")).text();
    return Math.round(((performance.now() - t0) / 50) * 100) / 100;
  });
  measure("mean fetch latency, ms (default vs container)", { default: await fetchCost(dflt), container: await fetchCost(p2) });

  // --- Phase 2: encryption at rest ------------------------------------------------
  const stored = await sw.evaluate((id) => chrome.storage.local.get(`jar:${id}`), c1.id);
  const sealedJar = stored[`jar:${c1.id}`];
  check("container cookies are encrypted at rest",
    sealedJar?.v === 1 && sealedJar.iv && !JSON.stringify(sealedJar).includes("sid"), sealedJar);

  // --- Phase 2: live group sync ------------------------------------------------------
  const tabIdOf = (url) => sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, url);
  const groupOf = (tabId) => sw.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).groupId, tabId);
  const reloadedCookie = async (page) => {
    await sleep(1500); // the worker reloads the tab under its new identity
    await page.waitForFunction(() => document.readyState === "complete" && window.__serverCookie !== undefined);
    return page.evaluate(() => window.__serverCookie);
  };
  const p1Group = await groupOf(await tabIdOf(p1.url()));
  const mover = await openDefault("a");
  const moverId = await tabIdOf(mover.url());
  await sw.evaluate((tabId, groupId) => chrome.tabs.group({ tabIds: [tabId], groupId }), moverId, p1Group);
  const inside = await reloadedCookie(mover);
  check("dragging a normal tab into a container's group moves it into that container",
    inside.includes("sid=one") && (await sw.evaluate((t) => globalThis.mac.containerOfTab(t), moverId)) === c1.id, inside);
  await sw.evaluate((tabId) => chrome.tabs.ungroup(tabId), moverId);
  const outside = await reloadedCookie(mover);
  check("dragging it out makes it a normal tab again",
    outside === "sid=default" && !(await sw.evaluate((t) => globalThis.mac.containerOfTab(t), moverId)), outside);

  const containerNamed = (id) => sw.evaluate((id) => globalThis.mac.listContainers().find((c) => c.id === id), id);
  await sw.evaluate((g) => chrome.tabGroups.update(g, { title: "Personal 2" }), p1Group);
  await sleep(500);
  check("renaming a container's group renames the container", (await containerNamed(c1.id)).name === "Personal 2", await containerNamed(c1.id));
  await sw.evaluate((g) => chrome.tabGroups.update(g, { title: "Work" }), p1Group);
  await sleep(500);
  const afterDup = await sw.evaluate(async (g) => (await chrome.tabGroups.get(g)).title, p1Group);
  check("a name another container already has is put back", afterDup === "Personal 2" && (await containerNamed(c1.id)).name === "Personal 2", afterDup);
  await sw.evaluate((g) => chrome.tabGroups.update(g, { color: "green" }), p1Group);
  await sleep(500);
  check("recolouring the group recolours the container", (await containerNamed(c1.id)).color === "green", await containerNamed(c1.id));

  // --- Phase 2: service workers -------------------------------------------------------
  const register = (page) => page.evaluate(() => navigator.serviceWorker.register("/sw.js").then(() => "registered", (e) => e.name));
  check("a normal tab can't register a service worker for a site used in containers", (await register(dflt)) === "SecurityError", await register(dflt));
  const swPage = await openDefault("fresh");
  check("a normal tab on a site never used in a container can still register one", (await register(swPage)) === "registered", await register(swPage));
  const freshInWork = await openIn(c2.id, "fresh");
  await sleep(500);
  await reopen(swPage, "fresh");
  const regs = await swPage.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  check("using that site in a container removes its service worker from normal tabs", regs === 0, regs);
  check("...and stops normal tabs registering a new one", (await register(swPage)) === "SecurityError", await register(swPage));

  // --- Phase 2: rule budget -----------------------------------------------------------
  const spare = await sw.evaluate(() => globalThis.mac.createContainer("Spare", "grey"));
  const used = (await sw.evaluate(() => globalThis.mac.rules())).length;
  await sw.evaluate((n) => globalThis.mac.setLimits({ total: n }), used);
  const refused = await sw.evaluate((url, id) => globalThis.mac.openTab(url, id).then(() => "opened", (e) => e.message), u("a", "/page?spare"), spare.id);
  await sw.evaluate(() => globalThis.mac.setLimits({ total: 5000 }));
  check("a new container tab is refused when Chrome's rule limit is full", /rule limit/.test(refused), refused);

  // --- Idle sign-out (simulated) ---------------------------------------------------------
  await freshInWork.close(); // otherwise Work is still using fresh.localhost when it resets
  const HOUR = 60 * 60_000;
  await p1.bringToFront(); // a background tab can't be clicked; bringing it forward counts as use, so backdate after
  await sleep(300);
  await sw.evaluate((id, ms) => globalThis.mac.backdateUse(id, ms), c1.id, 5 * HOUR);
  await p1.mouse.click(5, 5);
  await sleep(300);
  await sw.evaluate((id, ms) => globalThis.mac.backdateUse(id, ms), c2.id, 3 * HOUR);
  check("nothing used within the 4-hour default is signed out", (await sw.evaluate(() => globalThis.mac.resetIdleContainers())).length === 0);
  await sw.evaluate((id, ms) => globalThis.mac.backdateUse(id, ms), c2.id, 4 * HOUR + 60_000);
  await get(p2, "/echo"); // a page's own background request isn't use
  const reset = await sw.evaluate(() => globalThis.mac.resetIdleContainers());
  check("a container unused for 4 hours is signed out, despite its page's background requests", reset.includes("Work"), reset);
  check("a click in a container's page counts as use", !reset.includes((await containerNamed(c1.id)).name), reset);
  await reopen(p2, "a");
  const afterReset = await p2.evaluate(() => ({ server: window.__serverCookie, ls: localStorage.getItem("who"), early: window.__early.cookie }));
  check("after a reset the container is signed out of cookies and site storage",
    afterReset.server === "" && afterReset.ls === null && afterReset.early === "", afterReset);
  check("the reset container keeps its name", (await containerNamed(c2.id)).name === "Work", await containerNamed(c2.id));
  check("other containers are untouched by the reset", (await echo(p1)).includes("sid=one"), await echo(p1));
  await reopen(swPage, "fresh");
  check("a site only the reset container had used gets its service workers back in normal tabs",
    (await register(swPage)) === "registered", await register(swPage));
  await reopen(dflt, "a");
  check("a site another container still uses stays protected", (await register(dflt)) === "SecurityError", await register(dflt));

  const rules = await sw.evaluate(() => globalThis.mac.rules());
  measure("session rules installed", { total: rules.length, regex: rules.filter((r) => r.condition.regexFilter).length });
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  server.close();
}

await mkdir("test-results", { recursive: true });
await writeFile("test-results/e2e.json", JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.kind === "check" && !r.ok).length;
console.log(`\n${results.filter((r) => r.kind === "check").length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
