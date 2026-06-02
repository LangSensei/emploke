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
 * Enforced invariants on every SPLIT (from `docs/pkg-template.md §
 * Hard rules`):
 *
 *   - Rule #2 — SPLIT subdir MUST NOT contain `index.ts` /
 *     `index.tsx` (the facade is the only public entry).
 *   - Rule #5a (no nesting) — a SPLIT subdir MUST NOT recursively
 *     contain another SPLIT (i.e. no descendant `.ts` / `.tsx` file
 *     whose basename equals a sibling subdir under the SPLIT).
 *   - "Every SPLIT must be empty-OK-only-if-empty" — every SPLIT
 *     subdir contains at least one `.ts` / `.tsx` file.
 *   - `REQUIRED_SPLITS` is the *exact* set of on-disk SPLITs.
 *     Forgetting to register a new split (silent loss of the
 *     facade-deletion guard) fails as loudly as forgetting to
 *     deregister a collapsed split. Asserted with set-equality.
 *   - `EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION` is a
 *     snapshot of every CATEGORY dir present when this convention
 *     was introduced. Every snapshot entry MUST still classify as
 *     CATEGORY today (silent promotion to SPLIT — by someone adding
 *     a sibling `<name>.ts` file — fails the test). New packages may
 *     add fresh CATEGORY dirs without updating the snapshot; the
 *     snapshot is a lower bound on which dirs must stay CATEGORY,
 *     not a registry of every CATEGORY in existence.
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
 * Snapshot of every CATEGORY-classified subdir present at the time
 * the convention was introduced (PR #250). Every entry MUST still
 * classify as CATEGORY (no silent promotion to SPLIT).
 *
 * Lower-bound semantics: new packages can freely add new CATEGORY
 * dirs without touching this list. The snapshot only protects the
 * surveyed-at-introduction set from regressing. Remove an entry only
 * when the dir is intentionally promoted to SPLIT (in which case it
 * must also be added to `REQUIRED_SPLITS`) or physically deleted.
 *
 * Coverage at introduction: 28 dirs across catalog, cli, core,
 * dashboard, runtime, server, terminal — i.e. every CATEGORY the
 * classifier sees on PR #250's HEAD.
 */
const EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION = new Set<string>([
  "packages/catalog/src/agent",
  "packages/catalog/src/facade",
  "packages/catalog/src/fetcher",
  "packages/catalog/src/mcp",
  "packages/catalog/src/skill",
  "packages/cli/src/commands",
  "packages/api/src/wiring",
  "packages/dashboard/src/api",
  "packages/dashboard/src/components",
  "packages/dashboard/src/components/agents",
  "packages/dashboard/src/components/schedules",
  "packages/dashboard/src/components/sessions",
  "packages/dashboard/src/components/task-view",
  "packages/dashboard/src/components/tasks",
  "packages/dashboard/src/components/viewers",
  "packages/dashboard/src/hooks",
  "packages/dashboard/src/mocks",
  "packages/dashboard/src/mocks/fixtures",
  "packages/dashboard/src/mocks/fixtures/artifacts",
  "packages/dashboard/src/pages",
  "packages/dashboard/src/pages/Runtime",
  "packages/dashboard/src/utils",
  "packages/runtime/src/copilot",
  "packages/server/src/log",
  "packages/server/src/middleware",
  "packages/server/src/routes",
  "packages/server/src/routes/catalog",
  "packages/terminal/src/platforms",
]);

/**
 * Positive registry of subdirs that MUST classify as SPLIT.
 *
 * Set-equality semantics: this set must equal the disk SPLIT set
 * exactly. Forgetting to register a new SPLIT silently demotes the
 * subdir to CATEGORY and the no-barrel / no-nesting rules would
 * stop applying — exactly the regression this registry catches.
 * Conversely, leaving a stale entry around after collapsing a SPLIT
 * back into a flat file fails the "REQUIRED_SPLITS entry must still
 * classify as SPLIT" check below.
 *
 * Add an entry here whenever a new service is split via the
 * convention. Remove an entry when the SPLIT is collapsed back
 * into the facade.
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

  it("REQUIRED_SPLITS equals the on-disk SPLIT set (no orphans, no forgotten registrations)", () => {
    const diskSplits = new Set(splits.map((s) => s.relPath));
    const orphanSplits = [...diskSplits].filter((p) => !REQUIRED_SPLITS.has(p));
    const missingSplits = [...REQUIRED_SPLITS].filter((p) => !diskSplits.has(p));
    const messages: string[] = [];
    for (const extraSplit of orphanSplits) {
      messages.push(
        `${extraSplit} — on-disk SPLIT not registered in REQUIRED_SPLITS. Add this path to REQUIRED_SPLITS in packages/task/test/split-convention.test.ts so future facade-deletion is caught (see Judge Z PR #250 review).`,
      );
    }
    for (const missing of missingSplits) {
      const found = all.find((d) => d.relPath === missing);
      if (!found) {
        messages.push(
          `${missing} — REQUIRED_SPLITS expects this subdir to exist but it was not found on disk. Either restore the facade + subdir or remove the REQUIRED_SPLITS entry.`,
        );
      } else {
        messages.push(
          `${missing} — REQUIRED_SPLITS expects a sibling facade file (${path.basename(
            missing,
          )}.ts or .tsx) at the parent level, but none was found. The facade is the public entry; without it the subdir is orphaned. Restore the facade or, if the split was intentionally collapsed, remove the subdir and the REQUIRED_SPLITS entry together.`,
        );
      }
    }
    expect(messages, messages.join("\n")).toEqual([]);
  });

  it("EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION: every snapshot entry still classifies as CATEGORY", () => {
    const regressions: string[] = [];
    for (const rel of EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION) {
      const found = all.find((d) => d.relPath === rel);
      if (!found) {
        // Disappeared. The dir was deleted or renamed since the
        // snapshot. Either is acceptable — but the snapshot must
        // be kept in lock-step, so flag it.
        regressions.push(
          `${rel} — listed in EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION but no longer present on disk. If the dir was intentionally removed or renamed, drop the snapshot entry in the same PR. See docs/pkg-template.md § Migration of existing big files (Registry maintenance).`,
        );
        continue;
      }
      if (found.kind !== "CATEGORY") {
        regressions.push(
          `${rel} — snapshot says this is CATEGORY but a sibling file ${path.basename(
            found.siblingFile ?? "",
          )} now exists, which silently promoted it to SPLIT. If the promotion is intentional, remove it from EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION AND add the path to REQUIRED_SPLITS (and follow the SPLIT hard rules from docs/pkg-template.md). If unintentional, rename the sibling file to avoid the collision.`,
        );
      }
    }
    expect(regressions, regressions.join("\n")).toEqual([]);
  });

  it("hard rule #5a — no nested SPLITs (a SPLIT must not contain another SPLIT)", () => {
    const violations: string[] = [];
    for (const split of splits) {
      // Walk every descendant directory of the SPLIT (respecting the
      // same skip rules as the top-level classifier) and check
      // whether any of them is itself classified as SPLIT.
      const descendants: string[] = [];
      walkSrcDirs(split.absPath, descendants);
      for (const descAbs of descendants) {
        const classification = classifyDir(descAbs);
        if (classification.kind === "SPLIT") {
          violations.push(
            `${classification.relPath} — nested SPLIT inside ${split.relPath} (sibling ${path.basename(
              classification.siblingFile ?? "",
            )}). docs/pkg-template.md hard rule #5a forbids nesting: keep at one level of splitting and decompose the concern itself instead.`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
