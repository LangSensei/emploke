/**
 * Shared building blocks for the per-domain command registrars
 * (`catalog.ts`, `schedule.ts`, `session.ts`, `task.ts`) and for the
 * lifecycle / workspace wiring that remains in `../index.ts`.
 *
 * Two responsibilities live here:
 *   1. Flag-parsing helpers (`pickString`, `optionalString`,
 *      `parseConnectFlags`, `parseWorkspaceFlags`).
 *   2. Commander option-chain composers (`withConnectFlags`,
 *      `withWorkspaceFlags`) — these append the common API-call flags
 *      so every registration stays one `.option(...)` chain shorter.
 *
 * Everything here was previously inlined at the bottom of `index.ts`;
 * splitting it out lets the registrars import the helpers without a
 * circular dependency with `index.ts` itself.
 */

import type { Command } from "commander";
import type { CommandResult } from "../result.js";

/** Cross-action sink for {@link CommandResult} payloads emitted by every action. */
export interface Slot {
  result: CommandResult | null;
}

export interface ConnectFlagOpts {
  server?: string;
  output?: string;
  json?: boolean;
}

export interface WorkspaceFlagOpts extends ConnectFlagOpts {
  workspace?: string;
}

export function parseConnectFlags(opts: Record<string, unknown>): ConnectFlagOpts {
  const out: ConnectFlagOpts = {};
  const server = pickString(opts, "server");
  if (server !== undefined) out.server = server;
  const output = pickString(opts, "output");
  if (output !== undefined) out.output = output;
  if (opts.json === true) out.json = true;
  return out;
}

export function parseWorkspaceFlags(opts: Record<string, unknown>): WorkspaceFlagOpts {
  const out: WorkspaceFlagOpts = parseConnectFlags(opts);
  const workspace = pickString(opts, "workspace");
  if (workspace !== undefined) out.workspace = workspace;
  return out;
}

/**
 * Read a string flag from a commander opts bag, normalising empty strings
 * to `undefined`. This gives every CLI flag uniform "absent vs empty"
 * semantics: `--flag ""` is treated identically to omitting `--flag`.
 *
 * Rationale: the alternative — letting empty strings reach the wire —
 * would either cause server-side validation errors (`--name ""` creating
 * a workspace called "") or silently produce nonsense rows. The collapse
 * is applied uniformly across ~50 flag sites for predictability; per-flag
 * exceptions are explicitly rejected as ugly asymmetry. The two
 * "intentionally clear a string field" gestures in the CLI are
 * `schedule patch --clear-details` and `schedule patch --clear-runtime`,
 * which are separate boolean flags (not overloads of `--details` /
 * `--runtime`).
 *
 * Tests: see `packages/cli/test/pick-string-empty-collapse.test.ts`.
 */
export function pickString(opts: Record<string, unknown>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Conditional spread builder. Returns either `{}` or `{ <key>: value }`
 * so the caller can spread into an opts object without including
 * `undefined` properties (which would violate `exactOptionalPropertyTypes`).
 */
export function optionalString<K extends string>(
  opts: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  const v = pickString(opts, key);
  return v === undefined ? ({} as { [P in K]?: string }) : ({ [key]: v } as { [P in K]: string });
}

/**
 * Apply the common API-call flags (`--server`, `--output`, `--json`)
 * to a command. Pulled into a helper so each registration stays one
 * `.option(...)` chain shorter.
 */
export function withConnectFlags(c: Command): Command {
  return c
    .option("--server <url>", "Server URL (env: EMPLOKE_SERVER, runtime.json)")
    .option("--output <fmt>", "Output format: table | json")
    .option("--json", "Shorthand for --output json");
}

/** Workspace-scoped commands additionally take `--workspace`. */
export function withWorkspaceFlags(c: Command): Command {
  return withConnectFlags(c).option(
    "-w, --workspace <id>",
    "Workspace id (or set EMPLOKE_WORKSPACE; one is required)",
  );
}
