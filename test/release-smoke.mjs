// Smoke test for the upload package: loads release/unpacked/ into Chrome for
// Testing and drives it only the way a person can, through its own pages, since
// the release build has no test hook. Run `npm run release` first.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer";
import { start } from "../harness/server.mjs";

const PORT = 8788;
const DIR = resolve("release/unpacked");
const u = (host, path) => `http://${host}.localhost:${PORT}${path}`;

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

// --- The package itself ---------------------------------------------------------
const scripts = (await readdir(DIR)).filter((f) => f.endsWith(".js"));
const sources = await Promise.all(scripts.map((f) => readFile(resolve(DIR, f), "utf8")));
check("no source maps", sources.every((s) => !s.includes("sourceMappingURL")), scripts);
check("no test hook", sources.every((s) => !/backdateUse|setLimits/.test(s)), scripts);
check("no build stamp", !(await readdir(DIR)).includes("build.json"));

// --- In Chrome ------------------------------------------------------------------
const server = await start(PORT);
const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [DIR],
  executablePath: process.env.CHROME_PATH,
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 10_000 },
  );
  const sw = await swTarget.worker();
  check("worker exposes nothing", (await sw.evaluate(() => typeof globalThis.mac)) === "undefined");
  const base = swTarget.url().replace(/\/background\.js$/, ""); // URL.origin is "null" for chrome-extension:

  // The popup is an ordinary extension page; it talks to the worker like the toolbar one does.
  const popup = await browser.newPage();
  await popup.goto(`${base}/popup.html`);
  await popup.waitForSelector("body *");
  const send = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const work = await send({ type: "mac:create", name: "Work", color: "red" });
  check("create a container", work?.id, work);
  const list = await send({ type: "mac:list" });
  check("list shows it", list?.containers?.some((c) => c.id === work.id), list);

  // Sign in inside the container, then look from an ordinary tab.
  const url = u("a", "/page");
  await send({ type: "mac:open", id: work.id, url });
  const inside = await (await browser.waitForTarget((t) => t.url() === url, { timeout: 10_000 })).page();
  await inside.waitForFunction(() => document.readyState === "complete");
  await inside.evaluate((p) => fetch(p), "/set?c=session%3Dwork%3B%20Path%3D%2F");
  await sleep(300);
  const seenInside = (await inside.evaluate(async () => (await fetch("/echo")).json())).cookie;
  check("container keeps its cookie", seenInside.includes("session=work"), seenInside);

  const outside = await browser.newPage();
  await sleep(700);
  await outside.goto(u("a", "/echo"));
  const seenOutside = JSON.parse(await outside.evaluate(() => document.body.innerText)).cookie;
  check("ordinary tab can't see it", !seenOutside.includes("session=work"), seenOutside);

  const options = await browser.newPage();
  await options.goto(`${base}/options.html`);
  await options.waitForFunction(() => document.querySelector("#app")?.children.length > 0, { timeout: 5000 });
  check("settings page renders", true);
} catch (e) {
  check("run without errors", false, String(e));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
