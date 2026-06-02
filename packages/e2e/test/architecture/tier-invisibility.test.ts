/**
 * Structural enforcement of the T_top → T2-contracts fence.
 *
 * Pins the contracts-extraction architecture decision: `@emploke/dashboard`
 * and `@emploke/cli` may only see emploke workspace pkgs through the
 * `@emploke/contracts` surface (with one documented exception: the
 * `emploke` binary IS the server bundle, so `cli/src/commands/serve.ts`
 * is allowed to value-import `@emploke/server`'s `runServer` entry
 * point).
 *
 * The rule applies at two layers:
 *
 *   1. SOURCE: every `import` / `export ... from` specifier of the form
 *      `@emploke/<pkg>` in `packages/{dashboard,cli}/{src,test}/**` must
 *      be in the per-consumer allowlist.
 *
 *   2. MANIFEST: every `workspace:*` entry in `dashboard/package.json`
 *      and `cli/package.json` (dependencies + devDependencies) that
 *      starts with `@emploke/` must be in the per-consumer allowlist.
 *      Catches "the import has been removed but the dep is still
 *      declared in package.json" drift in the opposite direction —
 *      the structural fence is meaningless if pnpm still hoists the
 *      orchestration pkg into the consumer's `node_modules` because
 *      a dangling dep stayed behind.
 *
 * Allowlists (per consumer):
 *
 *   dashboard: { "@emploke/contracts" }
 *     — Browser code. Orchestration value-imports (CatalogService, the
 *       composeApplication factory, db handles) would be runtime
 *       nonsense; even type-imports from `@emploke/api` would couple
 *       the dashboard's static module graph to Node-only modules,
 *       defeating the whole point of having a separate wire-types pkg.
 *
 *   cli:       { "@emploke/contracts", "@emploke/server" }
 *     — The `emploke` binary bundles both the client CLI and the
 *       server boot path; `emploke serve` calls `runServer` from
 *       `@emploke/server` in-process, and `emploke start` just spawns
 *       `emploke serve` as a detached child. That single edge is
 *       legitimate and tightly scoped to `cli/src/commands/serve.ts`.
 *
 * Hosting: lives in `@emploke/e2e/test/architecture/` alongside the
 * other repo-wide architectural audits (`inter-service-imports`,
 * `split-convention`, `test-layout-convention`). The audit is
 * repo-wide and walks `packages/{dashboard,cli}/{src,test}/**` —
 * the fenced consumers it polices.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "drizzle"]);

interface Consumer {
  /** Pkg name under `packages/`. */
  readonly pkg: string;
  /** Set of `@emploke/*` specifiers the consumer is allowed to reference. */
  readonly allowed: ReadonlySet<string>;
}

const CONSUMERS: readonly Consumer[] = [
  {
    pkg: "dashboard",
    allowed: new Set(["@emploke/contracts"]),
  },
  {
    pkg: "cli",
    allowed: new Set(["@emploke/contracts", "@emploke/server"]),
  },
];

interface SourceViolation {
  /** Repo-relative, forward-slash path. */
  readonly file: string;
  readonly specifier: string;
}

interface ManifestViolation {
  readonly consumer: string;
  readonly specifier: string;
  /** Which section it appeared in: `dependencies` or `devDependencies`. */
  readonly section: "dependencies" | "devDependencies";
}

// ── helpers ────────────────────────────────────────────────────────────

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function* walkTsFiles(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      yield* walkTsFiles(path.join(dir, e.name));
    } else if (e.isFile()) {
      if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
        yield path.join(dir, e.name);
      }
    }
  }
}

function relPosix(absFile: string): string {
  return path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
}

/**
 * Extract every `@emploke/*` specifier referenced by a TS / TSX file:
 *   - `import ... from "@emploke/x"` (value or type)
 *   - `export ... from "@emploke/x"` (re-export)
 *   - dynamic `import("@emploke/x")` calls
 *
 * Uses a regex scan (not a full TS parse) deliberately — the rule is
 * "specifier text matches `@emploke/*`", and the same regex catches
 * value and type imports alike. Avoiding the TS API keeps this test
 * an order of magnitude cheaper than `inter-service-imports.test.ts`,
 * which needs AST classification (value vs type) that this audit
 * does not care about.
 *
 * False-positive scope: a `@emploke/x` string appearing inside a
 * string literal that is NOT a module specifier (e.g. a doc comment
 * showing a code example, a console.log) would also match. The
 * audit filters self-references (a pkg mentioning its own name in
 * its own source is at worst a circular-import bug, but it cannot
 * be a fence break — see `collectSourceViolations`); other
 * cross-pkg literal mentions inside doc strings are still
 * surfaced, and the dashboard / cli source trees contain no such
 * cross-pkg literal occurrences as of this writing. If a future PR
 * ever introduces one, surface it as a violation and either
 * rewrite the mention or add an allowlist mechanism then.
 * Over-cautious for now is better than missing real fence breaks.
 */
function extractEmplokeSpecifiers(source: string): string[] {
  const re = /(?:from|import)\s*\(?\s*["'](@emploke\/[A-Za-z0-9_-]+)["']/g;
  const out: string[] = [];
  for (const match of source.matchAll(re)) {
    out.push(match[1] as string);
  }
  return out;
}

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function readManifest(pkg: string): Manifest {
  const abs = path.join(PACKAGES_DIR, pkg, "package.json");
  return JSON.parse(readFileSync(abs, "utf8")) as Manifest;
}

function collectSourceViolations(consumer: Consumer): SourceViolation[] {
  const selfSpec = `@emploke/${consumer.pkg}`;
  const out: SourceViolation[] = [];
  for (const subdir of ["src", "test"] as const) {
    const root = path.join(PACKAGES_DIR, consumer.pkg, subdir);
    if (!safeIsDir(root)) continue;
    for (const absFile of walkTsFiles(root)) {
      const source = readFileSync(absFile, "utf8");
      for (const spec of extractEmplokeSpecifiers(source)) {
        if (spec === selfSpec) continue;
        if (consumer.allowed.has(spec)) continue;
        out.push({ file: relPosix(absFile), specifier: spec });
      }
    }
  }
  return out;
}

function collectManifestViolations(consumer: Consumer): ManifestViolation[] {
  const m = readManifest(consumer.pkg);
  const out: ManifestViolation[] = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = m[section];
    if (!deps) continue;
    for (const [name] of Object.entries(deps)) {
      if (!name.startsWith("@emploke/")) continue;
      if (consumer.allowed.has(name)) continue;
      out.push({ consumer: consumer.pkg, specifier: name, section });
    }
  }
  return out;
}

// ── audits ─────────────────────────────────────────────────────────────

describe("tier-invisibility: T_top fenced consumers see only @emploke/contracts", () => {
  for (const consumer of CONSUMERS) {
    const allowedList = [...consumer.allowed].sort().join(", ");

    it(`${consumer.pkg} src/** + test/** only reference {${allowedList}}`, () => {
      const violations = collectSourceViolations(consumer);
      const msg =
        violations.length === 0
          ? "(none)"
          : violations.map((v) => `  ${v.file} → ${v.specifier}`).join("\n");
      expect(
        violations,
        `Found ${violations.length} disallowed @emploke/* reference(s) in packages/${consumer.pkg}:\n${msg}\n\nAllowed: {${allowedList}}.\nRewire through the allowed surface, or — if introducing a new legitimate edge — update the CONSUMERS allowlist in this file and document the rationale in the top-of-file docstring.`,
      ).toEqual([]);
    });

    it(`${consumer.pkg}/package.json workspace deps ⊆ {${allowedList}}`, () => {
      const violations = collectManifestViolations(consumer);
      const msg =
        violations.length === 0
          ? "(none)"
          : violations.map((v) => `  ${v.section}: ${v.specifier}`).join("\n");
      expect(
        violations,
        `Found ${violations.length} disallowed @emploke/* dep(s) in packages/${consumer.pkg}/package.json:\n${msg}\n\nAllowed: {${allowedList}}. Remove the dep declaration (no source file imports it, per the source audit above) — leaving it behind defeats the structural fence because pnpm still hoists the pkg into node_modules and a future contributor can re-import it without the audit catching it until the next run.`,
      ).toEqual([]);
    });
  }
});
