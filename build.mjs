import { cp, mkdir, rm } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("static", outdir, { recursive: true });

const common = { bundle: true, target: "chrome121", outdir, logLevel: "info", sourcemap: "inline" };
const builds = [
  { ...common, entryPoints: { background: "src/background/index.ts" }, format: "esm" },
  {
    ...common,
    entryPoints: {
      "content-main": "src/content/main.ts",
      "content-isolated": "src/content/isolated.ts",
      popup: "src/popup/popup.ts",
    },
    format: "iife",
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
