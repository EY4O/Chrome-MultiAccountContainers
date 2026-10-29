// Helpers shared by the sandbox scenario scripts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export async function loadConfig() {
  return JSON.parse(await readFile(new URL("./scenarios.json", import.meta.url), "utf8").catch(() => {
    console.error("Missing sandbox/scenarios.json. Copy scenarios.example.json and fill it in.");
    process.exit(2);
  }));
}

/** PASS/FAIL/INFO lines on the console, saved to test-results/<file> at the end. */
export function report() {
  const results = [];
  return {
    check(name, ok, detail) {
      results.push({ kind: "check", name, ok: Boolean(ok), detail });
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
      return Boolean(ok);
    },
    info(name, detail) {
      results.push({ kind: "info", name, detail });
      console.log(`INFO  ${name}: ${JSON.stringify(detail)}`);
    },
    async finish(file) {
      await mkdir("test-results", { recursive: true });
      await writeFile(`test-results/${file}`, JSON.stringify(results, null, 2));
      const checks = results.filter((r) => r.kind === "check");
      const failed = checks.filter((r) => !r.ok).length;
      console.log(`\n${checks.length - failed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    },
  };
}

export const hostOf = (url) => new URL(url).hostname;

/**
 * Which configured accounts this page shows. `site.scope` narrows where to
 * look, for pages that also show other people's names (a shared chat, an
 * email thread): "title", or a CSS selector for the signed-in account's own
 * area. Without it: title, visible text and meta tags.
 */
export async function accountsShown(page, site) {
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20_000 }).catch(() => {});
  // Heavy apps keep painting after the network settles (Gmail's loading screen
  // is titled just "Gmail"), so keep looking for a while before saying "none".
  const deadline = Date.now() + (site.settleMs ?? 15_000);
  let shown;
  do {
    await sleep(1000);
    shown = await readAccounts(page, site);
  } while (!shown.length && Date.now() < deadline);
  return shown;
}

async function readAccounts(page, site) {
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

export async function openInContainer(browser, sw, url, containerId) {
  // Sites spawn workers and frames as targets too; wait for the new tab itself.
  const before = new Set(browser.targets());
  await sw.evaluate((u, id) => globalThis.mac.openTab(u, id), url, containerId);
  const target = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 15_000 });
  return target.page();
}

export async function openNormal(browser, url) {
  const page = await browser.newPage();
  await sleep(700); // a tab opened next to a container tab is held for 500 ms
  await page.goto(url).catch(() => {}); // site redirects can abort the initial goto
  return page;
}

let probes = 0;

/** Tab id, container and tab-group title of the tab behind a Puppeteer page, found by a unique title. */
export async function tabInfoOfPage(sw, page) {
  const probe = `mac-probe-${++probes}-${Date.now()}`;
  const original = await page.title().catch(() => "");
  await page.evaluate((t) => { document.title = t; }, probe).catch(() => {});
  await sleep(200);
  const info = await sw.evaluate(async (t) => {
    const [tab] = await chrome.tabs.query({ title: t });
    if (!tab) return { tabId: undefined, containerId: undefined, groupId: -1, group: null };
    const group = tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? null : await chrome.tabGroups.get(tab.groupId);
    return { tabId: tab.id, containerId: globalThis.mac.containerOfTab(tab.id) ?? null, groupId: tab.groupId, group: group?.title ?? null };
  }, probe);
  await page.evaluate((t) => { document.title = t; }, original).catch(() => {});
  return info;
}
