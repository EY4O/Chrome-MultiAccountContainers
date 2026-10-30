// Launches your installed Chrome on a throwaway profile folder that shares
// nothing with your real profile. Installed Chrome (not Chrome for Testing) is
// the point: only it has Chrome's own Google sign-in, which is part of what
// we're testing.

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer";

export const PROFILE = resolve(process.env.SANDBOX_PROFILE ?? ".sandbox-profile");
export const CHROME = process.env.CHROME_STABLE ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const DIST = resolve("dist");

/** Chrome holds `lockfile` open while the profile is in use. */
async function isRunning() {
  try {
    await rm(join(PROFILE, "lockfile"), { force: true });
    return false;
  } catch {
    return true;
  }
}

export async function assertNotRunning() {
  if (await isRunning()) throw new Error("The sandbox Chrome is still open. Close it first.");
}

export function spawnChrome(args) {
  const child = spawn(CHROME, [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const isWorker = (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://");

/**
 * Our extension's worker. Other extensions (Google Docs Offline, added with a
 * Google sign-in) also name theirs background.js, so check the manifest.
 */
async function findOurWorker(browser) {
  for (const t of browser.targets().filter(isWorker)) {
    const w = await t.worker().catch(() => null);
    const ours = await w?.evaluate(() => chrome.runtime.getManifest().content_scripts?.some((c) => c.js?.includes("content-main.js"))).catch(() => false);
    if (ours) return t;
  }
  return null;
}

async function waitForOurWorker(browser, timeout) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    const t = await findOurWorker(browser);
    if (t) return t;
  }
  return null;
}

/**
 * Starts the sandbox with a localhost-only debugging port and connects to it.
 * No automation flags are set, so sites see an ordinary Chrome.
 */
export async function launch({ restore = false } = {}) {
  await assertNotRunning();
  const port = await freePort();
  spawnChrome([`--remote-debugging-port=${port}`, ...(restore ? ["--restore-last-session"] : [])]);

  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null);
    if (!browser) await sleep(500);
  }
  if (!browser) throw new Error("Chrome did not open its debugging port.");

  let target = await waitForOurWorker(browser, 5000);
  if (!target) {
    // An idle worker isn't listed; a new tab wakes it.
    const page = await browser.newPage();
    target = await waitForOurWorker(browser, 10_000);
    await page.close();
  }
  if (!target) {
    await close(browser);
    throw new Error(`The extension isn't loaded in the sandbox. Run \`npm run sandbox\` and load ${DIST} with Load unpacked.`);
  }
  let sw = await target.worker();

  // Chrome caches an unpacked extension's worker across restarts, so a fresh
  // build only runs after a reload.
  const { buildId } = JSON.parse(await readFile(join(DIST, "build.json"), "utf8"));
  if ((await sw.evaluate(() => globalThis.mac?.buildId).catch(() => null)) !== buildId) {
    try {
      await sw.evaluate(() => chrome.runtime.reload()).catch(() => {}); // the worker dies mid-call
      const fresh = await browser.waitForTarget((t) => t.url() === target.url() && t !== target, { timeout: 15_000 });
      sw = await fresh.worker();
      if ((await sw.evaluate(() => globalThis.mac?.buildId)) !== buildId) throw new Error("Extension reload did not pick up the new build.");
    } catch (e) {
      await close(browser);
      throw e;
    }
  }
  await sw.evaluate(() => globalThis.mac.scheduleSync());
  return { browser, sw };
}

/** Closes Chrome the normal way (so the session is saved) and waits for it to exit. */
export async function close(browser) {
  await browser.close().catch(() => {});
  for (let i = 0; i < 40 && (await isRunning()); i++) await sleep(500);
}
