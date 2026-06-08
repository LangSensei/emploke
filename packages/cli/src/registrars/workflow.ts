/**
 * `workflow` subtree registrar. Mirrors `registrars/schedule.ts` —
 * each subcommand is a one-shot commander chain (`.command(…).option(…).action(…)`)
 * with no business logic; everything flows to `commands/workflow.ts`.
 *
 * Help-text, option flags, ordering, and command names are the
 * canonical surface for the M2.3 CLI; see `commands/workflow.ts`
 * doc-block for the design rationale behind each flag.
 */

import type { Command } from "commander";
import {
  workflowCancel,
  workflowCreate,
  workflowDag,
  workflowList,
  workflowShow,
} from "../commands/workflow.js";
import {
  optionalString,
  parseWorkspaceFlags,
  pickString,
  type Slot,
  withWorkspaceFlags,
} from "./_shared.js";

export function registerWorkflowCommands(program: Command, slot: Slot): void {
  const workflowCmd = program
    .command("workflow")
    .description("Workflow operations (workspace-scoped DAG runs)");

  withWorkspaceFlags(workflowCmd.command("list"))
    .description("List workflows in the current workspace")
    .option(
      "--status <status>",
      "Filter to one lifecycle status (running | succeeded | failed | cancelled)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowList({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "status"),
      });
    });

  withWorkspaceFlags(workflowCmd.command("create"))
    .description("Seed a new workflow + its initial coordinator node")
    .requiredOption("--brief <text>", "Workflow brief (non-empty)")
    .requiredOption(
      "--coord-agent <fqn>",
      "Coordinator agent FQN (e.g. emploke/coordinator); must declare the emploke/coordinator skill",
    )
    .option("--details <text>", "Optional multi-line workflow context")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowCreate({
        ...parseWorkspaceFlags(opts),
        brief: pickString(opts, "brief") ?? "",
        coordAgent: pickString(opts, "coordAgent") ?? "",
        ...optionalString(opts, "details"),
      });
    });

  withWorkspaceFlags(workflowCmd.command("show"))
    .description("Print one workflow's header (status, iterationCount, timestamps)")
    .requiredOption("--wfid <id>", "Workflow id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowShow({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("dag"))
    .description("Print the full DAG snapshot (header + nodes + edges)")
    .requiredOption("--wfid <id>", "Workflow id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowDag({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("cancel"))
    .description(
      "Cancel a running workflow (flips status → cancelled, reconciles non-terminal nodes)",
    )
    .requiredOption("--wfid <id>", "Workflow id")
    .option(
      "--reason <text>",
      "Free-text reason (forward-compat with M3 outcomeReason in #334; currently parsed but not sent)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowCancel({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        ...optionalString(opts, "reason"),
      });
    });
}
