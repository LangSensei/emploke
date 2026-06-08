/**
 * Structural enforcement of the "test layout mirrors src layout"
 * convention documented in `docs/pkg-template.md § Test layout
 * convention`. Sibling to `split-convention.test.ts` (which enforces
 * the orthogonal facade + sibling-subdir rule on `src/`).
 *
 * Rule (from docs/pkg-template.md):
 *
 *   For every `packages/<pkg>/test/**\/*.test.{ts,tsx}` file, collect
 *   all non-type value-imports that resolve to a file under the same
 *   package's `src/` tree (resolve the relative specifier against the
 *   test file's directory; ignore type-only imports, `vi.mock(...)`,
 *   `vi.importActual(...)`, and imports of any other workspace
 *   package or node builtin).
 *
 *     1. Set is empty → flat at `test/<name>.test.{ts,tsx}`
 *        (cross-cutting / e2e / fs-walk audits).
 *     2. Set is non-empty AND every import shares a common
 *        subdirectory under `src/` strictly deeper than `src/` itself
 *        → MUST live at `test/<that-subdir>/<name>.test.{ts,tsx}`.
 *     3. Otherwise (multiple imports with no common subdir below
 *        `src/`) → flat at `test/<name>.test.{ts,tsx}`.
 *
 * Type-only imports (`import type { Foo } from "..."` and the `type`
 * modifier inside mixed `import { type Foo, bar }` specifiers) compile
 * away and do NOT count. `vi.mock("...")` and `vi.importActual("...")`
 * are harness, not subject, and do NOT count. Side-effect-only
 * `import "x"` DOES count (it executes top-level code).
 *
 * Allowlist discipline:
 *   - `ALLOWED_FLAT_EXCEPTIONS` carries tests the rule would require
 *     to move but which have a documented reason to stay flat
 *     (multi-subdir composites, in-flight migrations).
 *   - Entries are sorted by file path (review hygiene).
 *   - Every entry must have a non-empty rationale string.
 *   - Stale entries (file no longer exists) fail.
 *   - Idle entries (rule already passes for this file) fail — stops
 *     the allowlist from accumulating defensive entries.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "drizzle"]);

interface FlatException {
  readonly file: string; // repo-relative, forward-slash
  readonly rationale: string; // why this test stays flat
}

/**
 * Tests whose actual location differs from the rule-derived required
 * location, with a documented reason to keep the divergence. Sorted
 * by file path. Every entry must carry a one-line rationale.
 *
 * Two flavours of entry:
 *
 *  1. **Flat test the rule says belongs in a subdir** — kept flat by
 *     intent (umbrella reflection tests, in-flight migrations).
 *  2. **Subdir test the rule says belongs at flat** — kept in the
 *     subdir by intent (pre-existing per-area subdir layouts whose
 *     imports happen to span multiple sibling subdirs of `src/`).
 *
 * Rule-compliant tests (actual === required) do NOT belong here — the
 * "no idle entries" check rejects them so the allowlist doesn't
 * accumulate defensive entries that protect against nothing.
 *
 * Entries seeded in commit 1 of the pre-0.5.7 monorepo hygiene PR
 * for the tests slated to mirror in commit 2 carry an explicit
 * "moves to test/<subdir>/ in commit 2" rationale so the reviewer
 * can see the work commit 2 is meant to do. After commit 2 lands,
 * only structural / cross-cutting exceptions remain.
 */
const ALLOWED_FLAT_EXCEPTIONS: readonly FlatException[] = [
  // catalog
  {
    file: "packages/catalog/test/facade/catalog-service.sync.test.ts",
    rationale:
      "subdirected by area (facade/); imports span agent + skill + mcp sibling subdirs of src/ — rule says flat. Pre-existing layout, deferred to a separate review pass.",
  },
  {
    file: "packages/catalog/test/facade/catalog-service.test.ts",
    rationale:
      "subdirected by area (facade/); imports span agent + skill + mcp sibling subdirs of src/ — rule says flat. Pre-existing layout, deferred to a separate review pass.",
  },
  // cli
  // dashboard
  {
    file: "packages/dashboard/test/hooks/useWorkflowArtifacts.test.ts",
    rationale:
      "subdirected by area (hooks/); imports span hooks/ + api sibling subdirs of src/ — rule says flat. Mirrors src/hooks/useWorkflowArtifacts.ts; co-location with the source aids editor navigation, retained.",
  },
  {
    file: "packages/dashboard/test/pages/workflows/ArtifactsTab.test.tsx",
    rationale:
      "subdirected by area (pages/workflows/); imports span pages/workflows/ + api sibling subdirs of src/ — rule says flat. Mirrors src/pages/workflows/ArtifactsTab.tsx; co-location with the source aids editor navigation, retained.",
  },
  // e2e
  {
    file: "packages/e2e/test/architecture/inter-service-imports.test.ts",
    rationale:
      "subdirected by area (architecture/); zero in-pkg src value-imports — rule says flat. Cross-cutting repo-wide audit grouped with siblings, retained.",
  },
  {
    file: "packages/e2e/test/architecture/split-convention.test.ts",
    rationale:
      "subdirected by area (architecture/); zero in-pkg src value-imports — rule says flat. Cross-cutting repo-wide audit grouped with siblings, retained.",
  },
  {
    file: "packages/e2e/test/architecture/test-layout-convention.test.ts",
    rationale:
      "subdirected by area (architecture/); zero in-pkg src value-imports — rule says flat. Cross-cutting repo-wide audit grouped with siblings, retained.",
  },
  {
    file: "packages/e2e/test/architecture/tier-invisibility.test.ts",
    rationale:
      "subdirected by area (architecture/); zero in-pkg src value-imports — rule says flat. Cross-cutting repo-wide audit grouped with siblings, retained.",
  },
  {
    file: "packages/e2e/test/cli/integration-smoke.test.ts",
    rationale:
      "subdirected by area (cli/); zero in-pkg src value-imports — rule says flat. Pre-existing e2e harness layout, retained.",
  },
  {
    file: "packages/e2e/test/cli/spawn-smoke.test.ts",
    rationale:
      "subdirected by area (cli/); zero in-pkg src value-imports — rule says flat. Pre-existing e2e harness layout, retained.",
  },
  // runtime
  {
    file: "packages/runtime/test/copilot/copilot-runtime.test.ts",
    rationale:
      "subdirected by runtime kind (copilot/); imports span copilot/ + sibling top-level src/ files — rule says flat. Pre-existing per-runtime test grouping, retained.",
  },
  {
    file: "packages/runtime/test/copilot/ids.test.ts",
    rationale:
      "subdirected by runtime kind (copilot/); imports span copilot/ + sibling top-level src/ files — rule says flat. Pre-existing per-runtime test grouping, retained.",
  },
  {
    file: "packages/runtime/test/copilot/launch-headless-env.test.ts",
    rationale:
      "subdirected by runtime kind (copilot/); imports span copilot/ + sibling top-level src/ files — rule says flat. Pre-existing per-runtime test grouping, retained.",
  },
  {
    file: "packages/runtime/test/copilot/preflight.test.ts",
    rationale:
      "subdirected by runtime kind (copilot/); imports span copilot/ + sibling top-level src/ files — rule says flat. Pre-existing per-runtime test grouping, retained.",
  },
  {
    file: "packages/runtime/test/copilot/provision.test.ts",
    rationale:
      "subdirected by runtime kind (copilot/); imports span copilot/ + sibling top-level src/ files — rule says flat. Pre-existing per-runtime test grouping, retained.",
  },
  {
    file: "packages/runtime/test/copilot/trust.test.ts",
    rationale:
      "subdirected by runtime kind (copilot/); imports span copilot/ + sibling top-level src/ files — rule says flat. Pre-existing per-runtime test grouping, retained.",
  },
  // server
  {
    file: "packages/server/test/route-manifest.test.ts",
    rationale:
      "umbrella reflection test that mounts every route group + middleware to compare Hono's app.routes against ROUTES. Imports happen to share subdir 'routes' but the test is the manifest's umbrella, not a route subject — kept flat to mirror its scope.",
  },
  // terminal
  {
    file: "packages/terminal/test/platforms/linux.test.ts",
    rationale:
      "subdirected by platform (platforms/); imports span platforms/ + sibling top-level src/ files — rule says flat. Pre-existing per-platform test grouping, retained.",
  },
  {
    file: "packages/terminal/test/platforms/macos.test.ts",
    rationale:
      "subdirected by platform (platforms/); imports span platforms/ + sibling top-level src/ files — rule says flat. Pre-existing per-platform test grouping, retained.",
  },
  {
    file: "packages/terminal/test/platforms/windows.test.ts",
    rationale:
      "subdirected by platform (platforms/); imports span platforms/ + sibling top-level src/ files — rule says flat. Pre-existing per-platform test grouping, retained.",
  },
];

/**
 * Recognise vitest mocking call expressions:
 *   - `vi.mock("...")`
 *   - `vi.importActual("...")`
 *   - `vi.doMock("...")`
 *   - `vi.unmock("...")`
 *
 * These reference the spec as a harness directive — the spec string
 * names a module to virtualise, not a subject under test.
 */
function isViMockingCall(node: ts.CallExpression): boolean {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (!ts.isIdentifier(expr.expression)) return false;
  if (expr.expression.text !== "vi") return false;
  const name = expr.name.text;
  return name === "mock" || name === "importActual" || name === "doMock" || name === "unmock";
}

/**
 * Extract every NON-TYPE value-import specifier from a TS source file.
 *
 * Includes:
 *  - `import { x } from "..."` — value bindings; counts.
 *  - `import x from "..."` — default value binding; counts.
 *  - `import * as ns from "..."` — namespace binding; counts.
 *  - `import "..."` — side-effect only; counts (executes top-level code).
 *  - `import { type X, y } from "..."` — counts because of `y`.
 *  - `import("...")` dynamic import — counts.
 *
 * Excludes:
 *  - `import type { X } from "..."` — fully type-only; does NOT count.
 *  - `import { type X } from "..."` where every specifier is `type` —
 *    does NOT count.
 *  - `type Y = import("X").Foo` (`ImportTypeNode`) — does NOT count.
 *  - `vi.mock("...")` / `vi.importActual("...")` / `vi.doMock(...)` /
 *    `vi.unmock(...)` — harness directives, do NOT count.
 *
 * Returns raw specifier strings — resolution is up to the caller.
 */
function extractValueImportSpecifiers(filePath: string): readonly string[] {
  const source = readFileSync(filePath, "utf8");
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const out: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const specNode = node.moduleSpecifier;
      if (!ts.isStringLiteral(specNode)) return;
      const spec = specNode.text;
      if (!clause) {
        // Side-effect-only `import "x"` — counts.
        out.push(spec);
        return;
      }
      if (clause.isTypeOnly) {
        // `import type { ... } from "..."` — pure type, skip.
        return;
      }
      // A default binding or namespace binding is always a value import.
      if (clause.name !== undefined) {
        out.push(spec);
        return;
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) return;
      if (ts.isNamespaceImport(bindings)) {
        // `import * as ns from "..."` — value namespace binding.
        out.push(spec);
        return;
      }
      if (ts.isNamedImports(bindings)) {
        // `import { a, type B, c } from "..."` — counts iff at least
        // one specifier is NOT marked type-only.
        const hasValueSpecifier = bindings.elements.some((e) => !e.isTypeOnly);
        if (hasValueSpecifier) out.push(spec);
        return;
      }
      return;
    }

    // `import("...")` dynamic import — counts as value.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) {
        out.push(arg.text);
      }
      // fall through to recurse; nothing else to skip.
    }

    // Harness directives — IGNORE. We still need to recurse into
    // siblings, but we explicitly skip the string-literal arg of these
    // calls. Because we extract specifiers ONLY from ImportDeclaration
    // and dynamic-import CallExpressions, vi.mock(...) is naturally
    // ignored (the string literal isn't reached as an import). We do
    // however want to short-circuit further descent into vi.mock's
    // factory body — its `vi.importActual("...")` and any nested
    // `await import(...)` is mock-wiring, NOT subject-under-test.
    if (ts.isCallExpression(node) && isViMockingCall(node)) {
      return;
    }

    // `type Y = import("X").Foo` is an ImportTypeNode — IGNORE (recursing
    // would not produce a CallExpression so naturally skipped, but make
    // it explicit by short-circuiting).
    if (ts.isImportTypeNode(node)) {
      return;
    }

    node.forEachChild(visit);
  }

  visit(sf);
  return out;
}

/**
 * Resolve a relative specifier against a test file's directory. Tries
 * the path verbatim, then with `.ts` / `.tsx` appended, then as
 * `<path>/index.ts` / `.tsx`. Returns abs path or null.
 *
 * Node-builtins (`node:fs` etc.) and workspace specifiers
 * (`@emploke/*`, bare names) return null without filesystem checks.
 */
function resolveSpecifier(testDir: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare / workspace / builtin
  // Drop a trailing `.js` and try `.ts` / `.tsx` (ESM extension rewrites
  // are how this monorepo imports `./foo.js` that maps to `./foo.ts`).
  const noJs = spec.endsWith(".js") ? spec.slice(0, -3) : spec;
  const candidates = [spec, `${noJs}.ts`, `${noJs}.tsx`, `${noJs}/index.ts`, `${noJs}/index.tsx`];
  for (const cand of candidates) {
    const abs = path.resolve(testDir, cand);
    try {
      const s = statSync(abs);
      if (s.isFile()) return abs;
    } catch {
      // try next
    }
  }
  return null;
}

/** Is abs path under `packages/<samePkg>/src/`? */
function isUnderPkgSrc(abs: string, pkgName: string): boolean {
  const pkgSrc = path.join(PACKAGES_DIR, pkgName, "src") + path.sep;
  return abs.startsWith(pkgSrc);
}

/**
 * Subdirectory of an in-pkg-src import, relative to the pkg's `src/`
 * root. Returns `""` for files immediately under `src/` (which the
 * rule treats as having no shared subdir → flat-required when alone).
 */
function srcSubdirOf(abs: string, pkgName: string): string {
  const pkgSrc = path.join(PACKAGES_DIR, pkgName, "src");
  const rel = path.relative(pkgSrc, path.dirname(abs));
  // path.relative returns "" if dir IS pkgSrc; or "<segments>" otherwise.
  // Normalise separators to "/" for stable comparison.
  return rel.split(path.sep).join("/");
}

/**
 * Longest common directory prefix across a list of subdir strings
 * (each "/"-separated). Returns "" if no shared prefix below the first
 * segment.
 *
 * Empty input is undefined; callers should not pass [].
 */
function longestCommonDir(dirs: readonly string[]): string {
  if (dirs.length === 0) return "";
  // If any subdir is empty (file directly under src/), the LCP can only
  // be empty.
  if (dirs.some((d) => d === "")) return "";
  const splitDirs = dirs.map((d) => d.split("/"));
  const first = splitDirs[0];
  if (first === undefined) return "";
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (splitDirs.every((d) => d[i] === seg)) {
      out.push(seg as string);
    } else {
      break;
    }
  }
  return out.join("/");
}

interface ClassifiedTest {
  readonly absPath: string;
  readonly relPath: string; // repo-relative, forward-slash
  readonly pkg: string;
  /** `"flat"` if directly under `packages/<pkg>/test/`; else the slash-joined subdir under `test/`. */
  readonly actualLocation: "flat" | string;
  /** `"flat"` per the rule, or the required slash-joined subdir under `test/`. */
  readonly requiredLocation: "flat" | string;
  readonly reason: string;
}

function classifyTest(absPath: string): ClassifiedTest {
  const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
  // packages/<pkg>/test/...
  const parts = relPath.split("/");
  const pkg = parts[1] ?? "";
  const insideTest = parts.slice(3); // after packages/<pkg>/test/
  const actualSub = insideTest.slice(0, -1).join("/");
  const actualLocation: "flat" | string = actualSub.length === 0 ? "flat" : actualSub;

  const testDir = path.dirname(absPath);
  const specs = extractValueImportSpecifiers(absPath);
  const inPkgSrcSubdirs: string[] = [];
  for (const spec of specs) {
    const resolved = resolveSpecifier(testDir, spec);
    if (resolved === null) continue;
    if (!isUnderPkgSrc(resolved, pkg)) continue;
    inPkgSrcSubdirs.push(srcSubdirOf(resolved, pkg));
  }

  let requiredLocation: "flat" | string;
  let reason: string;
  if (inPkgSrcSubdirs.length === 0) {
    requiredLocation = "flat";
    reason = "zero in-pkg src value-imports";
  } else {
    const lcp = longestCommonDir(inPkgSrcSubdirs);
    if (lcp.length === 0) {
      requiredLocation = "flat";
      reason = "in-pkg src value-imports share no common subdir below src/";
    } else {
      requiredLocation = lcp;
      reason = `every in-pkg src value-import shares subdir "${lcp}"`;
    }
  }

  return {
    absPath,
    relPath,
    pkg,
    actualLocation,
    requiredLocation,
    reason,
  };
}

function findAllTests(): readonly string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (e.name.endsWith(".test.ts") || e.name.endsWith(".test.tsx")) {
          out.push(path.join(dir, e.name));
        }
      }
    }
  }
  // Walk each package's test/ dir.
  const pkgs = readdirSync(PACKAGES_DIR, { withFileTypes: true, encoding: "utf8" });
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    const testRoot = path.join(PACKAGES_DIR, pkg.name, "test");
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(testRoot);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    walk(testRoot);
  }
  return out;
}

describe("test layout mirrors src layout", () => {
  const all = findAllTests().map(classifyTest);
  const allowedSet = new Set(ALLOWED_FLAT_EXCEPTIONS.map((e) => e.file));
  const selfRel = path
    .relative(REPO_ROOT, import.meta.filename)
    .split(path.sep)
    .join("/");

  it("every test file's required location matches its actual location (or is in ALLOWED_FLAT_EXCEPTIONS)", () => {
    const violations: string[] = [];
    for (const t of all) {
      if (t.actualLocation === t.requiredLocation) continue;
      if (allowedSet.has(t.relPath)) continue;
      violations.push(
        `${t.relPath}: actual=${t.actualLocation} required=${t.requiredLocation} (${t.reason}). ` +
          `Either move the file, or add it to ALLOWED_FLAT_EXCEPTIONS in ${selfRel} with a one-line rationale.`,
      );
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("ALLOWED_FLAT_EXCEPTIONS has no stale entries (every entry must exist on disk)", () => {
    const missing: string[] = [];
    for (const ex of ALLOWED_FLAT_EXCEPTIONS) {
      const abs = path.join(REPO_ROOT, ex.file);
      try {
        statSync(abs);
      } catch {
        missing.push(
          `${ex.file} — listed in ALLOWED_FLAT_EXCEPTIONS but does not exist on disk. Remove the entry.`,
        );
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("ALLOWED_FLAT_EXCEPTIONS has no idle entries (every entry must actually be required-to-move under the rule)", () => {
    // Stops the allowlist from accumulating defensive entries for
    // tests the rule doesn't even ding.
    const idle: string[] = [];
    const allMap = new Map(all.map((t) => [t.relPath, t]));
    for (const ex of ALLOWED_FLAT_EXCEPTIONS) {
      const t = allMap.get(ex.file);
      if (!t) continue; // covered by previous test
      if (t.actualLocation === t.requiredLocation) {
        idle.push(
          `${ex.file} — listed in ALLOWED_FLAT_EXCEPTIONS but the rule already passes (actual=${t.actualLocation}). Remove the entry.`,
        );
      }
    }
    expect(idle, idle.join("\n")).toEqual([]);
  });

  it("ALLOWED_FLAT_EXCEPTIONS entries are sorted by file path (review hygiene)", () => {
    const sorted = [...ALLOWED_FLAT_EXCEPTIONS].map((e) => e.file).sort();
    const actual = ALLOWED_FLAT_EXCEPTIONS.map((e) => e.file);
    expect(actual, "Sort ALLOWED_FLAT_EXCEPTIONS by file path. Use a stable sort.").toEqual(sorted);
  });

  it("ALLOWED_FLAT_EXCEPTIONS rationale is non-empty for every entry", () => {
    const empty = ALLOWED_FLAT_EXCEPTIONS.filter((e) => e.rationale.trim().length === 0).map(
      (e) => e.file,
    );
    expect(
      empty,
      `Empty rationale: ${empty.join(", ")}. Every allowlist entry needs a one-line explanation of why the rule's required move is wrong for this test.`,
    ).toEqual([]);
  });

  it("sanity: at least one test was classified as mirror-required (audit didn't silently no-op)", () => {
    const mirrorRequired = all.filter((t) => t.requiredLocation !== "flat");
    expect(mirrorRequired.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Parser self-tests — pin behaviour against hand-crafted source strings
// so a TS version bump doesn't silently change classification.
// ──────────────────────────────────────────────────────────────────────

function specifiersFromSource(source: string, kind: "ts" | "tsx" = "ts"): readonly string[] {
  // Write to a temp file path-shape so extractValueImportSpecifiers can
  // run its TS parser. We don't actually need the file to exist on
  // disk — instead we inline a minimal duplicate of the extractor
  // against a virtual source. This keeps the self-tests synchronous
  // and free of I/O.
  const scriptKind = kind === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    `virtual.${kind}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const out: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const specNode = node.moduleSpecifier;
      if (!ts.isStringLiteral(specNode)) return;
      const spec = specNode.text;
      if (!clause) {
        out.push(spec);
        return;
      }
      if (clause.isTypeOnly) return;
      if (clause.name !== undefined) {
        out.push(spec);
        return;
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) return;
      if (ts.isNamespaceImport(bindings)) {
        out.push(spec);
        return;
      }
      if (ts.isNamedImports(bindings)) {
        if (bindings.elements.some((e) => !e.isTypeOnly)) out.push(spec);
        return;
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) out.push(arg.text);
    }
    if (ts.isCallExpression(node) && isViMockingCall(node)) {
      return;
    }
    if (ts.isImportTypeNode(node)) {
      return;
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return out;
}

describe("test-layout-convention parser self-tests", () => {
  it("type-only imports are ignored", () => {
    expect(specifiersFromSource('import type { Foo } from "./x.js";')).toEqual([]);
  });

  it("mixed `{ type Foo, bar }` counts the import (value specifier `bar`)", () => {
    expect(specifiersFromSource('import { type Foo, bar } from "./x.js";')).toEqual(["./x.js"]);
  });

  it("mixed `{ type Foo }` alone (every specifier is type) does NOT count", () => {
    expect(specifiersFromSource('import { type Foo } from "./x.js";')).toEqual([]);
  });

  it('vi.mock("...") is ignored', () => {
    expect(
      specifiersFromSource(
        'import { vi } from "vitest";\nvi.mock("./mocked.js", () => ({ ok: true }));',
      ),
    ).toEqual(["vitest"]);
  });

  it('vi.importActual("...") is ignored', () => {
    expect(
      specifiersFromSource(
        'import { vi } from "vitest";\nvi.mock("./mocked.js", async () => ({\n' +
          '  ...(await vi.importActual("./mocked.js")),\n' +
          "}));",
      ),
    ).toEqual(["vitest"]);
  });

  it('dynamic import("...") counts as value', () => {
    expect(specifiersFromSource('const mod = await import("./dyn.js");')).toEqual(["./dyn.js"]);
  });

  it('side-effect-only `import "x"` counts as value', () => {
    expect(specifiersFromSource('import "./init.js";')).toEqual(["./init.js"]);
  });

  it('ImportTypeNode (`type Y = import("X").Foo`) is ignored', () => {
    expect(specifiersFromSource('type Y = import("./x.js").Foo;')).toEqual([]);
  });

  it("default + namespace bindings count as value", () => {
    expect(specifiersFromSource('import a from "./a.js";')).toEqual(["./a.js"]);
    expect(specifiersFromSource('import * as ns from "./ns.js";')).toEqual(["./ns.js"]);
  });

  it("bare specifiers (workspace pkgs, node builtins) do NOT resolve to in-pkg src — none counted as subjects", () => {
    // We DO list bare imports as specifiers (caller filters), so this
    // test pins behaviour at the resolver layer instead: passing them
    // through resolveSpecifier returns null.
    expect(resolveSpecifier("/tmp", "@emploke/catalog")).toBeNull();
    expect(resolveSpecifier("/tmp", "node:fs")).toBeNull();
    expect(resolveSpecifier("/tmp", "vitest")).toBeNull();
  });

  it("longestCommonDir handles single, multiple, and disjoint cases", () => {
    expect(longestCommonDir(["api"])).toBe("api");
    expect(longestCommonDir(["api/a", "api/b"])).toBe("api");
    expect(longestCommonDir(["api/a", "api/a/b"])).toBe("api/a");
    expect(longestCommonDir(["api/a", "pages/b"])).toBe("");
    expect(longestCommonDir(["components/foo", ""])).toBe("");
    expect(longestCommonDir(["components/x", "components"])).toBe("components");
  });
});
