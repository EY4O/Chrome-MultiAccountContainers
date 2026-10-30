// Phase 3 end-to-end: the popup UI (opened as a tab, pointed at a target tab
// with ?tab=), container emoji and tab-group titles, hide, reorder, site
// assignments and the prompt page, right-click menus, shortcuts, sync, backup
// and the options page. Run `npm run build` first.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer";
import { start } from "../harness/server.mjs";

const PORT = 8787;
const u = (host, path = "/page") => `http://${host}.localhost:${PORT}${path}`;

const results = [];
function check(name, ok, detail) {
  results.push({ kind: "check", name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

const server = await start(PORT);
const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [resolve("dist")],
  executablePath: process.env.CHROME_PATH,
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
  const sw = await swTarget.worker();
  const ext = new URL(swTarget.url()).host;
  await sw.evaluate(() => globalThis.mac.scheduleSync());

  const mac = (fn, ...args) => sw.evaluate(fn, ...args);
  const tabIdOf = (url) => mac(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, url);
  const containers = () => mac(() => globalThis.mac.listContainers());
  const named = async (name) => (await containers()).find((c) => c.name === name);
  const groupTitleOfTab = (tabId) => mac(async (id) => {
    const t = await chrome.tabs.get(id);
    return t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId));
  }, tabId);

  async function normalTab(url) {
    const page = await browser.newPage();
    await sleep(700);
    await page.goto(url).catch(() => {});
    return page;
  }
  /** Replaces the search text the way typing does (an input event per change). */
  const setSearch = (popup, text) => popup.$eval(".search input", (el, t) => {
    el.value = t;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);

  async function popupFor(page) {
    const tabId = await tabIdOf(page.url());
    const popup = await browser.newPage();
    await sleep(700);
    await popup.goto(`chrome-extension://${ext}/popup.html?tab=${tabId}`);
    await popup.waitForSelector(".view");
    return { popup, tabId };
  }

  // --- Popup: empty state, create with emoji ------------------------------------
  const target = await normalTab(u("a"));
  let { popup, tabId: targetId } = await popupFor(target);
  check("popup shows the empty state with no containers", (await popup.$eval(".empty h2", (e) => e.textContent)) === "No containers yet");
  await popup.click(".empty .btn");
  await popup.waitForSelector("form .input");
  await popup.type("form .input", "Contoso");
  await popup.click('.emoji-pick[aria-label="Use 🏢"]');
  await popup.click('.swatch[data-color="red"]');
  await popup.click('button[type="submit"]');
  await popup.waitForSelector(".list .item");
  const contoso = await named("Contoso");
  check("creating a container in the popup stores its emoji and colour", contoso?.emoji === "🏢" && contoso?.color === "red", contoso);

  await popup.click(".footer .row"); // New container
  await popup.waitForSelector("form .input");
  await popup.type("form .input", "Fabrikam");
  await popup.click('button[type="submit"]');
  await popup.waitForSelector('.item[data-id]:nth-child(2)');
  await popup.click(".footer .row");
  await popup.waitForSelector("form .input");
  await popup.type("form .input", "Contoso");
  await popup.click('button[type="submit"]');
  await popup.waitForSelector("#name-error:not(:empty)");
  check("a duplicate name is refused with a message", /already exists/.test(await popup.$eval("#name-error", (e) => e.textContent)),
    await popup.$eval("#name-error", (e) => e.textContent));
  await popup.keyboard.press("Escape");
  await popup.waitForSelector(".list");

  // --- Search and open -------------------------------------------------------------
  await setSearch(popup, "fab");
  const visible = await popup.$$eval(".item .name > span:first-child", (els) => els.map((e) => e.textContent));
  check("search filters the list", visible.join() === "Fabrikam", visible);
  await setSearch(popup, "zzz");
  check("no match offers to create it", /Create “zzz”/.test(await popup.$eval(".empty .btn", (e) => e.textContent)));
  await setSearch(popup, "conto");
  await popup.focus(".search input");
  const before = new Set(browser.targets());
  await popup.keyboard.press("Enter");
  const opened = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 10_000 });
  await sleep(800);
  const openedId = await mac(async () => (await chrome.tabs.query({ url: "chrome://newtab/" })).at(-1)?.id);
  check("Enter opens a new tab in the first match", openedId && (await mac((id) => globalThis.mac.containerOfTab(id), openedId)) === contoso.id, openedId);
  const group = await groupTitleOfTab(openedId);
  check("its tab group shows the emoji and name", group?.title === "🏢 Contoso" && group?.color === "red", group);
  void opened;

  // --- Edit, rename from the group, hide, reorder -------------------------------------
  ({ popup } = await popupFor(target));
  await popup.click(`.item[data-id="${contoso.id}"] [aria-label="Edit Contoso"]`);
  await popup.waitForSelector("form .input");
  await popup.$eval("form .input", (el) => {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await popup.type("form .input", "Contoso Ltd");
  await popup.click('.emoji-pick[aria-label="Use 🏦"]');
  await popup.click('button[type="submit"]');
  await popup.waitForSelector(".list");
  await sleep(300);
  check("editing in the popup retitles the tab group", (await groupTitleOfTab(openedId))?.title === "🏦 Contoso Ltd", await groupTitleOfTab(openedId));

  const gid = (await groupTitleOfTab(openedId)).id;
  await mac((g) => chrome.tabGroups.update(g, { title: "💼 Contoso" }), gid);
  await sleep(500);
  const renamed = await named("Contoso");
  check("renaming the group with an emoji updates name and emoji", renamed?.emoji === "💼", renamed);

  ({ popup } = await popupFor(target));
  await popup.click(`.item[data-id="${contoso.id}"] [aria-label="Hide Contoso's tabs"]`);
  await sleep(400);
  check("hide collapses the container's tab group", (await groupTitleOfTab(openedId))?.collapsed === true);
  await popup.waitForSelector(`.item[data-id="${contoso.id}"] [aria-label="Show Contoso's tabs"]`);
  await popup.click(`.item[data-id="${contoso.id}"] [aria-label="Show Contoso's tabs"]`);
  await sleep(300);

  await popup.focus(`.item .row[data-id="${contoso.id}"]`);
  await popup.keyboard.down("Alt");
  await popup.keyboard.press("ArrowDown");
  await popup.keyboard.up("Alt");
  await sleep(400);
  check("Alt+Down moves a container down the list", (await containers()).map((c) => c.name).join() === "Fabrikam,Contoso",
    (await containers()).map((c) => c.name));
  await popup.close();

  // --- Site assignments and the prompt page -------------------------------------------
  ({ popup } = await popupFor(target));
  const fab = await named("Fabrikam");
  await popup.select(".assign .select", fab.id);
  await sleep(1500);
  check("assigning this site from the popup moves the tab there",
    (await mac((id) => globalThis.mac.containerOfTab(id), targetId)) === fab.id);
  check("the assignment is stored", (await mac(() => globalThis.mac.listAssignments()))["a.localhost"]?.containerId === fab.id);

  const stray = await normalTab(u("a", "/page?stray"));
  await stray.waitForFunction(() => location.protocol === "chrome-extension:" && document.querySelector("h1")?.textContent.includes("Fabrikam"), { timeout: 10_000 }).catch(() => {});
  const strayUrl = stray.url();
  check("opening an assigned site in a normal tab shows the prompt", strayUrl.startsWith(`chrome-extension://${ext}/prompt.html#http://a.localhost`), strayUrl);
  await stray.click(".actions .btn:not(.filled)"); // Stay here
  await stray.waitForFunction(() => location.host.startsWith("a.localhost"), { timeout: 10_000 });
  const strayId = await tabIdOf(stray.url());
  check("Stay here opens it in the normal tab", !(await mac((id) => globalThis.mac.containerOfTab(id), strayId)), stray.url());
  await stray.goto(u("a", "/page?again")).catch(() => {});
  check("...and that tab isn't asked again", stray.url().startsWith("http://a.localhost"), stray.url());

  const second = await normalTab(u("a", "/page?second"));
  await second.waitForSelector("#remember", { timeout: 10_000 });
  await second.click("#remember");
  await second.click(".actions .btn.filled");
  await second.waitForFunction(() => location.host.startsWith("a.localhost"), { timeout: 10_000 });
  const secondId = await tabIdOf(second.url());
  check("Open in Fabrikam moves the tab into the container", (await mac((id) => globalThis.mac.containerOfTab(id), secondId)) === fab.id);
  check("remember + open switches automatically from now on", (await mac(() => globalThis.mac.listAssignments()))["a.localhost"]?.ask === false);
  const third = await normalTab(u("a", "/page?third"));
  await third.waitForFunction(() => location.host.startsWith("a.localhost"), { timeout: 10_000 }).catch(() => {});
  const thirdId = await tabIdOf(third.url());
  check("the next visit switches without asking", (await mac((id) => globalThis.mac.containerOfTab(id), thirdId)) === fab.id, third.url());

  await mac(() => chrome.runtime.sendMessage === undefined); // keep the worker warm
  const remover = await browser.newPage();
  await remover.goto(`chrome-extension://${ext}/options.html`);
  await remover.evaluate(() => chrome.runtime.sendMessage({ type: "mac:assign", host: "a.localhost", id: null }));
  await sleep(500);
  const free = await normalTab(u("a", "/page?free"));
  check("removing the assignment lets the site open anywhere", free.url().startsWith("http://a.localhost"), free.url());

  // --- Right-click menus and shortcuts --------------------------------------------------
  const menuTab = await mac(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url), free.url());
  const beforeLink = new Set(browser.targets());
  await mac((info, tab) => globalThis.mac.menuClick(info, tab), { menuItemId: `open-link:${contoso.id}`, linkUrl: u("b"), pageUrl: free.url(), editable: false }, menuTab);
  await browser.waitForTarget((t) => t.type() === "page" && t.url() === u("b") && !beforeLink.has(t), { timeout: 10_000 });
  const linkTabId = await tabIdOf(u("b"));
  check("Open link in container opens it there", (await mac((id) => globalThis.mac.containerOfTab(id), linkTabId)) === contoso.id);
  await mac((info, tab) => globalThis.mac.menuClick(info, tab), { menuItemId: `reopen:${fab.id}`, pageUrl: free.url(), editable: false }, menuTab);
  await sleep(1500);
  check("Reopen this tab in container moves it", (await mac((id) => globalThis.mac.containerOfTab(id), menuTab.id)) === fab.id);
  await mac((info, tab) => globalThis.mac.menuClick(info, tab), { menuItemId: "reopen:none", pageUrl: free.url(), editable: false }, menuTab);
  await sleep(1500);
  check("...and No container moves it back", !(await mac((id) => globalThis.mac.containerOfTab(id), menuTab.id)));
  await mac((info, tab) => globalThis.mac.menuClick(info, tab), { menuItemId: `assign:${contoso.id}`, pageUrl: u("c"), editable: false }, menuTab);
  check("Always open this site in sets the assignment", (await mac(() => globalThis.mac.listAssignments()))["c.localhost"]?.containerId === contoso.id);

  const commands = await mac(async () => (await chrome.commands.getAll()).filter((c) => c.shortcut).map((c) => `${c.name}=${c.shortcut}`));
  check("default shortcuts: Ctrl+Period and Ctrl+Shift+1..3",
    commands.some((c) => c.startsWith("_execute_action=") && /Period|\./.test(c)) && commands.filter((c) => /^open-container-[123]=/.test(c)).length === 3, commands);
  const beforeCmd = await mac(async () => (await chrome.tabs.query({})).length);
  await mac(() => globalThis.mac.command("open-container-1"));
  await sleep(800);
  const newest = await mac(async () => (await chrome.tabs.query({})).sort((a, b) => b.id - a.id)[0].id);
  check("open-container-1 opens a tab in the first container",
    (await mac(async () => (await chrome.tabs.query({})).length)) === beforeCmd + 1 &&
    (await mac((id) => globalThis.mac.containerOfTab(id), newest)) === (await containers())[0].id);

  // --- Sync ---------------------------------------------------------------------------------
  await mac(() => globalThis.mac.syncPush());
  const synced = await mac(() => chrome.storage.sync.get(null));
  const item = synced[`c:${contoso.id}`];
  check("containers sync with their emoji and sites, and nothing else",
    item?.name === "Contoso" && item?.emoji === "💼" && item?.assignments?.["c.localhost"] &&
    !JSON.stringify(synced).match(/jar|cookie|storageId|key:/), item);
  await mac(() => chrome.storage.sync.set({
    "c:remote1": { id: "remote1", name: "From laptop", color: "cyan", emoji: "💻", order: 9, updatedAt: Date.now() + 1000, assignments: { "laptop.example": { ask: true } } },
  }));
  await sleep(800);
  const remote = await named("From laptop");
  check("a container synced from elsewhere appears here", remote?.id === "remote1" && remote?.emoji === "💻" &&
    (await mac(() => globalThis.mac.listAssignments()))["laptop.example"]?.containerId === "remote1", remote);
  await mac((id) => chrome.storage.sync.set({ [`c:${id}`]: { id, name: "Contoso Ltd", color: "red", emoji: "🏢", order: 0, updatedAt: Date.now() + 2000, assignments: {} } }), contoso.id);
  await sleep(800);
  check("a rename synced from elsewhere applies here, and retitles its group",
    (await named("Contoso Ltd"))?.emoji === "🏢" && (await groupTitleOfTab(openedId))?.title === "🏢 Contoso Ltd", await groupTitleOfTab(openedId));
  await mac(() => chrome.storage.sync.set({ meta: { deleted: { remote1: Date.now() + 3000 } } }));
  await sleep(800);
  check("a deletion synced from elsewhere applies here", !(await named("From laptop")));

  // --- Backup ---------------------------------------------------------------------------------
  const backup = await remover.evaluate(() => chrome.runtime.sendMessage({ type: "mac:export" }));
  check("export lists containers and sites, with no sign-ins",
    backup.containers.length === 2 && !JSON.stringify(backup).match(/jar|cookie|storageId/), backup);
  backup.containers.push({ id: "imp1", name: "Imported", color: "green", emoji: "📦" });
  backup.assignments["imported.example"] = { containerId: "imp1", ask: true };
  const imported = await remover.evaluate((b) => chrome.runtime.sendMessage({ type: "mac:import", backup: b }), backup);
  check("import adds new containers and sites", imported.added === 1 && (await named("Imported"))?.emoji === "📦", imported);
  const bad = await remover.evaluate(() => chrome.runtime.sendMessage({ type: "mac:import", backup: { nope: true } }));
  check("a file that isn't a backup is refused with a message", /isn't a containers backup/.test(bad?.error ?? ""), bad);

  // --- Options page --------------------------------------------------------------------------
  await remover.reload();
  await remover.waitForSelector(".card");
  const options = await remover.$eval("#app", (e) => e.innerText);
  check("the options page shows sync, backup, shortcuts and privacy",
    /Sync containers/.test(options) && /Export/.test(options) && /Ctrl\+Shift\+1/.test(options) && /30 days/.test(options), options.slice(0, 300));
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  server.close();
}

await mkdir("test-results", { recursive: true });
await writeFile("test-results/e2e-phase3.json", JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.kind === "check" && !r.ok).length;
console.log(`\n${results.filter((r) => r.kind === "check").length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
