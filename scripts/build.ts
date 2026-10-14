// Builds dist/public, the static root served by Workers Static Assets and by the Node server:
//   recorder.js, dashboard/ (pages, styles, bundles), demo/ (the demo shop).
// Usage: node scripts/build.ts [--watch]
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist/public");
const DASH_SRC = path.join(ROOT, "src/dashboard");
const DEMO_SRC = path.join(ROOT, "demo");
const watch = process.argv.includes("--watch");

function copyStatic(): void {
  fs.mkdirSync(path.join(OUT, "dashboard"), { recursive: true });
  for (const f of fs.readdirSync(DASH_SRC)) {
    if (/\.(html|css)$/.test(f)) fs.copyFileSync(path.join(DASH_SRC, f), path.join(OUT, "dashboard", f));
  }
  fs.cpSync(DEMO_SRC, path.join(OUT, "demo"), { recursive: true });
}

const configs: esbuild.BuildOptions[] = [
  {
    entryPoints: [path.join(ROOT, "src/recorder/index.ts")],
    outfile: path.join(OUT, "recorder.js"),
    bundle: true,
    format: "iife",
    globalName: "ReplayOwl",
    minify: true,
    sourcemap: true,
    target: ["es2019", "chrome80"],
  },
  {
    entryPoints: ["list", "replay", "login"].map((n) => path.join(DASH_SRC, n + ".ts")),
    outdir: path.join(OUT, "dashboard"),
    bundle: true,
    format: "esm",
    minify: true,
    sourcemap: true,
    target: ["es2022"],
  },
];

fs.rmSync(OUT, { recursive: true, force: true });
copyStatic();

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context({ ...c, logLevel: "info" });
    await ctx.watch();
  }
  for (const dir of [DASH_SRC, DEMO_SRC]) fs.watch(dir, { recursive: true }, () => copyStatic());
  console.log("watching for changes");
} else {
  await Promise.all(configs.map((c) => esbuild.build({ ...c, logLevel: "warning" })));
  console.log("built " + path.relative(ROOT, OUT));
}
