/**
 * Tripwire test for `packages/workflow/src/_engine.ts`.
 *
 * Per spec #325 D3 and the M1 brief: the engine module MUST NOT
 * contain `setInterval` or `setTimeout`. All polling cadence lives
 * inside concrete runner implementations (e.g.
 * `packages/api/src/wiring/workflow-task-runner.ts`).
 *
 * This is a SOURCE-level grep — strings appearing inside JSDoc
 * comments (e.g. "MUST NOT contain `setInterval`") are intentionally
 * suffixed with backticks so they don't match the bare token; the
 * test only flags real call-sites by requiring an opening parenthesis
 * after the token. The matching pattern is restrictive enough that
 * `setIntervalMs` (an opt name) or `pollIntervalMs` won't fire, but
 * a bare `setInterval(...)` or `setTimeout(...)` will.
 *
 * If you NEED a deferred callback in the engine, you've discovered a
 * spec violation — stop and surface the discrepancy per the brief's
 * "STOP and report" rule, then fix the spec; do not work around this
 * tripwire.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(__dirname, "..", "src", "_engine.ts");

describe("@emploke/workflow engine tripwire", () => {
  it("_engine.ts contains no setInterval or setTimeout call sites", () => {
    const src = readFileSync(enginePath, "utf8");
    // Match the function-call form: token immediately followed by an
    // opening paren. This deliberately allows JSDoc comments to
    // mention `setInterval` / `setTimeout` as long as the backtick-
    // wrapped reference doesn't get followed by `(`.
    const callRe = /\b(setInterval|setTimeout)\s*\(/g;
    const matches = src.match(callRe) ?? [];
    expect(matches, `Found timer call(s) in _engine.ts: ${matches.join(", ")}`).toEqual([]);
  });
});
