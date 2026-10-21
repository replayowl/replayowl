// Builds dist/public, the static root served by Workers Static Assets and by the Node server:
//   recorder.js, dashboard/ (pages, styles, bundles), demo/ (the demo shop).
// Usage: node scripts/build.ts [--watch]. Other packages can import build() to put the same files elsewhere.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASH_SRC = path.join(ROOT, "src/dashboard");
const DEMO_SRC = path.join(ROOT, "demo");

export interface BuildOptions {
  /** Output directory, emptied first. Defaults to dist/public. */
  out?: string;
  watch?: boolean;
  /** Copy the demo shop. */
  demo?: boolean;
}

export async function build(opts: BuildOptions = {}): Promise<void> {
  const out = opts.out || path.join(ROOT, "dist/public");
  const demo = opts.demo !== false;

  const copyStatic = () => {
    fs.mkdirSync(path.join(out, "dashboard"), { recursive: true });
    for (const f of fs.readdirSync(DASH_SRC)) {
      if (/\.(html|css)$/.test(f)) fs.copyFileSync(path.join(DASH_SRC, f), path.join(out, "dashboard", f));
    }
    if (demo) fs.cpSync(DEMO_SRC, path.join(out, "demo"), { recursive: true });
  };

  const configs: esbuild.BuildOptions[] = [
    {
      entryPoints: [path.join(ROOT, "src/recorder/index.ts")],
      outfile: path.join(out, "recorder.js"),
      bundle: true,
      format: "iife",
      globalName: "ReplayOwl",
      minify: true,
      sourcemap: true,
      target: ["es2019", "chrome80"],
    },
    {
      entryPoints: ["list", "replay", "login"].map((n) => path.join(DASH_SRC, n + ".ts")),
      outdir: path.join(out, "dashboard"),
      bundle: true,
      format: "esm",
      minify: true,
      sourcemap: true,
      target: ["es2022"],
    },
  ];

  fs.rmSync(out, { recursive: true, force: true });
  copyStatic();

  if (opts.watch) {
    for (const c of configs) {
      const ctx = await esbuild.context({ ...c, logLevel: "info" });
      await ctx.watch();
    }
    for (const dir of demo ? [DASH_SRC, DEMO_SRC] : [DASH_SRC]) fs.watch(dir, { recursive: true }, () => copyStatic());
    console.log("watching for changes");
  } else {
    await Promise.all(configs.map((c) => esbuild.build({ ...c, logLevel: "warning" })));
    console.log("built " + path.relative(process.cwd(), out));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({ watch: process.argv.includes("--watch") });
}
