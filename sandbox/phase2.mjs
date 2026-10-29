// Phase 2 features against real sites in the sandbox. Uses the first site in
// scenarios.json (Gmail) and its two containers; never types credentials.
//
// Anything that changes your containers is put back at the end. The rule-limit
// and 30-day-reset checks only touch temporary containers, because a reset of a
// signed-in container is a real sign-out you'd have to undo by hand.

import { setTimeout as sleep } from "node:timers/promises";
import { close, launch } from "./chrome.mjs";
import { accountsShown, loadConfig, openInContainer, openNormal, report, tabInfoOfPage } from "./lib.mjs";

const config = await loadConfig();
const { check, info, finish } = report();
const site = config.sites[0];
const [nameA, nameB] = Object.keys(site.accounts);

let browser;
let sw;
const temporary = [];
let restoreA = null; // { groupId, name, color } to put container A's group back

try {
  ({ browser, sw } = await launch());
  const containers = await sw.evaluate(() => globalThis.mac.listContainers());
  const A = containers.find((c) => c.name === nameA);
  const B = containers.find((c) => c.name === nameB);
  if (!check(`containers "${nameA}" and "${nameB}" exist`, A && B, containers.map((c) => c.name))) throw new Error("missing containers");

  // --- Encryption at rest ----------------------------------------------------
  for (const c of [A, B]) {
    const stored = (await sw.evaluate((id) => chrome.storage.local.get(`jar:${id}`), c.id))[`jar:${c.id}`];
    // Plain-text JSON can't be pure base64 (no quotes or colons), so this rules
    // out cookies stored in the clear; searching the ciphertext for cookie
    // names would match random base64 by chance.
    const sealed = stored?.v === 1 && Object.keys(stored).sort().join() === "data,iv,v" &&
      /^[A-Za-z0-9+/]+=*$/.test(stored.data) && /^[A-Za-z0-9+/]+=*$/.test(stored.iv);
    check(`"${c.name}" cookies are encrypted at rest`, sealed, JSON.stringify(stored ?? null).slice(0, 120));
    const cookies = await sw.evaluate((id) => globalThis.mac.getJar(id).length, c.id);
    info(`"${c.name}" cookies decrypted in memory`, cookies);
  }

  // --- Live group sync: drag a tab between groups ---------------------------
  const pageA = await openInContainer(browser, sw, site.url, A.id);
  const pageB = await openInContainer(browser, sw, site.url, B.id);
  check(`${site.name} in "${nameA}" shows ${nameA}`, (await accountsShown(pageA, site)).join() === nameA);
  const groupA = (await tabInfoOfPage(sw, pageA)).groupId;
  const groupB = (await tabInfoOfPage(sw, pageB)).groupId;

  const mover = await openNormal(browser, site.url);
  const moverId = (await tabInfoOfPage(sw, mover)).tabId;
  check(`a normal ${site.name} tab starts signed out`, (await accountsShown(mover, site)).length === 0);

  // The worker reloads the page the tab is on. A signed-out Gmail tab sits on
  // Google's marketing page, which looks the same signed in or out, so check
  // the switch itself, then open Gmail in that tab as you would.
  const dragTo = async (groupId) => {
    await sw.evaluate((tabId, g) => (g === -1 ? chrome.tabs.ungroup(tabId) : chrome.tabs.group({ tabIds: [tabId], groupId: g })), moverId, groupId);
    await sleep(2000);
    const { containerId } = await tabInfoOfPage(sw, mover);
    await mover.goto(site.url).catch(() => {});
    return { containerId, shown: await accountsShown(mover, site) };
  };
  let moved = await dragTo(groupA);
  check(`dragged into "${nameA}"'s group, the tab is in ${nameA} and Gmail shows ${nameA}`,
    moved.containerId === A.id && moved.shown.join() === nameA, { ...moved, saw: moved.shown.excerpt });
  moved = await dragTo(groupB);
  check(`dragged on into "${nameB}"'s group, it is in ${nameB} and Gmail shows ${nameB}`,
    moved.containerId === B.id && moved.shown.join() === nameB, { ...moved, saw: moved.shown.excerpt });
  moved = await dragTo(-1);
  check("dragged out of any group, it is a normal tab and Gmail is signed out",
    moved.containerId === null && moved.shown.length === 0, { ...moved, saw: moved.shown.excerpt });
  await mover.close();

  // --- Live group sync: rename and recolour ------------------------------------
  const group = await sw.evaluate((g) => chrome.tabGroups.get(g), groupA);
  restoreA = { groupId: groupA, name: A.name, color: A.color };
  const nameOf = async () => (await sw.evaluate((id) => globalThis.mac.listContainers().find((c) => c.id === id), A.id));
  const edit = async (changes) => {
    await sw.evaluate((g, ch) => chrome.tabGroups.update(g, ch), groupA, changes);
    await sleep(700);
  };
  await edit({ title: `${A.name} (renamed)` });
  check("renaming the group renames the container", (await nameOf()).name === `${A.name} (renamed)`, await nameOf());
  await edit({ title: B.name });
  const titleNow = (await sw.evaluate((g) => chrome.tabGroups.get(g), groupA)).title;
  check(`renaming it to "${B.name}" (taken) is put back`, titleNow === `${A.name} (renamed)` && (await nameOf()).name === `${A.name} (renamed)`, titleNow);
  const otherColor = group.color === "cyan" ? "orange" : "cyan";
  await edit({ color: otherColor });
  check("recolouring the group recolours the container", (await nameOf()).color === otherColor, await nameOf());
  await edit({ title: A.name, color: A.color });
  const restored = await nameOf();
  if (check(`"${A.name}" is back to its own name and colour`, restored.name === A.name && restored.color === A.color, restored)) restoreA = null;
  check(`${site.name} in "${nameA}" is still signed in after the edits`, (await accountsShown(pageA, site)).join() === nameA);

  // --- Service workers ------------------------------------------------------------
  const normal = await openNormal(browser, site.url);
  await sleep(1000);
  const sw1 = await normal.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    register: await navigator.serviceWorker.register("/mac-probe-sw.js").then(() => "registered", (e) => e.name),
  }));
  check(`a normal tab on ${new URL(normal.url()).hostname} has no service workers and can't register one`,
    sw1.registrations === 0 && sw1.register === "SecurityError", sw1);
  info("sites kept free of service workers in normal tabs", (await sw.evaluate(() => chrome.storage.local.get("containerOrigins"))).containerOrigins);
  await normal.close();

  // --- Rule limit (temporary container) ------------------------------------------
  const spare = await sw.evaluate(() => globalThis.mac.createContainer("Phase 2 limit test", "grey"));
  temporary.push(spare.id);
  const used = (await sw.evaluate(() => globalThis.mac.rules())).length;
  info("session rules in use", used);
  await sw.evaluate((n) => globalThis.mac.setLimits({ total: n }), used);
  const refused = await sw.evaluate((id) => globalThis.mac.openTab("https://example.com/", id).then(() => "opened", (e) => e.message), spare.id);
  await sw.evaluate(() => globalThis.mac.setLimits({ total: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES }));
  check("opening a tab in another container is refused when the rule limit is full", /rule limit/.test(refused), refused);

  // --- 30-day reset (temporary container, no account) ----------------------------
  const scratch = await sw.evaluate(() => globalThis.mac.createContainer("Phase 2 reset test", "yellow"));
  temporary.push(scratch.id);
  const scratchPage = await openInContainer(browser, sw, "https://www.google.com/", scratch.id);
  await scratchPage.waitForNetworkIdle({ idleTime: 1500, timeout: 20_000 }).catch(() => {});
  await scratchPage.evaluate(() => localStorage.setItem("mac-reset-probe", "before"));
  const before = await sw.evaluate((id) => ({
    storageId: globalThis.mac.listContainers().find((c) => c.id === id).storageId,
    cookies: Object.fromEntries(globalThis.mac.getJar(id).map((c) => [c.name, c.value])),
  }), scratch.id);
  info("anonymous google.com cookies before the reset", Object.keys(before.cookies));
  await sw.evaluate((id) => globalThis.mac.backdateUse(id, 31 * 24 * 60 * 60_000), scratch.id);
  const reset = await sw.evaluate(() => globalThis.mac.resetIdleContainers());
  const rightAfter = await sw.evaluate((id) => ({
    storageId: globalThis.mac.listContainers().find((c) => c.id === id).storageId,
    cookies: globalThis.mac.getJar(id).length,
  }), scratch.id);
  check("only the idle temporary container is reset", reset.length === 1 && reset[0] === scratch.name, reset);
  check("the reset empties its jar and gives it a new storage prefix",
    rightAfter.cookies === 0 && rightAfter.storageId !== before.storageId, { before: before.storageId, rightAfter });
  await sleep(3000); // its tab reloads under the fresh identity
  await scratchPage.waitForNetworkIdle({ idleTime: 1500, timeout: 20_000 }).catch(() => {});
  const probe = await scratchPage.evaluate(() => localStorage.getItem("mac-reset-probe")).catch(() => "unreadable");
  check("site storage written before the reset is no longer reachable", probe === null, probe);
  const after = await sw.evaluate((id) => Object.fromEntries(globalThis.mac.getJar(id).map((c) => [c.name, c.value])), scratch.id);
  // NID and AEC identify the visitor; others (e.g. SEARCH_SAMESITE) hold the
  // same value for everyone.
  const identity = ["NID", "AEC"].filter((name) => name in before.cookies);
  const reused = identity.filter((name) => after[name] === before.cookies[name]);
  check(`the anonymous identity cookies (${identity.join(", ") || "none seen"}) are new after the reset`,
    identity.length > 0 && reused.length === 0, { identity, reused, after: Object.keys(after) });
  const untouched = await sw.evaluate((ids) => globalThis.mac.listContainers().filter((c) => ids.includes(c.id)).map((c) => c.name), [A.id, B.id]);
  check(`"${nameA}" and "${nameB}" were not reset`, (await accountsShown(pageA, site)).join() === nameA &&
    (await accountsShown(pageB, site)).join() === nameB && untouched.length === 2, untouched);
} catch (e) {
  check("run completed", false, String(e?.message ?? e));
} finally {
  if (sw) {
    if (restoreA) {
      await sw.evaluate((g, r) => chrome.tabGroups.update(g, { title: r.name, color: r.color }).catch(() => {}), restoreA.groupId, restoreA).catch(() => {});
    }
    for (const id of temporary) await sw.evaluate((id) => globalThis.mac.deleteContainer(id), id).catch(() => {});
    for (const page of await browser.pages()) {
      if (/^https?:/.test(page.url())) await page.close().catch(() => {});
    }
  }
  if (browser) await close(browser);
}

await finish("sandbox-phase2.json");
