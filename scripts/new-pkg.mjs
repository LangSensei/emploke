#!/usr/bin/env node
/**
 * Scaffold a new service package from the `packages/_template/` skeleton.
 *
 * Usage:
 *   pnpm new-pkg <pkg-name> <EntityName> <table_name>
 *
 * Example:
 *   pnpm new-pkg notebook Note notes
 *
 * Side effects:
 *   - Copies `packages/_template/` → `packages/<pkg-name>/`
 *   - Replaces tokens: __PKG__ → pkg-name; __Entity__ → EntityName;
 *     __entity__ → entityName (camelCase); __entities__ → table_name
 *   - Renames file/dir names that contain any of the tokens
 *
 * After scaffolding:
 *   1. pnpm install
 *   2. pnpm --filter @emploke/<pkg-name> db:generate   (regenerates SQL)
 *   3. pnpm --filter @emploke/<pkg-name> test
 */

import { cp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TEMPLATE = path.join(ROOT, "packages", "_template");

const [, , rawPkg, rawEntity, rawTable] = process.argv;

if (!rawPkg || !rawEntity || !rawTable) {
  console.error("usage: pnpm new-pkg <pkg-name> <EntityName> <table_name>");
  console.error("example: pnpm new-pkg notebook Note notes");
  process.exit(2);
}

if (!/^[a-z][a-z0-9-]*$/.test(rawPkg)) {
  console.error(`pkg name must be lowercase kebab-case, got: ${rawPkg}`);
  process.exit(2);
}
if (!/^[A-Z][A-Za-z0-9]*$/.test(rawEntity)) {
  console.error(`EntityName must be PascalCase, got: ${rawEntity}`);
  process.exit(2);
}
if (!/^[a-z][a-z0-9_]*$/.test(rawTable)) {
  console.error(`table_name must be lowercase snake_case, got: ${rawTable}`);
  process.exit(2);
}

const tokens = {
  __PKG__: rawPkg,
  __Entity__: rawEntity,
  __entity__: rawEntity[0].toLowerCase() + rawEntity.slice(1),
  __entities__: rawTable,
  // kebab-case form of the entity name (Note → note, TaskGroup → task-group).
  // Used in file names per the <entity>-<role>.ts convention.
  "__entity-kebab__": rawEntity
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase(),
};

const dest = path.join(ROOT, "packages", rawPkg);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

if (await exists(dest)) {
  console.error(`packages/${rawPkg}/ already exists; refusing to overwrite`);
  process.exit(1);
}

await cp(TEMPLATE, dest, { recursive: true });

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

function replaceTokens(s) {
  let out = s;
  for (const [from, to] of Object.entries(tokens)) {
    out = out.split(from).join(to);
  }
  return out;
}

const files = await walk(dest);
for (const f of files) {
  const content = await readFile(f, "utf8");
  const replaced = replaceTokens(content);
  if (replaced !== content) await writeFile(f, replaced, "utf8");
  // Rename file if its basename contains a token
  const base = path.basename(f);
  const newBase = replaceTokens(base);
  if (newBase !== base) {
    await rename(f, path.join(path.dirname(f), newBase));
  }
}

// Drizzle migration is hand-rolled in the template. The user should
// regenerate it from the schema to get the canonical drizzle-kit hash:
await rm(path.join(dest, "drizzle"), { recursive: true });

console.log(`✓ scaffolded packages/${rawPkg}/`);
console.log("");
console.log("Next steps:");
console.log("  pnpm install");
console.log(`  pnpm --filter @emploke/${rawPkg} db:generate`);
console.log(`  pnpm --filter @emploke/${rawPkg} test`);
