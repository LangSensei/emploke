/**
 * `task` subtree registrar. Pure relocation from `index.ts` — the six
 * task commands have distinct option shapes (notably `dispatch`'s
 * `--details` / `--details-file` mutex and `activity`'s `--before` /
 * `--after` / `--limit` validation), so a data-driven loop would
 * actively hide the per-command argv prelude logic. The wiring stays
 * flat; only the file boundary moves.
 *
 * Help-text, option flags, ordering, command names, and the inline
 * prelude error messages are byte-identical to pre-refactor — these
 * are exercised by `test/argv-validation.test.ts`,
 * `test/task-activity.test.ts`, and `test/task-cancel.test.ts`.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  taskActivity,
  taskCancel,
  taskDispatch,
  taskList,
  taskRm,
  taskShow,
} from "../commands/task.js";
import type { CommandResult } from "../result.js";
import {
  optionalString,
  parseWorkspaceFlags,
  pickString,
  type Slot,
  withWorkspaceFlags,
} from "./_shared.js";

export function registerTaskCommands(program: Command, slot: Slot): void {
  const taskCmd = program.command("task").description("Task operations (workspace-scoped)");

  withWorkspaceFlags(taskCmd.command("list"))
    .description("List standalone tasks in the current workspace")
    .option("--agent <name>", "Filter by agent name")
    .option("--runtime <kind>", "Filter by runtime kind")
    .option("--created-since <iso>", "Drop tasks created before this ISO 8601 timestamp")
    .option("--status <csv>", "Comma-separated list (running, succeeded, failed, cancelled)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await taskList({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "agent"),
        ...optionalString(opts, "runtime"),
        ...optionalString(opts, "createdSince"),
        ...optionalString(opts, "status"),
      });
    });
  withWorkspaceFlags(taskCmd.command("dispatch"))
    .description("Dispatch a new task")
    .requiredOption("--agent <name>", "Agent to run")
    .requiredOption(
      "--brief <text>",
      "Single-line task title (required, ≤200 chars). Doubles as the displayed label.",
    )
    .option(
      "--details <text>",
      'Optional long-form task body (multi-line allowed; "" is treated as omitted)',
    )
    .option("--details-file <path>", "Read details from a file (mutually exclusive with --details)")
    .option("--runtime <kind>", "Runtime override (default: copilot)")
    .action(async (opts: Record<string, unknown>) => {
      const detailsInline = pickString(opts, "details");
      const detailsFile = pickString(opts, "detailsFile");
      if (detailsInline !== undefined && detailsFile !== undefined) {
        // Prefer a hard usage error over silent precedence: the user
        // almost certainly meant something specific, and dropping one
        // of the two would just make the resulting TASK.md confusing.
        slot.result = {
          exitCode: 2,
          stderr: "--details and --details-file are mutually exclusive\n",
        };
        return;
      }
      let details: string | undefined = detailsInline;
      if (detailsFile !== undefined) {
        try {
          details = readFileSync(detailsFile, "utf8");
        } catch (err) {
          slot.result = {
            exitCode: 2,
            stderr: `failed to read --details-file: ${err instanceof Error ? err.message : String(err)}\n`,
          };
          return;
        }
      }
      slot.result = await taskDispatch({
        ...parseWorkspaceFlags(opts),
        agent: pickString(opts, "agent") ?? "",
        brief: pickString(opts, "brief") ?? "",
        ...(details !== undefined ? { details } : {}),
        ...optionalString(opts, "runtime"),
      });
    });
  withWorkspaceFlags(taskCmd.command("show"))
    .argument("<tid>", "Task id")
    .description("Print one task's metadata")
    .action(async (tid: string, opts: Record<string, unknown>) => {
      slot.result = await taskShow({ ...parseWorkspaceFlags(opts), tid });
    });
  withWorkspaceFlags(taskCmd.command("rm"))
    .argument("<tid>", "Task id")
    .description(
      "Remove a task. Requires task to be in a terminal state. Use 'task cancel' first if still running.",
    )
    .option(
      "--purge",
      "Hard delete: also remove the task workdir and the runtime's per-task state (default is archive — row only)",
    )
    .action(async (tid: string, opts: Record<string, unknown>) => {
      slot.result = await taskRm({
        ...parseWorkspaceFlags(opts),
        tid,
        purge: opts.purge === true,
      });
    });
  withWorkspaceFlags(taskCmd.command("cancel"))
    .argument("<tid>", "Task id")
    .description(
      "Cancel a running task. Sends SIGTERM and marks cancelled. Use 'task rm' afterward to also delete the record.",
    )
    .action(async (tid: string, opts: Record<string, unknown>) => {
      slot.result = await taskCancel({ ...parseWorkspaceFlags(opts), tid });
    });
  withWorkspaceFlags(taskCmd.command("activity"))
    .argument("<tid>", "Task id")
    .description("Print the runtime-parsed activity timeline (JSON)")
    .option("-f, --follow", "Tail live activity over SSE; exits when task terminates")
    .option(
      "--before <seq>",
      "Backward pagination: return items with seq < before. Mutually exclusive with --after; cannot combine with --follow.",
    )
    .option(
      "--after <seq>",
      "Forward pagination: items with seq > after. With --follow, sent as Last-Event-ID.",
    )
    .option(
      "--limit <n>",
      "Maximum items per page (default 50, max 500). Ignored under --follow.",
      (v) => Number.parseInt(v, 10),
    )
    .action(async (tid: string, opts: Record<string, unknown>) => {
      // Validate `--before` / `--after` up front. Same rationale as the
      // historical --cursor check: a negative or non-numeric value
      // would silently fall through to "tail from now", looking like
      // a server bug. Reject loudly.
      const validateSeqFlag = (
        flagName: string,
        raw: unknown,
      ): { ok: true; value?: number } | { ok: false; result: CommandResult } => {
        if (raw === undefined) return { ok: true };
        const str = typeof raw === "string" ? raw : String(raw);
        const parsed = Number.parseInt(str, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || `${parsed}` !== str.trim()) {
          return {
            ok: false,
            result: {
              exitCode: 2,
              stderr: `${flagName} must be a non-negative integer (got ${JSON.stringify(str)})\n`,
            },
          };
        }
        return { ok: true, value: parsed };
      };
      const beforeCheck = validateSeqFlag("--before", opts.before);
      if (!beforeCheck.ok) {
        slot.result = beforeCheck.result;
        return;
      }
      const afterCheck = validateSeqFlag("--after", opts.after);
      if (!afterCheck.ok) {
        slot.result = afterCheck.result;
        return;
      }
      // `--limit` is meaningless under `--follow` (SSE streams until
      // the task terminates; there's no per-page cap). Silent
      // acceptance is worse than a hard error — the user almost
      // certainly meant something different. Reject the combo.
      if (opts.follow === true && opts.limit !== undefined) {
        slot.result = {
          exitCode: 2,
          stderr:
            "--limit has no effect with --follow (SSE streams until the task terminates).\n" +
            "  Drop --limit, or run a one-shot `task activity <tid> --limit <n>` first and then --follow.\n",
        };
        return;
      }
      const limit = typeof opts.limit === "number" ? opts.limit : undefined;
      slot.result = await taskActivity({
        ...parseWorkspaceFlags(opts),
        tid,
        follow: opts.follow === true,
        ...(beforeCheck.value !== undefined ? { before: beforeCheck.value } : {}),
        ...(afterCheck.value !== undefined ? { after: afterCheck.value } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    });
}
