// Restart scenario: a container tab and a default tab are open, Chrome is
// closed normally, then relaunched with session restore on the same profile.
// Run `npm run build` first.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer";
import { start } from "../harness/server.mjs";

const PORT = 8787;
const u = (host, path) => `http://${host}.localhost:${PORT}${path}`;
const enc = encodeURIComponent;

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

const profile = await mkdtemp(join(tmpdir(), "mac-restart-"));
const server = await start(PORT);
// --load-extension (Chrome for Testing only) makes the extension part of the
// profile at startup, like a real install. Puppeteer's enableExtensions list
// loads it over CDP after startup, by which time restored tabs have loaded.
const launch = (args = []) =>
  puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    pipe: true,
    userDataDir: profile,
    enableExtensions: true,
    executablePath: process.env.CHROME_PATH,
    args: [`--disable-extensions-except=${resolve("dist")}`, `--load-extension=${resolve("dist")}`, ...args],
  });
const workerOf = async (browser) =>
  (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"))).worker();

try {
  // --- First session ---------------------------------------------------------
  let browser = await launch();
  let sw = await workerOf(browser);
  await sw.evaluate(() => globalThis.mac.scheduleSync());
  const work = await sw.evaluate(() => globalThis.mac.createContainer("Work", "red"));

  const dflt = (await browser.pages())[0];
  await dflt.goto(u("a", "/page?tab=default"));
  await dflt.evaluate(async (c) => {
    await fetch(`/set?c=${c}`);
    localStorage.setItem("who", "default");
  }, enc("sid=default; Path=/; Max-Age=3600"));

  const workUrl = u("a", "/page?tab=work");
  await sw.evaluate((url, id) => globalThis.mac.openTab(url, id), workUrl, work.id);
  const workPage = await (await browser.waitForTarget((t) => t.url() === workUrl)).page();
  await workPage.waitForFunction(() => document.readyState === "complete");
  await workPage.evaluate(async (a, b) => {
    await fetch(`/set?c=${a}&c=${b}`);
    localStorage.setItem("who", "work");
  }, enc("sid=work; Path=/; Max-Age=3600"), enc("sess=1; Path=/"));
  await sleep(500); // let the tab group and jar writes land
  await browser.close();

  // --- Restart ---------------------------------------------------------------
  browser = await launch(["--restore-last-session"]);
  sw = await workerOf(browser);

  const pageWith = async (marker) => {
    const target = await browser.waitForTarget((t) => t.url().includes(marker), { timeout: 15_000 });
    const page = await target.page();
    // The restored tab's first load is blocked by the lockdown and replayed.
    await page.waitForFunction(() => window.__serverCookie !== undefined, { timeout: 15_000 });
    return page;
  };
  const restoredWork = await pageWith("tab=work");
  const restoredDefault = await pageWith("tab=default");

  const stats = await sw.evaluate(() => ({ ...globalThis.mac.stats }));
  check("the Work tab is restored into its container", stats.restoredIntoContainers >= 1, stats);
  const workCookie = await restoredWork.evaluate(() => window.__serverCookie);
  check("restored Work tab is signed in as Work", workCookie.includes("sid=work") && !workCookie.includes("default"), workCookie);
  check("session cookie survives because the session was restored", workCookie.includes("sess=1"), workCookie);
  check("restored Work tab keeps its localStorage",
    (await restoredWork.evaluate(() => localStorage.getItem("who"))) === "work",
    await restoredWork.evaluate(() => localStorage.getItem("who")));
  const defaultCookie = await restoredDefault.evaluate(() => window.__serverCookie);
  check("restored default tab is still the default identity", defaultCookie === "sid=default", defaultCookie);

  const real = (await browser.cookies()).map((c) => `${c.name}=${c.value}`);
  check("nothing leaked into the real cookie store during startup", real.join() === "sid=default", real);
  const dynamic = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  check("lockdown rule is installed", stats.lockdown && dynamic.some((r) => r.action.type === "block"), { stats, dynamic });

  await browser.close();
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
