import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural enforcement of the "facade + sibling subdir" split
 * convention documented in `docs/pkg-template.md § Splitting big
 * files via facade + sibling subdir`.
 *
 * Algorithm: walk every directory under `packages/<pkg>/src/**` and
 * classify it:
 *
 *   - SPLIT    — a sibling file `<X>.ts` OR `<X>.tsx` exists at the
 *                parent level (exact case match). The subdir is part
 *                of a facade-split and must not contain a barrel.
 *   - CATEGORY — no sibling file at the parent level. The subdir is
 *                a categorical container (e.g. `routes/`,
 *                `components/`, per-entity subfolders like `agent/`).
 *                These follow a different, pre-existing convention
 *                and are NOT subject to this rule.
 *
 * The only enforced invariant is hard rule #2 from the docs: a SPLIT
 * subdir must NOT contain `index.ts` or `index.tsx` — the facade is
 * the only public entry; internals are imported directly via
 * relative paths.
 *
 * Case policy: sibling matching is exact-case (because Linux CI is
 * case-sensitive). On Windows / macOS the filesystem is typically
 * case-insensitive but `readdirSync` preserves the on-disk casing, so
 * the equality check still behaves consistently across platforms.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

const SKIP_DIR_NAMES = new Set(["node_modules", "__tests__", "drizzle", "migrations", "dist"]);

/**
 * Documentation-only: subdirs known to be CATEGORY (no sibling file
 * at the parent level). The classifier handles them automatically —
 * this list exists to explain the surveyed shape of the repo to
 * future readers and to make accidental regressions (e.g. someone
 * adds `routes.ts` next to `routes/` and unintentionally turns it
 * into a SPLIT) easier to spot in code review.
 */
const KNOWN_CATEGORY_DIRS = new Set<string>([
  "packages/catalog/src/agent",
  "packages/catalog/src/skill",
  "packages/catalog/src/mcp",
  "packages/catalog/src/facade",
  "packages/catalog/src/fetcher",
  "packages/cli/src/commands",
  "packages/dashboard/src/api",
  "packages/dashboard/src/components",
  "packages/dashboard/src/pages",
  "packages/server/src/routes",
]);

/**
 * Positive registry of subdirs that MUST classify as SPLIT. Lists
 * facade-split subdirs whose sibling facade file is load-bearing —
 * deleting the facade silently demotes the subdir to CATEGORY and
 * the no-barrel rule would no longer apply, which is exactly the
 * regression this check catches. Add an entry here whenever a new
 * service is split via the convention.
 */
const REQUIRED_SPLITS = new Set<string>([
  "packages/task/src/task-service",
  "packages/dashboard/src/components/tasks/TaskDetail",
]);

interface ClassifiedDir {
  readonly absPath: string;
  readonly relPath: string;
  readonly kind: "SPLIT" | "CATEGORY";
  readonly siblingFile: string | null;
}

function classifyDir(absPath: string): ClassifiedDir {
  const parent = path.dirname(absPath);
  const name = path.basename(absPath);
  const siblingCandidates = [`${name}.ts`, `${name}.tsx`];
  let siblingFile: string | null = null;
  for (const cand of siblingCandidates) {
    const candAbs = path.join(parent, cand);
    try {
      const entries = readdirSync(parent, { withFileTypes: true });
      const match = entries.find((e) => e.isFile() && e.name === cand);
      if (match) {
        siblingFile = candAbs;
        break;
      }
    } catch {
      // parent unreadable; treat as CATEGORY (no sibling)
    }
  }
  return {
    absPath,
    relPath: path.relative(REPO_ROOT, absPath).split(path.sep).join("/"),
    kind: siblingFile ? "SPLIT" : "CATEGORY",
    siblingFile,
  };
}

function walkSrcDirs(srcRoot: string, acc: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(srcRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    if (entry.name.startsWith("_")) continue;
    const abs = path.join(srcRoot, entry.name);
    acc.push(abs);
    walkSrcDirs(abs, acc);
  }
}

function collectAllSrcDirs(): ClassifiedDir[] {
  const out: ClassifiedDir[] = [];
  const pkgs = readdirSync(PACKAGES_DIR, { withFileTypes: true });
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    const srcRoot = path.join(PACKAGES_DIR, pkg.name, "src");
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(srcRoot);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const found: string[] = [];
    walkSrcDirs(srcRoot, found);
    for (const abs of found) out.push(classifyDir(abs));
  }
  return out;
}

describe("facade + sibling subdir splits must not contain a barrel index.ts", () => {
  const all = collectAllSrcDirs();
  const splits = all.filter((d) => d.kind === "SPLIT");

  it("the repo contains at least one SPLIT (sanity check)", () => {
    expect(splits.length).toBeGreaterThan(0);
  });

  it("no SPLIT subdir contains an index.ts or index.tsx barrel", () => {
    const violations: string[] = [];
    for (const split of splits) {
      const entries = readdirSync(split.absPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name === "index.ts" || entry.name === "index.tsx") {
          violations.push(
            `${split.relPath}/${entry.name} — SPLIT subdir (sibling ${path.basename(
              split.siblingFile ?? "",
            )}) must not contain a barrel; facade imports internals directly. See docs/pkg-template.md § Splitting big files via facade + sibling subdir, hard rule #2.`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every SPLIT subdir contains at least one .ts or .tsx file (no empty splits)", () => {
    const empty: string[] = [];
    for (const split of splits) {
      const entries = readdirSync(split.absPath, { withFileTypes: true });
      const hasSource = entries.some(
        (e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")),
      );
      if (!hasSource) {
        empty.push(
          `${split.relPath} — SPLIT subdir is empty; either populate it with concern modules or remove it and inline back into the facade.`,
        );
      }
    }
    expect(empty, empty.join("\n")).toEqual([]);
  });

  it("every entry in REQUIRED_SPLITS classifies as SPLIT (facade sibling still present)", () => {
    const missing: string[] = [];
    for (const rel of REQUIRED_SPLITS) {
      const found = all.find((d) => d.relPath === rel);
      if (!found) {
        missing.push(
          `${rel} — REQUIRED_SPLITS expects this subdir to exist but it was not found on disk.`,
        );
        continue;
      }
      if (found.kind !== "SPLIT") {
        missing.push(
          `${rel} — REQUIRED_SPLITS expects a sibling facade file (${path.basename(rel)}.ts or .tsx) at the parent level, but none was found. The facade is the public entry; without it the subdir is orphaned. Restore the facade or, if the split was intentionally collapsed, remove the subdir and the REQUIRED_SPLITS entry together.`,
        );
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("known CATEGORY dirs surveyed at convention introduction are still CATEGORY", () => {
    const regressions: string[] = [];
    for (const rel of KNOWN_CATEGORY_DIRS) {
      const found = all.find((d) => d.relPath === rel);
      if (!found) continue;
      if (found.kind !== "CATEGORY") {
        regressions.push(
          `${rel} — listed as CATEGORY in KNOWN_CATEGORY_DIRS but a sibling file ${path.basename(
            found.siblingFile ?? "",
          )} now exists, which silently promoted it to SPLIT. If this is intentional, remove it from KNOWN_CATEGORY_DIRS; otherwise rename to avoid the collision.`,
        );
      }
    }
    expect(regressions, regressions.join("\n")).toEqual([]);
  });
});
