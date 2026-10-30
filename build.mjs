import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("static", outdir, { recursive: true });

// Lets the sandbox launcher notice that Chrome is still running an older
// worker: it caches extension worker scripts across restarts.
const buildId = new Date().toISOString();
await writeFile(`${outdir}/build.json`, JSON.stringify({ buildId }));

const common = {
  bundle: true,
  target: "chrome121",
  outdir,
  logLevel: "info",
  sourcemap: "inline",
  define: { __BUILD_ID__: JSON.stringify(buildId) },
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
