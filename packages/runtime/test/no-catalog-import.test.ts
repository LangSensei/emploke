/**
 * Architectural audit: `@emploke/runtime` MUST contain ZERO references
 * to `@emploke/catalog`. The two pkgs are decoupled by design — runtime
 * is the bottom layer of the package graph and never imports catalog,
 * not even as a test-only devDep. `CatalogService` satisfies runtime's
 * `AgentContentSource` port by structural typing only; the production
 * wiring layer (`@emploke/api`) is the sole composition root that
 * value-imports both.
 *
 * This file enforces two complementary scans:
 *
 *   1. AST scan of every `.ts` file under `src/` and `test/` for any
 *      import/export form whose module specifier is `@emploke/catalog`
 *      (or a subpath). The TS compiler API catches every cross-module
 *      reference shape:
 *        - `import ... from "..."` (named, default, namespace, side-effect)
 *        - `import type ...` (whole-clause type-only)
 *        - `export ... from "..."`
 *        - `import type * as ...`
 *        - `import("...")` (dynamic imports + ImportType nodes)
 *        - `require("...")` (CallExpression with Identifier callee)
 *        - `import foo = require("...")` (ImportEqualsDeclaration)
 *
 *   2. Substring scan of every config file under `packages/runtime/`
 *      (`package.json`, `tsconfig.json`, every sibling `*.config.{ts,
 *      mts,cts,js,mjs,cjs}`). This covers what the AST scan cannot —
 *      tsconfig path aliases, vitest aliases, package.json dependency
 *      maps. If a future config file ever names `@emploke/catalog`,
 *      this assertion catches it.
 *
 * `ALLOWED_VIOLATIONS` is empty by design — this audit is binary;
 * the whole point of P3 is to keep it empty. Adding an entry here
 * would defeat the purpose; either fix the import or argue (in a
 * fresh PR with explicit Goal-section amendment) why an exception
 * is warranted.
 *
 * The extractor pattern mirrors
 * `packages/e2e/test/architecture/inter-service-imports.test.ts`; cycle through
 * that file if you need to extend the AST coverage.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const RUNTIME_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DIR = path.join(RUNTIME_ROOT, "src");
const TEST_DIR = path.join(RUNTIME_ROOT, "test");
const SKIP_DIR_NAMES = new Set(["node_modules", "dist"]);

/** The banned module specifier (and any subpath of it). */
const BANNED = "@emploke/catalog";

/**
 * Empty by design — this audit is binary; the whole point of P3 is to
 * keep it empty. If you find yourself wanting to add an entry, raise
 * the question in a PR description first.
 */
const ALLOWED_VIOLATIONS: ReadonlySet<string> = new Set<string>();

interface Violation {
  /** Repo-relative path with forward-slash separators. */
  readonly file: string;
  /** 1-indexed source line where the offending specifier appears. */
  readonly line: number;
  /** The offending module specifier text. */
  readonly specifier: string;
  /** Which AST form fired: "import", "export", "import-type", … */
  readonly kind: string;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Recursively yield every `.ts` / `.tsx` file under `dir`. */
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
    } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
      yield path.join(dir, e.name);
    }
  }
}

function isBanned(specifier: string): boolean {
  return specifier === BANNED || specifier.startsWith(`${BANNED}/`);
}

function relPosix(absFile: string): string {
  return path.relative(RUNTIME_ROOT, absFile).split(path.sep).join("/");
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  // ts.getLineAndCharacterOfPosition is 0-indexed.
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Walk a parsed source file and collect every node whose module
 * specifier is `@emploke/catalog` (or a subpath). Returns the raw
 * list — the test bodies decide whether to filter against the
 * allowlist.
 */
function collectViolationsFromSource(absFile: string): Violation[] {
  const text = readFileSync(absFile, "utf8");
  const scriptKind = absFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, scriptKind);
  const found: Violation[] = [];
  const file = relPosix(absFile);

  function push(kind: string, node: ts.Node, specifier: string): void {
    found.push({ file, line: lineOf(sf, node), specifier, kind });
  }

  function visit(node: ts.Node): void {
    // import ... from "..."   (covers side-effect, default, namespace, named, type-only)
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec) && isBanned(spec.text)) {
        const kind = node.importClause?.isTypeOnly === true ? "import-type" : "import";
        push(kind, spec, spec.text);
      }
    }
    // export ... from "..."
    else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec !== undefined && ts.isStringLiteral(spec) && isBanned(spec.text)) {
        push(node.isTypeOnly ? "export-type" : "export", spec, spec.text);
      }
    }
    // import("...").Foo  (type-position dynamic import)
    else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (
        ts.isLiteralTypeNode(arg) &&
        ts.isStringLiteral(arg.literal) &&
        isBanned(arg.literal.text)
      ) {
        push("import-type-node", arg.literal, arg.literal.text);
      }
    }
    // import foo = require("...")
    else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (
        ts.isExternalModuleReference(ref) &&
        ts.isStringLiteral(ref.expression) &&
        isBanned(ref.expression.text)
      ) {
        push("import-equals", ref.expression, ref.expression.text);
      }
    }
    // Dynamic import("...") and CJS require("...")
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length >= 1) {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg) && isBanned(arg.text)) {
          push(isDynamicImport ? "dynamic-import" : "require", arg, arg.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function collectAllAstViolations(): Violation[] {
  const out: Violation[] = [];
  for (const root of [SRC_DIR, TEST_DIR]) {
    if (!safeIsDir(root)) continue;
    for (const abs of walkTsFiles(root)) {
      for (const v of collectViolationsFromSource(abs)) out.push(v);
    }
  }
  return out;
}

function formatViolation(v: Violation): string {
  return `${v.file}:${v.line} [${v.kind}] "${v.specifier}"`;
}

// ── audit: AST scan ────────────────────────────────────────────────────

describe("no @emploke/catalog imports in @emploke/runtime", () => {
  const violations = collectAllAstViolations();

  it("ALLOWED_VIOLATIONS is empty (binary audit; see file-level docstring)", () => {
    expect(ALLOWED_VIOLATIONS.size).toBe(0);
  });

  it("src/** and test/** contain ZERO @emploke/catalog AST references", () => {
    const unexcused = violations.filter((v) => !ALLOWED_VIOLATIONS.has(formatViolation(v)));
    expect(
      unexcused,
      `Found ${unexcused.length} @emploke/catalog reference(s) in @emploke/runtime:\n${unexcused
        .map(formatViolation)
        .join(
          "\n",
        )}\n\nRuntime must remain catalog-free. Either remove the import or argue (in a fresh PR with explicit goal-section amendment) why an exception is warranted.`,
    ).toEqual([]);
  });

  it("scanned at least one TS file (sanity check the walker isn't no-op'ing)", () => {
    let count = 0;
    for (const _ of walkTsFiles(SRC_DIR)) {
      count++;
      if (count > 0) break;
    }
    expect(count).toBeGreaterThan(0);
  });
});

// ── audit: config-file text scan ───────────────────────────────────────

/**
 * Covers what the AST audit cannot: package.json devDependencies,
 * tsconfig path aliases, vitest aliases — anything that names
 * `@emploke/catalog` in a non-`.ts` config file. The list is the union
 * of the two named files plus every sibling matching
 * `*.config.{ts,mts,cts,js,mjs,cjs}` so a future config file (e.g. a
 * tsup/biome/build config) is caught automatically.
 */
function listConfigFiles(): string[] {
  const out: string[] = [];
  const named = ["package.json", "tsconfig.json"];
  for (const n of named) {
    const p = path.join(RUNTIME_ROOT, n);
    try {
      if (statSync(p).isFile()) out.push(p);
    } catch {
      // missing — that's fine, the named-file list is best-effort.
    }
  }
  const configExts = new Set([
    ".config.ts",
    ".config.mts",
    ".config.cts",
    ".config.js",
    ".config.mjs",
    ".config.cjs",
  ]);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(RUNTIME_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    for (const ext of configExts) {
      if (e.name.endsWith(ext)) {
        out.push(path.join(RUNTIME_ROOT, e.name));
        break;
      }
    }
  }
  return out;
}

describe("no @emploke/catalog references in @emploke/runtime config files", () => {
  it("package.json / tsconfig.json / *.config.* are all catalog-free", () => {
    const offenders: string[] = [];
    for (const abs of listConfigFiles()) {
      const text = readFileSync(abs, "utf8");
      if (text.includes(BANNED)) {
        offenders.push(relPosix(abs));
      }
    }
    expect(
      offenders,
      `Config files mentioning ${BANNED}:\n${offenders.join("\n")}\n\nRemove the reference; runtime must not declare catalog as a (dev)dependency or alias it via tsconfig / vitest paths.`,
    ).toEqual([]);
  });
});
