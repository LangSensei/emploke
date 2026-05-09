#!/usr/bin/env node
/**
 * Copies the built dashboard SPA from packages/dashboard/dist/ to
 * bundle/static/ so it sits next to bundle/emploke.js. The bundled server
 * looks for `static/` adjacent to its own location at runtime; this script
 * is what puts it there.
 *
 * Standalone (rather than wired into esbuild via a plugin) for two
 * reasons: easier to debug in isolation, and lets `pnpm bundle` run
 * `node esbuild.config.js && node scripts/copy-dashboard.mjs` as two
 * predictable steps with their own logs.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const src = path.join(repoRoot, "packages", "dashboard", "dist");
const dst = path.join(repoRoot, "bundle", "static");

if (!existsSync(src)) {
  console.error(`copy-dashboard: source not found: ${src}`);
  console.error("  run `pnpm --filter @emploke/dashboard build` first.");
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await mkdir(path.dirname(dst), { recursive: true });
await cp(src, dst, { recursive: true });

console.log(`copy-dashboard: ${src} -> ${dst}`);
