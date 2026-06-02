/**
 * Structural enforcement of the "domain pkgs only type-import from
 * other domain pkgs" rule documented in `docs/pkg-template.md §
 * Type placement convention` (rule #5). Sibling to
 * `test-layout-convention.test.ts` (which audits test-file location).
 *
 * Hosted in `@emploke/task` purely for repo-audit infrastructure
 * co-location; the audit is repo-wide and not task-specific. (Same
 * hosting choice as `test-layout-convention.test.ts` — both walk the
 * whole `packages/**` tree; keeping the repo-audit harness in one
 * place makes the infrastructure findable.)
 *
 * Rule (from docs/pkg-template.md § rule 5):
 *
 *   For every TS/TSX source under `packages/<src-pkg>/src/**` where
 *   <src-pkg> is one of the 8 domain pkgs (catalog, task, session,
 *   schedule, runtime, workspace, workflow, terminal):
 *
 *     Every `import` from `"@emploke/<other-domain-pkg>"` MUST be
 *     type-only — either `import type { ... }`, or a mixed
 *     `import { type X, type Y }` with EVERY specifier carrying the
 *     `type` modifier, or `import type * as Ns`.
 *
 *   Value imports — default, named without `type`, namespace, or
 *   side-effect-only — are FORBIDDEN.
 *
 * Test files (`packages/<pkg>/test/**`) are OUT OF SCOPE: integration
 * tests legitimately need live sibling instances to compose end-to-end
 * scenarios. This audit targets production code (and its non-test
 * fixtures) only.
 *
 * Importing from `@emploke/api`, `@emploke/dev-conventions`,
 * `@emploke/server`, `@emploke/cli`, `@emploke/dashboard`, or any
 * other non-domain pkg is OUT OF SCOPE — the rule constrains only
 * the closed set of 8 domain pkgs.
 *
 * Why the rule: `@emploke/api` is the sole composition root that
 * value-imports domain pkgs. Any other domain-to-domain value-import
 * creates a runtime cross-BC dependency that bypasses the
 * per-workspace wiring discipline (see `docs/architecture.md`).
 *
 * Re-exports (`export { Foo } from "@emploke/catalog"`) are NOT
 * audited in this v1 — the convention is to not re-export across
 * domain pkgs in the first place, and cross-pkg re-exports are
 * vanishingly rare in this repo. Promote to an audited rule if the
 * pattern ever appears.
 *
 * Allowlist discipline (mirrors test-layout-convention.test.ts):
 *   - `ALLOWED_VIOLATIONS` carries documented exceptions.
 *   - Entries sorted by `(file, importedPkg)` (review hygiene).
 *   - Every entry has a non-empty rationale.
 *   - Stale entries (file no longer exists OR no such cross-domain
 *     import remains) fail.
 *   - Idle entries (the rule already passes without the entry) fail
 *     — stops the allowlist from accumulating defensive entries.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "drizzle"]);

/**
 * Closed set of domain (bounded-context) pkgs. Any import where the
 * imported specifier is `@emploke/<one-of-these>` is in scope; every
 * other `@emploke/*` specifier (api, server, cli, dashboard, etc.)
 * is out of scope.
 */
const DOMAIN_PKGS: readonly string[] = [
  "catalog",
  "task",
  "session",
  "schedule",
  "runtime",
  "workspace",
  "workflow",
  "terminal",
];
const DOMAIN_PKG_SET = new Set(DOMAIN_PKGS);

interface Violation {
  /** Repo-relative path with forward-slash separators. */
  readonly file: string;
  /** The imported domain pkg name (without `@emploke/` prefix). */
  readonly importedPkg: string;
  /** Why this value-import is acceptable; required and non-empty. */
  readonly rationale: string;
}

/**
 * Documented exceptions to rule 5. Each entry pins a single
 * (file, importedPkg) pair that the audit would otherwise flag, with
 * a non-empty rationale.
 *
 * Empty after P1 (arch/agent-resolver-port): the two seeded
 * `instanceof CatalogAgentNotFoundError` entries — one in
 * `packages/session/src/session-service.ts`, one in
 * `packages/task/src/task-service/agent-resolver.ts` — are gone. Both
 * call sites now discriminate "agent not found" via a `null` return
 * from the local `AgentResolverPort.getAgentEntry(...)` (Option II;
 * see `packages/task/src/ports.ts` and Decision #9 in P1's brief), so
 * neither file imports anything from `@emploke/catalog` anymore. The
 * stronger no-catalog-imports assertion below (see
 * `task and session src/** has zero @emploke/catalog imports`)
 * supersedes rule 5 for the catalog → task and catalog → session
 * edges.
 */
const ALLOWED_VIOLATIONS: readonly Violation[] = [];

// ── helpers ────────────────────────────────────────────────────────────

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively yield every `.ts` / `.tsx` file under `dir`, skipping
 * directories in `SKIP_DIR_NAMES` (`node_modules`, `dist`, `drizzle`).
 */
function* walkTsFiles(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
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

/**
 * Classification of a single `import` declaration from a source file.
 * Only the fields needed to decide value-vs-type are kept; the rest
 * (binding names, source ranges) are intentionally not collected so
 * the audit stays cheap to run on every test invocation.
 */
interface ImportClassification {
  /** Module specifier text (e.g. `"@emploke/catalog"`). */
  readonly specifier: string;
  /** `true` iff the import contributes runtime code. */
  readonly isValueImport: boolean;
}

/**
 * Classify every `import` statement in `source` according to whether
 * it contributes runtime code or is purely type-erased.
 *
 * Value imports (return `isValueImport: true`):
 *   - Side-effect-only `import "x"` (executes top-level code).
 *   - Default-binding `import x from "..."`.
 *   - Namespace-binding `import * as ns from "..."` (without `type`).
 *   - Named `import { a } from "..."` where ≥ 1 specifier lacks `type`.
 *
 * Type-only (return `isValueImport: false`):
 *   - `import type { ... } from "..."` (whole-clause type-only).
 *   - `import type * as Ns from "..."` (whole-clause type-only).
 *   - `import { type a, type b } from "..."` where EVERY specifier
 *     carries the `type` modifier (mixed clause whose value contribution
 *     is empty).
 *
 * The two AST levels for the `type` modifier matter: `importClause.isTypeOnly`
 * is `true` only for the whole-clause form (`import type { ... }`),
 * while the mixed form (`import { type Foo, type Bar }`) keeps the
 * clause-level flag at `false` and flips each `ImportSpecifier.isTypeOnly`
 * individually. Conflating the two is pitfall #3 in the brief.
 *
 * Out of scope: re-exports (`export { ... } from "..."`), dynamic
 * `import("...")` calls (not used cross-pkg in this codebase), and
 * `import type` inside a `type Y = import("X").Foo` `ImportTypeNode`
 * (already type-erased).
 */
function extractImports(source: string, fileName: string): ImportClassification[] {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const out: ImportClassification[] = [];
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node)) continue;
    const specNode = node.moduleSpecifier;
    if (!ts.isStringLiteral(specNode)) continue;
    const specifier = specNode.text;
    const clause = node.importClause;

    // `import "x";` — side-effect-only. Executes top-level code; value.
    if (!clause) {
      out.push({ specifier, isValueImport: true });
      continue;
    }

    // `import type { ... } from "...";` or `import type * as Ns from "...";`
    // — whole-clause type-only.
    if (clause.isTypeOnly) {
      out.push({ specifier, isValueImport: false });
      continue;
    }

    // `import x from "...";` — default binding is always a value.
    if (clause.name !== undefined) {
      out.push({ specifier, isValueImport: true });
      continue;
    }

    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      // Defensive: no bindings, no name, not type-only — shouldn't happen
      // for a well-formed `ImportDeclaration`. Treat as side-effect-ish
      // (value) so we surface anything unexpected rather than swallow it.
      out.push({ specifier, isValueImport: true });
      continue;
    }

    // `import * as Ns from "...";` (without `type`) — namespace value binding.
    if (ts.isNamespaceImport(bindings)) {
      out.push({ specifier, isValueImport: true });
      continue;
    }

    if (ts.isNamedImports(bindings)) {
      // Mixed form: only type-only if EVERY named specifier carries the
      // `type` modifier.
      const hasValueSpecifier = bindings.elements.some((el) => !el.isTypeOnly);
      out.push({ specifier, isValueImport: hasValueSpecifier });
    }
  }
  return out;
}

/** Repo-relative, forward-slash path. */
function relPosix(absFile: string): string {
  return path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
}

/**
 * Walk every domain pkg's `src/` tree and collect every cross-domain
 * value-import. Returns the raw set; allowlist filtering is applied
 * by the test bodies that want unexcused violations.
 */
function collectAllCrossDomainValueImports(): readonly Violation[] {
  const out: Violation[] = [];
  for (const dom of DOMAIN_PKGS) {
    const srcDir = path.join(PACKAGES_DIR, dom, "src");
    if (!safeIsDir(srcDir)) continue;
    for (const absFile of walkTsFiles(srcDir)) {
      const source = readFileSync(absFile, "utf8");
      const imports = extractImports(source, absFile);
      for (const imp of imports) {
        const m = imp.specifier.match(/^@emploke\/([^/]+)$/);
        if (m === null) continue;
        const importedPkg = m[1] as string;
        if (importedPkg === dom) continue;
        if (!DOMAIN_PKG_SET.has(importedPkg)) continue;
        if (!imp.isValueImport) continue;
        out.push({
          file: relPosix(absFile),
          importedPkg,
          rationale: "",
        });
      }
    }
  }
  return out;
}

function formatViolations(vs: readonly Violation[]): string {
  if (vs.length === 0) return "(no violations)";
  return vs
    .map(
      (v) =>
        `${v.file} → @emploke/${v.importedPkg} (value import; rule 5 of docs/pkg-template.md § Type placement convention)`,
    )
    .join("\n");
}

// ── audit ──────────────────────────────────────────────────────────────

describe("inter-service value-imports are forbidden", () => {
  const all = collectAllCrossDomainValueImports();
  const allowedKeys = new Set(
    ALLOWED_VIOLATIONS.map((a) => `${a.file}::@emploke/${a.importedPkg}`),
  );

  it("every domain-pkg src/** file type-imports sibling domain pkgs only (or is in ALLOWED_VIOLATIONS)", () => {
    const unexcused = all.filter((v) => !allowedKeys.has(`${v.file}::@emploke/${v.importedPkg}`));
    expect(
      unexcused,
      `Found ${unexcused.length} cross-domain value-import(s) that violate rule 5:\n${formatViolations(unexcused)}\n\nEither (a) convert the import to type-only (\`import type { ... }\` or per-specifier \`type\` modifiers), (b) thread the live instance through @emploke/api (the only legitimate value-importer), or (c) add an ALLOWED_VIOLATIONS entry with a non-empty rationale.`,
    ).toEqual([]);
  });

  it("ALLOWED_VIOLATIONS entries are sorted by (file, importedPkg)", () => {
    const actual = ALLOWED_VIOLATIONS.map((v) => `${v.file}::${v.importedPkg}`);
    const sorted = [...actual].sort();
    expect(actual, "Sort ALLOWED_VIOLATIONS by (file, importedPkg) for review hygiene.").toEqual(
      sorted,
    );
  });

  it("ALLOWED_VIOLATIONS entries all have non-empty rationale", () => {
    const empty = ALLOWED_VIOLATIONS.filter((v) => v.rationale.trim().length === 0).map(
      (v) => `${v.file} → @emploke/${v.importedPkg}`,
    );
    expect(
      empty,
      `Empty rationale: ${empty.join(", ")}. Every allowlist entry needs a one-line explanation of why the cross-domain value import is acceptable and what the long-term fix is.`,
    ).toEqual([]);
  });

  it("ALLOWED_VIOLATIONS entries are not stale (file exists AND the violating import still exists)", () => {
    const stale: string[] = [];
    // Group observed violations into a quick lookup.
    const observed = new Set(all.map((v) => `${v.file}::@emploke/${v.importedPkg}`));
    for (const ex of ALLOWED_VIOLATIONS) {
      const abs = path.join(REPO_ROOT, ex.file);
      let exists: boolean;
      try {
        exists = statSync(abs).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        stale.push(`${ex.file} → @emploke/${ex.importedPkg}: file does not exist on disk.`);
        continue;
      }
      const key = `${ex.file}::@emploke/${ex.importedPkg}`;
      if (!observed.has(key)) {
        stale.push(
          `${ex.file} → @emploke/${ex.importedPkg}: no such cross-domain value-import found in the file. Remove the entry.`,
        );
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("ALLOWED_VIOLATIONS entries are not idle (rule actually fails without the entry)", () => {
    // An entry is "idle" if removing it from the allowlist still leaves
    // zero unexcused violations for that (file, importedPkg) pair. The
    // "stale" check above already covers the case where the import is
    // gone entirely; this check covers the case where the import still
    // exists but is no longer a value import (e.g. someone tightened
    // it to `import type` but forgot to drop the allowlist entry).
    //
    // For this v1 the two checks are functionally equivalent because
    // every observed (file, importedPkg) pair in `all` is by definition
    // a current value-import — `collectAllCrossDomainValueImports`
    // emits only value imports. So "rule passes without entry" iff
    // "entry has no observed counterpart", which is what the stale
    // check already enforces. We still write this as a separate `it`
    // block so the allowlist-discipline contract documented in the
    // top-of-file docstring (5 checks) is honoured and so future
    // refactors that change `collectAllCrossDomainValueImports`'s
    // emit set don't accidentally weaken the contract.
    const idle: string[] = [];
    const observed = new Set(all.map((v) => `${v.file}::@emploke/${v.importedPkg}`));
    for (const ex of ALLOWED_VIOLATIONS) {
      const key = `${ex.file}::@emploke/${ex.importedPkg}`;
      const abs = path.join(REPO_ROOT, ex.file);
      let exists: boolean;
      try {
        exists = statSync(abs).isFile();
      } catch {
        exists = false;
      }
      // Skip — the stale check owns the "file gone" message.
      if (!exists) continue;
      if (!observed.has(key)) {
        idle.push(
          `${ex.file} → @emploke/${ex.importedPkg}: the rule already passes for this pair (no current value-import). Remove the entry.`,
        );
      }
    }
    expect(idle, idle.join("\n")).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Strict no-catalog-imports rule for the task and session src trees.
// Strictly stronger than rule 5 above: forbids ALL `@emploke/catalog`
// references — value imports, type imports, namespace imports,
// re-exports, side-effect imports, and `import("@emploke/catalog")`
// type nodes alike. Pins P1's outcome (arch/agent-resolver-port):
// task + session now consume catalog only via the structural
// `AgentResolverPort` / `AgentContentSource` ports that the
// composition root (`@emploke/api`) supplies; the catalog package
// must never appear in either tree's source again. Future PRs that
// accidentally reintroduce a catalog import will fail this assertion.
// ──────────────────────────────────────────────────────────────────────

/**
 * Count every reference to `@emploke/catalog` reachable from a TS
 * source file: import declarations (regardless of value/type-only),
 * export-from declarations, and `import("@emploke/catalog")` type
 * nodes. Comments + string literals are excluded automatically by
 * the AST walk.
 */
function countCatalogReferences(source: string, fileName: string): number {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@emploke/catalog"
    ) {
      count++;
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@emploke/catalog"
    ) {
      count++;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      node.argument.literal.text === "@emploke/catalog"
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

describe("task and session src/** has zero @emploke/catalog references (P1: structural decoupling)", () => {
  for (const dom of ["task", "session"] as const) {
    it(`packages/${dom}/src/** never references "@emploke/catalog"`, () => {
      const srcDir = path.join(PACKAGES_DIR, dom, "src");
      const offenders: { file: string; count: number }[] = [];
      if (safeIsDir(srcDir)) {
        for (const absFile of walkTsFiles(srcDir)) {
          const source = readFileSync(absFile, "utf8");
          const n = countCatalogReferences(source, absFile);
          if (n > 0) offenders.push({ file: relPosix(absFile), count: n });
        }
      }
      expect(
        offenders,
        `Found ${offenders.length} file(s) under packages/${dom}/src/** that reference @emploke/catalog:\n${offenders.map((o) => `  ${o.file} (${o.count} reference${o.count === 1 ? "" : "s"})`).join("\n")}\n\nP1 (arch/agent-resolver-port) decoupled @emploke/${dom} from @emploke/catalog. Pass a value satisfying the local AgentResolverPort + AgentContentSource at compose time instead of importing from catalog directly.`,
      ).toEqual([]);
    });
  }
});

describe("inter-service-imports parser self-tests", () => {
  function classify(src: string): readonly ImportClassification[] {
    return extractImports(src, "virtual.ts");
  }

  it('`import type { Foo } from "@emploke/catalog"` is type-only', () => {
    const cs = classify('import type { Foo } from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(false);
  });

  it('`import type * as Ns from "@emploke/catalog"` is type-only', () => {
    const cs = classify('import type * as Ns from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(false);
  });

  it('`import { type Foo, type Bar } from "@emploke/catalog"` is type-only (mixed all-type)', () => {
    const cs = classify('import { type Foo, type Bar } from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(false);
  });

  it('`import { type Foo, Bar } from "@emploke/catalog"` is a value import (mixed)', () => {
    const cs = classify('import { type Foo, Bar } from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(true);
  });

  it('`import { type Foo, Bar as Aliased } from "@emploke/catalog"` is a value import', () => {
    const cs = classify('import { type Foo, Bar as Aliased } from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(true);
  });

  it('`import Foo from "@emploke/catalog"` (default) is a value import', () => {
    const cs = classify('import Foo from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(true);
  });

  it('`import * as Ns from "@emploke/catalog"` (namespace value) is a value import', () => {
    const cs = classify('import * as Ns from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(true);
  });

  it('`import "@emploke/catalog"` (side-effect only) is a value import', () => {
    const cs = classify('import "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(true);
  });

  it('`import { Foo } from "@emploke/catalog"` (plain named, no type modifier) is a value import', () => {
    const cs = classify('import { Foo } from "@emploke/catalog";');
    expect(cs).toHaveLength(1);
    expect(cs[0]?.isValueImport).toBe(true);
  });
});

describe("countCatalogReferences self-tests", () => {
  function count(src: string): number {
    return countCatalogReferences(src, "virtual.ts");
  }

  it("counts a plain value import", () => {
    expect(count('import { Foo } from "@emploke/catalog";')).toBe(1);
  });

  it("counts a type-only import", () => {
    expect(count('import type { Foo } from "@emploke/catalog";')).toBe(1);
  });

  it("counts a per-specifier type-only import (mixed all-type)", () => {
    expect(count('import { type Foo, type Bar } from "@emploke/catalog";')).toBe(1);
  });

  it("counts a namespace import", () => {
    expect(count('import * as Ns from "@emploke/catalog";')).toBe(1);
  });

  it("counts a side-effect-only import", () => {
    expect(count('import "@emploke/catalog";')).toBe(1);
  });

  it("counts a re-export", () => {
    expect(count('export { Foo } from "@emploke/catalog";')).toBe(1);
  });

  it('counts an `import("@emploke/catalog")` type node', () => {
    expect(count('type X = import("@emploke/catalog").Foo;')).toBe(1);
  });

  it("ignores comments that mention @emploke/catalog", () => {
    expect(count("// @emploke/catalog mentioned in a comment\nexport const x = 1;")).toBe(0);
  });

  it("ignores string literals (no AST node)", () => {
    expect(count('const s = "@emploke/catalog";')).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Sanity — at least one domain pkg src file was scanned, so the audit
// hasn't silently no-op'd because of a path-resolution bug.
// ──────────────────────────────────────────────────────────────────────

describe("inter-service-imports audit sanity", () => {
  it("scanned at least one TS file in at least one domain pkg's src/", () => {
    let count = 0;
    for (const dom of DOMAIN_PKGS) {
      const srcDir = path.join(PACKAGES_DIR, dom, "src");
      if (!safeIsDir(srcDir)) continue;
      for (const _ of walkTsFiles(srcDir)) {
        count++;
        if (count > 0) break;
      }
      if (count > 0) break;
    }
    expect(count).toBeGreaterThan(0);
  });
});
