// Scripted checks against real sites in the sandbox profile, using the test
// accounts you signed in to by hand (see open.mjs). Never types credentials;
// if a site wants a sign-in or a code, that check fails and says so.
//
//   1. Each site in each container shows that container's account only.
//   2. A normal tab shows none of the accounts.
//   3. Chrome itself (chrome://signin-internals) knows none of them.
//   4. Chrome is closed and relaunched with session restore; restored tabs keep
//      their accounts, and a fresh normal tab still shows none.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { close, launch } from "./chrome.mjs";

const config = JSON.parse(await readFile(new URL("./scenarios.json", import.meta.url), "utf8").catch(() => {
  console.error("Missing sandbox/scenarios.json. Copy scenarios.example.json and fill it in.");
  process.exit(2);
}));

const results = [];
function check(name, ok, detail) {
  results.push({ kind: "check", name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}
function info(name, detail) {
  results.push({ kind: "info", name, detail });
  console.log(`INFO  ${name}: ${JSON.stringify(detail)}`);
}

const hostOf = (url) => new URL(url).hostname;
const allNeedles = config.sites.flatMap((s) => Object.entries(s.accounts).map(([container, needle]) => ({ container, needle })));

/**
 * Which configured accounts this page shows. `site.scope` narrows where to
 * look, for pages that also show other people's names (a shared chat, an
 * email thread): "title", or a CSS selector for the signed-in account's own
 * area. Without it: title, visible text and meta tags.
 */
async function accountsShown(page, site) {
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20_000 }).catch(() => {});
  await sleep(1500);
  const haystack = await page
    .evaluate((scope) => {
      if (scope === "title") return document.title;
      if (scope) {
        return [...document.querySelectorAll(scope)]
          .flatMap((el) => [el.innerText, ...[...el.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"))])
          .join("\n");
      }
      return [
        document.title,
        document.body?.innerText ?? "",
        ...[...document.querySelectorAll("meta[content]")].map((m) => m.getAttribute("content")),
      ].join("\n");
    }, site.scope)
    .catch(() => "");
  const shown = Object.entries(site.accounts).filter(([, needle]) => haystack.includes(needle)).map(([container]) => container);
  // Kept for failure details; local only (test-results/ is gitignored).
  shown.excerpt = haystack.replace(/\s+/g, " ").slice(0, 160);
  return shown;
}

async function openInContainer(browser, sw, url, containerId) {
  // Sites spawn workers and frames as targets too; wait for the new tab itself.
  const before = new Set(browser.targets());
  await sw.evaluate((u, id) => globalThis.mac.openTab(u, id), url, containerId);
  const target = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 15_000 });
  return target.page();
}

async function openNormal(browser, url) {
  const page = await browser.newPage();
  await sleep(700); // a tab opened next to a container tab is held for 500 ms
  await page.goto(url).catch(() => {}); // site redirects can abort the initial goto
  return page;
}

/** The container and tab-group title of the tab behind a Puppeteer page, found by a unique title. */
async function tabInfoOfPage(sw, page, probe) {
  const original = await page.title().catch(() => "");
  await page.evaluate((t) => { document.title = t; }, probe).catch(() => {});
  await sleep(200);
  const info = await sw.evaluate(async (t) => {
    const [tab] = await chrome.tabs.query({ title: t });
    if (!tab) return { containerId: undefined, group: null };
    const group = tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? null : await chrome.tabGroups.get(tab.groupId);
    return { containerId: globalThis.mac.containerOfTab(tab.id) ?? null, group: group?.title ?? null };
  }, probe);
  await page.evaluate((t) => { document.title = t; }, original).catch(() => {});
  return info;
}

async function chromeKnows(browser, label) {
  const page = await browser.newPage();
  await page.goto("chrome://signin-internals").catch(() => {});
  await sleep(1000);
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  await page.close();
  const known = allNeedles.filter(({ needle }) => text.includes(needle)).map(({ container }) => container);
  check(`${label}: Chrome itself has none of the container accounts (chrome://signin-internals)`, known.length === 0, known);
}

const opened = [];
let browser;
let sw;
try {
  // --- Live session ----------------------------------------------------------
  ({ browser, sw } = await launch());
  const containers = await sw.evaluate(() => globalThis.mac.listContainers());
  const idOf = (name) => containers.find((c) => c.name === name)?.id;

  for (const site of config.sites) {
    for (const container of Object.keys(site.accounts)) {
      const id = idOf(container);
      check(`container "${container}" exists`, id, containers.map((c) => c.name));
      if (!id) continue;
      const page = await openInContainer(browser, sw, site.url, id);
      opened.push(page);
      const shown = await accountsShown(page, site);
      check(`${site.name}: "${container}" shows only its own account`, shown.length === 1 && shown[0] === container,
        { shown, saw: shown.excerpt, url: page.url() });
    }
    const normal = await openNormal(browser, site.url);
    opened.push(normal);
    const shown = await accountsShown(normal, site);
    check(`${site.name}: a normal tab shows none of the accounts`, shown.length === 0, { shown, saw: shown.excerpt, url: normal.url() });
  }
  await chromeKnows(browser, "before restart");
  info("worker stats", await sw.evaluate(() => ({ ...globalThis.mac.stats })));

  // --- Restart with session restore -----------------------------------------
  await close(browser);
  ({ browser, sw } = await launch({ restore: true }));
  await sleep(5000); // restored tabs are blocked, then replayed once assigned
  info("restored tabs", await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({
    url: t.url?.slice(0, 60), container: globalThis.mac.containerOfTab(t.id) ?? null, status: t.status, discarded: t.discarded,
  }))));
  info("restored pages seen by the test", (await browser.pages()).map((p) => p.url().slice(0, 60)));

  let probe = 0;
  const cameBack = new Set();
  for (const page of await browser.pages()) {
    const url = page.url();
    if (!/^https?:/.test(url)) continue;
    const { containerId, group } = await tabInfoOfPage(sw, page, `mac-probe-${++probe}`);
    const container = containers.find((c) => c.id === containerId)?.name ?? null;
    if (containers.some((c) => c.name === group)) {
      check(`after restart, the tab in group "${group}" is in that container`, container === group, { container, url });
    }
    const site = config.sites.find((s) => hostOf(url) === hostOf(s.url));
    if (!site) continue;
    if (container) cameBack.add(`${site.name}/${container}`);
    const shown = await accountsShown(page, site);
    const expected = container && site.accounts[container] ? [container] : [];
    check(`after restart, ${site.name} tab (${container ?? "normal"}) shows ${expected.length ? "only its own account" : "no account"}`,
      JSON.stringify(shown) === JSON.stringify(expected), { shown, saw: shown.excerpt, url });
  }
  for (const site of config.sites) {
    for (const container of Object.keys(site.accounts)) {
      check(`after restart, ${site.name} in "${container}" came back on ${hostOf(site.url)}`, cameBack.has(`${site.name}/${container}`), [...cameBack]);
    }
  }
  for (const site of config.sites) {
    const normal = await openNormal(browser, site.url);
    const shown = await accountsShown(normal, site);
    check(`after restart, a fresh normal ${site.name} tab shows none of the accounts`, shown.length === 0, { shown, saw: shown.excerpt, url: normal.url() });
  }
  await chromeKnows(browser, "after restart");
  info("worker stats", await sw.evaluate(() => ({ ...globalThis.mac.stats })));

  // Leave the profile tidy: close what this run opened (restored copies included).
  for (const page of await browser.pages()) {
    if (config.sites.some((s) => /^https?:/.test(page.url()) && hostOf(page.url()) === hostOf(s.url))) await page.close();
  }
} catch (e) {
  check("run completed", false, String(e?.message ?? e));
} finally {
  if (browser) await close(browser);
}

await mkdir("test-results", { recursive: true });
await writeFile("test-results/sandbox.json", JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.kind === "check" && !r.ok).length;
console.log(`\n${results.filter((r) => r.kind === "check").length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
