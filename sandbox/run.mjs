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

/** Which configured accounts this page shows (title, visible text, meta tags). */
async function accountsShown(page, site) {
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20_000 }).catch(() => {});
  await sleep(1500);
  const haystack = await page
    .evaluate(() => [
      document.title,
      document.body?.innerText ?? "",
      ...[...document.querySelectorAll("meta[content]")].map((m) => m.getAttribute("content")),
    ].join("\n"))
    .catch(() => "");
  return Object.entries(site.accounts).filter(([, needle]) => haystack.includes(needle)).map(([container]) => container);
}

async function openInContainer(browser, sw, url, containerId) {
  const created = new Promise((ok) => browser.once("targetcreated", ok));
  await sw.evaluate((u, id) => globalThis.mac.openTab(u, id), url, containerId);
  return (await created).page();
}

async function openNormal(browser, url) {
  const page = await browser.newPage();
  await sleep(700); // a tab opened next to a container tab is held for 500 ms
  await page.goto(url).catch(() => {}); // site redirects can abort the initial goto
  return page;
}

/** The container of the tab behind a Puppeteer page, found by a unique title. */
async function containerOfPage(sw, page, probe) {
  const original = await page.title().catch(() => "");
  await page.evaluate((t) => { document.title = t; }, probe).catch(() => {});
  await sleep(200);
  const containerId = await sw.evaluate(async (t) => {
    const [tab] = await chrome.tabs.query({ title: t });
    return tab ? globalThis.mac.containerOfTab(tab.id) ?? null : undefined;
  }, probe);
  await page.evaluate((t) => { document.title = t; }, original).catch(() => {});
  return containerId;
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
        { shown, url: page.url() });
    }
    const normal = await openNormal(browser, site.url);
    opened.push(normal);
    const shown = await accountsShown(normal, site);
    check(`${site.name}: a normal tab shows none of the accounts`, shown.length === 0, { shown, url: normal.url() });
  }
  await chromeKnows(browser, "before restart");
  info("worker stats", await sw.evaluate(() => ({ ...globalThis.mac.stats })));

  // --- Restart with session restore -----------------------------------------
  await close(browser);
  ({ browser, sw } = await launch({ restore: true }));
  await sleep(5000); // restored tabs are blocked, then replayed once assigned

  let probe = 0;
  for (const page of await browser.pages()) {
    const url = page.url();
    const site = config.sites.find((s) => /^https?:/.test(url) && hostOf(url) === hostOf(s.url));
    if (!site) continue;
    const containerId = await containerOfPage(sw, page, `mac-probe-${++probe}`);
    const container = containers.find((c) => c.id === containerId)?.name ?? null;
    const shown = await accountsShown(page, site);
    const expected = container && site.accounts[container] ? [container] : [];
    check(`after restart, ${site.name} tab (${container ?? "normal"}) shows ${expected.length ? "only its own account" : "no account"}`,
      JSON.stringify(shown) === JSON.stringify(expected), { shown, url });
  }
  for (const site of config.sites) {
    const normal = await openNormal(browser, site.url);
    const shown = await accountsShown(normal, site);
    check(`after restart, a fresh normal ${site.name} tab shows none of the accounts`, shown.length === 0, { shown, url: normal.url() });
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
