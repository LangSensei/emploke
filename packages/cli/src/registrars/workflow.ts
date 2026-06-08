/**
 * `workflow` subtree registrar. Mirrors `registrars/schedule.ts` —
 * each subcommand is a one-shot commander chain (`.command(…).option(…).action(…)`)
 * with no business logic; everything flows to `commands/workflow.ts`.
 *
 * Help-text, option flags, ordering, and command names are the
 * canonical surface for the M2.3 CLI; see `commands/workflow.ts`
 * doc-block for the design rationale behind each flag.
 *
 * M2.5 added: add-node / add-subgraph / add-edge / remove-node /
 * remove-edge / replace-spec / cancel-node / finish — the 8 mutation
 * primitives a coord agent calls via HTTP from its task.
 */

import type { Command } from "commander";
import {
  workflowAddEdge,
  workflowAddNode,
  workflowAddSubgraph,
  workflowCancel,
  workflowCancelNode,
  workflowCreate,
  workflowDag,
  workflowFinish,
  workflowList,
  workflowRemoveEdge,
  workflowRemoveNode,
  workflowReplaceSpec,
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

  // ─── M2.5 coord-callback mutations ───────────────────────────────────

  withWorkspaceFlags(workflowCmd.command("add-node"))
    .description("Coord-only: insert one node attached to one or more existing parents")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--kind <kind>", "Node kind (coordinator | worker)")
    .requiredOption("--spec-file <path>", "Path to JSON file holding the opaque per-kind spec")
    .option(
      "--parents <ids>",
      "Comma-separated parent node ids (≥1 required; substrate rejects empty)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowAddNode({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        kind: pickString(opts, "kind") ?? "",
        specFile: pickString(opts, "specFile") ?? "",
        ...optionalString(opts, "parents"),
      });
    });

  withWorkspaceFlags(workflowCmd.command("add-subgraph"))
    .description("Coord-only: insert N nodes + intra-batch edges atomically")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption(
      "--spec-file <path>",
      "Path to JSON file matching { nodes:[{tempId,kind,spec,existingParents?}], edges:[{from,to}] }",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowAddSubgraph({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        specFile: pickString(opts, "specFile") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("add-edge"))
    .description("Coord-only: add a single edge between two existing nodes")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--from <id>", "Source node id")
    .requiredOption("--to <id>", "Destination node id (must be not_started)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowAddEdge({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        from: pickString(opts, "from") ?? "",
        to: pickString(opts, "to") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("remove-node"))
    .description("Coord-only: delete a not_started node (and its adjacent edges)")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--nid <id>", "Node id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowRemoveNode({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        nid: pickString(opts, "nid") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("remove-edge"))
    .description(
      "Coord-only: delete a single edge (to-node must be not_started, ≥1 parent retained)",
    )
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--from <id>", "Source node id")
    .requiredOption("--to <id>", "Destination node id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowRemoveEdge({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        from: pickString(opts, "from") ?? "",
        to: pickString(opts, "to") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("replace-spec"))
    .description("Coord-only: re-validate + replace a node's opaque spec (kind cannot change)")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--nid <id>", "Node id")
    .requiredOption("--spec-file <path>", "Path to JSON file holding the new spec")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowReplaceSpec({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        nid: pickString(opts, "nid") ?? "",
        specFile: pickString(opts, "specFile") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("cancel-node"))
    .description(
      "Coord-only: cancel a single worker node (coord-kind targets are rejected with 409)",
    )
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--nid <id>", "Node id")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowCancelNode({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        nid: pickString(opts, "nid") ?? "",
      });
    });

  withWorkspaceFlags(workflowCmd.command("finish"))
    .description("Coord-only: flip the workflow terminal (outcome: succeeded | failed)")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--outcome <outcome>", "Terminal outcome (succeeded | failed)")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowFinish({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        outcome: pickString(opts, "outcome") ?? "",
      });
    });
}
