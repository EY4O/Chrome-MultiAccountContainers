// Restart scenario: a container tab and a default tab are open, Chrome is
// closed normally, then relaunched with session restore on the same profile.
// First with keys kept on disk (sign-ins survive), then with keys kept in
// memory (the default; a restart signs containers out). Run `npm run build` first.

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
  check("keys are kept in memory by default", (await sw.evaluate(() => globalThis.mac.settings())).values.keyStorage === "memory");
  await sw.evaluate(() => globalThis.mac.setSetting("keyStorage", "disk"));
  const work = await sw.evaluate(() => globalThis.mac.createContainer("Work", "red"));
  const keyIn = (area) => sw.evaluate(async (area, id) => !!(await chrome.storage[area].get(`key:${id}`))[`key:${id}`], area, work.id);
  check("on disk, the key is in local storage and not session storage", (await keyIn("local")) && !(await keyIn("session")));

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

  // --- Keys in memory: the next restart signs the container out --------------------------
  const storageIdBefore = (await sw.evaluate(() => globalThis.mac.listContainers()))[0].storageId;
  await sw.evaluate(() => globalThis.mac.setSetting("keyStorage", "memory"));
  check("switching to memory moves the key out of local storage", !(await keyIn("local")) && (await keyIn("session")));
  check("switching modes keeps the container signed in for now",
    (await restoredWork.evaluate(async () => (await (await fetch("/echo")).json()).cookie)).includes("sid=work"));
  await sleep(300);
  await browser.close();

  browser = await launch(["--restore-last-session"]);
  sw = await workerOf(browser);
  const signedOut = await pageWith("tab=work");
  const afterStats = await sw.evaluate(() => ({ ...globalThis.mac.stats }));
  check("with keys in memory, the Work tab still comes back into its container", afterStats.restoredIntoContainers >= 1, afterStats);
  const outCookie = await signedOut.evaluate(() => window.__serverCookie);
  check("but it's signed out: no Work cookies", !outCookie.includes("sid=work") && !outCookie.includes("sess=1"), outCookie);
  check("and its old site storage is out of reach", (await signedOut.evaluate(() => localStorage.getItem("who"))) !== "work",
    await signedOut.evaluate(() => localStorage.getItem("who")));
  const storageIdAfter = (await sw.evaluate(() => globalThis.mac.listContainers()))[0].storageId;
  check("its storage prefix was rotated", storageIdAfter && storageIdAfter !== storageIdBefore, { storageIdBefore, storageIdAfter });
  check("the default tab is unaffected", (await (await pageWith("tab=default")).evaluate(() => window.__serverCookie)) === "sid=default");
  const realAfter = (await browser.cookies()).map((c) => `${c.name}=${c.value}`);
  check("still nothing leaked into the real cookie store", realAfter.join() === "sid=default", realAfter);

  await browser.close();
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
