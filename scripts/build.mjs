/**
 * Build script — bundles the frontend with esbuild so MeshVault ships its own copy
 * of Three.js and works fully offline (no CDN / importmap dependency).
 *
 * Why a bundle: the app previously loaded Three.js from jsdelivr via an importmap, so
 * it did not work offline and had no Subresource Integrity. esbuild resolves `three`
 * and `three/addons/*` from node_modules, tree-shakes to only what we import, and emits
 * a single self-contained ES module per entry point.
 *
 * Entry points are declared in ENTRIES. The app entry is the full MeshVault UI. A future
 * standalone viewer entry (embeddable, server-less) can be added here with one line and
 * gets the same offline, tree-shaken bundle for free.
 *
 * Usage:  node scripts/build.mjs [--watch]
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const ENTRIES = [
    // Full MeshVault app (talks to the local backend).
    { in: "frontend/js/app.js", out: "frontend/dist/app.bundle.js" },
    // Future: standalone embeddable viewer (no backend) — uncomment once extracted.
    // { in: "frontend/js/viewer/standalone.js", out: "frontend/dist/meshvault-viewer.js" },
];

const watch = process.argv.includes("--watch");

const common = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    sourcemap: true,
    // Keep output readable in dev; minify only for release builds.
    minify: process.env.NODE_ENV === "production",
    logLevel: "info",
    absWorkingDir: root,
};

async function build() {
    const contexts = [];
    for (const e of ENTRIES) {
        const opts = { ...common, entryPoints: [e.in], outfile: e.out };
        if (watch) {
            const ctx = await esbuild.context(opts);
            await ctx.watch();
            contexts.push(ctx);
        } else {
            await esbuild.build(opts);
        }
    }
    if (watch) {
        console.log("esbuild: watching for changes… (Ctrl+C to stop)");
    } else {
        console.log("esbuild: build complete →", ENTRIES.map((e) => e.out).join(", "));
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
