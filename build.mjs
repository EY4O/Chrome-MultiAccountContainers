import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
// `--release` builds the upload package: no test hooks, diagnostics or source
// maps, written to release/ and zipped for the Chrome Web Store.
const release = process.argv.includes("--release");
const outdir = release ? "release/unpacked" : "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("static", outdir, { recursive: true });

// Lets the sandbox launcher notice that Chrome is still running an older
// worker: it caches extension worker scripts across restarts.
const buildId = new Date().toISOString();
if (!release) await writeFile(`${outdir}/build.json`, JSON.stringify({ buildId }));

const common = {
  bundle: true,
  target: "chrome121",
  outdir,
  logLevel: "info",
  sourcemap: release ? false : "inline",
  // Drops the `if (!__RELEASE__)` blocks; names and layout stay readable for review.
  minifySyntax: release,
  define: { __BUILD_ID__: JSON.stringify(buildId), __RELEASE__: String(release) },
};
const builds = [
  { ...common, entryPoints: { background: "src/background/index.ts" }, format: "esm" },
  {
    ...common,
    entryPoints: {
      "content-main": "src/content/main.ts",
      "content-isolated": "src/content/isolated.ts",
      popup: "src/popup/popup.ts",
      prompt: "src/prompt/prompt.ts",
      options: "src/options/options.ts",
    },
    format: "iife",
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}

if (release) {
  const { version } = JSON.parse(await readFile(`${outdir}/manifest.json`, "utf8"));
  const zip = resolve(`release/containers-${version}.zip`);
  await rm(zip, { force: true });
  // manifest.json must sit at the zip's root, so zip the folder's entries, not the folder.
  const entries = await readdir(outdir);
  if (process.platform === "win32") {
    // Windows' own bsdtar writes zips; Git Bash's GNU tar ahead of it on PATH doesn't.
    execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`, ["-a", "-cf", zip, ...entries], { cwd: outdir });
  } else {
    execFileSync("zip", ["-qr", zip, ...entries], { cwd: outdir });
  }
  console.log(`\n  ${zip}`);
}
