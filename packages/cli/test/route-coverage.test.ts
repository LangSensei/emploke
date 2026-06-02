/**
 * Route-coverage drift guard.
 *
 * The route-manifest test on the server side asserts that every Hono
 * handler is in `ROUTES` and vice versa. That guarantees the **server**
 * side of the contract has no orphan routes — but it says nothing
 * about whether the **CLI** actually consumes them. We learnt this the
 * hard way: by the time anyone audited it, the CLI was missing 10 of
 * the 49 routes (catalog sync / acknowledge-prereqs / agent
 * enable-disable surface), and nothing in CI flagged it.
 *
 * This test closes that gap. For every key in `ROUTES`, we require at
 * least one `client.call(...)` or `client.callRaw(...)` invocation in
 * `packages/cli/src/**` referencing it. Adding a new route to the
 * manifest without wiring up a CLI command will fail this test until
 * a wrapper exists in `commands/`.
 *
 * If a route is intentionally NOT exposed to the CLI (e.g. a future
 * dashboard-only or MCP-only surface), add it to {@link ALLOWED_GAPS}
 * with a comment explaining why. The list is intentionally empty
 * today — every shipped route has a CLI consumer.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES, type RouteKey } from "@emploke/api";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(HERE, "..", "src");

/**
 * Routes that should NOT have a CLI command. Each entry MUST carry a
 * justification — "we forgot" is not one. If you find yourself adding
 * to this list, the bar is "the dashboard / MCP genuinely owns this
 * surface and a CLI wrapper would be misleading".
 */
const ALLOWED_GAPS: ReadonlySet<RouteKey> = new Set<RouteKey>([
  // Dashboard-only by design. The CLI used to wrap this as
  // `emploke workspace use <id>`, but the underlying
  // `currentWorkspace` is shared mutable global state across every
  // client of the same emploke server — using it to scope CLI
  // commands races with any other writer (other CLI processes, the
  // dashboard, AI agents). The CLI now requires `--workspace` or
  // `EMPLOKE_WORKSPACE` (process-local, race-free); the dashboard
  // still uses this route via its own UI to remember the
  // last-opened workspace as its own UX state. See
  // `commands/workspace.ts:workspaceUse` for the full rationale.
  "workspaces.setCurrent",
  "tasks.artifact", // dashboard-only download endpoint; CLI users have direct fs access to <workspace>/tasks/<tid>/artifact/
  "schedules.previewCron", // dashboard-only live-preview endpoint for the create-schedule modal (#222); CLI uses ScheduleService.preview directly via `emploke schedule create --preview`
]);

/**
 * Walk a directory recursively and yield every `*.ts` file path.
 * Skips `dist/` and `node_modules/` to avoid stale build output.
 */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

/**
 * Strip block comments (`/* … *\/`) before regex-scanning so that
 * `client.call("...")` literals appearing inside JSDoc examples
 * don't satisfy coverage. Line comments (`// …`) are also stripped,
 * but ONLY when they begin a line (with optional leading whitespace).
 *
 * The line-anchor matters: a naive `\/\/.*$` would also eat from the
 * `//` inside string literals like `"http://127.0.0.1:8787"` (look at
 * `connect.ts:DEFAULT_BASE_URL`), erasing everything after on the
 * same line — including any real `client.call(...)` site that happens
 * to share that line. Anchoring the match to start-of-line whitespace
 * keeps URL string literals intact while still catching the
 * `// TODO: client.call("foo")` style of false positive.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments / JSDoc
    .replace(/^\s*\/\/.*$/gm, ""); // full-line // comments only (NOT inline `// note`)
}

/**
 * Collect every route key string-literal'd into a `client.call(...)` or
 * `client.callRaw(...)` invocation across all CLI source files.
 *
 * The pattern is intentionally string-literal-only — a dynamic key
 * (`client.call(routeKey)`) would break the type-safety contract that
 * gives ApiClient its drift-protection in the first place, so we'd
 * rather fail loudly than silently accept it.
 */
function collectCalledKeys(): Set<string> {
  const re = /\bclient\.call(?:Raw)?\(\s*"([^"]+)"/g;
  const out = new Set<string>();
  for (const file of walk(CLI_SRC)) {
    const text = stripComments(readFileSync(file, "utf8"));
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(text);
      if (m === null) break;
      const key = m[1];
      if (key !== undefined) out.add(key);
    }
  }
  return out;
}

describe("CLI ↔ ROUTES coverage", () => {
  it("every manifest route has a CLI consumer (or is in ALLOWED_GAPS)", () => {
    const declared = new Set<string>(Object.keys(ROUTES));
    const called = collectCalledKeys();
    const uncovered = [...declared]
      .filter((k) => !called.has(k) && !ALLOWED_GAPS.has(k as RouteKey))
      .sort();
    expect(
      uncovered,
      "routes declared in ROUTES with no client.call(...) site in cli/src — wire a command in commands/ or document the gap in ALLOWED_GAPS",
    ).toEqual([]);
  });

  it("every called key actually exists in ROUTES (no typos)", () => {
    const declared = new Set<string>(Object.keys(ROUTES));
    const called = collectCalledKeys();
    const stray = [...called].filter((k) => !declared.has(k)).sort();
    expect(
      stray,
      "client.call(...) site references a key not in ROUTES — typo or stale after a manifest rename?",
    ).toEqual([]);
  });

  it("ALLOWED_GAPS only contains keys that are actually in ROUTES", () => {
    const declared = new Set<string>(Object.keys(ROUTES));
    const stale = [...ALLOWED_GAPS].filter((k) => !declared.has(k));
    expect(
      stale,
      "ALLOWED_GAPS still references routes that no longer exist in ROUTES — clean up",
    ).toEqual([]);
  });

  describe("stripComments", () => {
    // The earlier (broken) implementation of stripComments matched
    // `\/\/[^\n]*` unconditionally and would have eaten everything
    // after the `//` inside `"http://example.com"` — including any
    // `client.call(...)` site that happens to share the line. Pin
    // the contract: block comments / full-line comments out, string
    // literals (especially URLs) intact.

    it("strips JSDoc block comments", () => {
      const src = `/** @example client.call("foo") */\nclient.call("bar");`;
      const out = stripComments(src);
      expect(out).not.toContain('client.call("foo")');
      expect(out).toContain('client.call("bar")');
    });

    it("strips full-line // comments (with optional leading whitespace)", () => {
      const src = `  // TODO: add client.call("ghost") later\nawait client.call("real");`;
      const out = stripComments(src);
      expect(out).not.toContain('client.call("ghost")');
      expect(out).toContain('client.call("real")');
    });

    it("preserves URL string literals (regression: `//` inside strings)", () => {
      const src = `const u = "http://example.com"; await client.call("real");`;
      const out = stripComments(src);
      expect(out).toContain('"http://example.com"');
      expect(out).toContain('client.call("real")');
    });

    it("preserves trailing inline `//` comments and the code before them", () => {
      // We DELIBERATELY don't strip inline comments — doing so safely
      // would require a real lexer. Inline comments after code can't
      // create a fake `client.call` site (the call would have already
      // been counted), so leaving them in is harmless.
      const src = `await client.call("real"); // see https://example.com`;
      const out = stripComments(src);
      expect(out).toContain('client.call("real")');
    });
  });
});
