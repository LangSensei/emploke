/**
 * `session` subtree registrar. Pure relocation from `index.ts` — the
 * five session commands all take a workspace flag bundle but otherwise
 * diverge in arguments and options, so a data-driven loop would only
 * obscure intent. The wiring stays flat; only the file boundary moves.
 *
 * Help-text, option flags, ordering, and command names are
 * byte-identical to pre-refactor.
 */

import type { Command } from "commander";
import {
  sessionList,
  sessionNew,
  sessionRm,
  sessionShow,
  sessionSpawn,
} from "../commands/session.js";
import {
  optionalString,
  parseWorkspaceFlags,
  pickString,
  type Slot,
  withWorkspaceFlags,
} from "./_shared.js";

export function registerSessionCommands(program: Command, slot: Slot): void {
  const sessionCmd = program
    .command("session")
    .description("Session operations (workspace-scoped)");

  withWorkspaceFlags(sessionCmd.command("list"))
    .description("List sessions in the current workspace")
    .option("--agent <name>", "Filter by agent name")
    .option("--created-since <iso>", "Drop sessions created before this ISO 8601 timestamp")
    .option("--active-since <iso>", "Drop sessions inactive before this ISO 8601 timestamp")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await sessionList({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "agent"),
        ...optionalString(opts, "createdSince"),
        ...optionalString(opts, "activeSince"),
      });
    });
  withWorkspaceFlags(sessionCmd.command("new"))
    .description("Create a new session")
    .requiredOption("--agent <name>", "Agent to bake into the session")
    .option("--runtime <kind>", "Runtime override (default: copilot)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await sessionNew({
        ...parseWorkspaceFlags(opts),
        agent: pickString(opts, "agent") ?? "",
        ...optionalString(opts, "runtime"),
      });
    });
  withWorkspaceFlags(sessionCmd.command("show"))
    .argument("<sid>", "Session id")
    .description("Print one session's metadata")
    .action(async (sid: string, opts: Record<string, unknown>) => {
      slot.result = await sessionShow({ ...parseWorkspaceFlags(opts), sid });
    });
  withWorkspaceFlags(sessionCmd.command("rm"))
    .argument("<sid>", "Session id")
    .description("Remove a session")
    .option(
      "--purge",
      "Hard delete: also remove the session workdir and the runtime's per-session state (default is archive — row only)",
    )
    .action(async (sid: string, opts: Record<string, unknown>) => {
      slot.result = await sessionRm({
        ...parseWorkspaceFlags(opts),
        sid,
        purge: opts.purge === true,
      });
    });
  withWorkspaceFlags(sessionCmd.command("spawn"))
    .argument("<sid>", "Session id")
    .description("Spawn a terminal for the session")
    .option("--remote", "Build a remote-launch command instead of local")
    .action(async (sid: string, opts: Record<string, unknown>) => {
      slot.result = await sessionSpawn({
        ...parseWorkspaceFlags(opts),
        sid,
        remote: opts.remote === true,
      });
    });
}
