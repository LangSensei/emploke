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

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  readJsonFileArg,
  workflowAddEdge,
  workflowAddNode,
  workflowAddSubgraph,
  workflowCancel,
  workflowCancelNode,
  workflowCreate,
  workflowDag,
  workflowFinish,
  workflowList,
  workflowNodeShow,
  workflowRecoverStuck,
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

/**
 * Classify a parsed JSON root for the error message when
 * `--metadata-file` rejects a non-object payload. Covers the four
 * shapes the validator rejects (`null`, `array`, `string`,
 * `number`/`boolean`) by name so the user knows exactly which case
 * was hit — `typeof null === "object"` (legacy JS quirk) is
 * specifically handled before the `typeof` fall-through.
 */
function jsonShape(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function registerWorkflowCommands(program: Command, slot: Slot): void {
  const workflowCmd = program
    .command("workflow")
    .description("Workflow operations (workspace-scoped DAG runs)");

  withWorkspaceFlags(workflowCmd.command("list"))
    .description("List workflows in the current workspace")
    .option("--q <pattern>", "Substring match on workflow id (HTTP query: q)")
    .option(
      "--coordinator-agent <value>",
      "Exact match on the workflow's denormalised coordinator-agent FQN (HTTP query: coordinatorAgent). The server validates FQN format; this CLI forwards the value verbatim.",
    )
    .option(
      "--created-since <iso>",
      "Drop workflows created before this ISO 8601 timestamp (HTTP query: createdSince)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowList({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "q"),
        ...optionalString(opts, "coordinatorAgent"),
        ...optionalString(opts, "createdSince"),
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
    .option(
      "--details-file <path>",
      "Read --details from a UTF-8 file (mutually exclusive with --details)",
    )
    .option(
      "--metadata-file <path>",
      "Path to a JSON object persisted verbatim on the workflow row as CreateWorkflowBody.metadata",
    )
    .action(async (opts: Record<string, unknown>) => {
      // `--details-file` / `--metadata-file` IO lives here in the
      // registrar (not in `commands/workflow.ts`) — same shape as the
      // `task dispatch` action just above: the registrar does
      // read+parse+validate, and the command function takes the
      // already-resolved string / object. Keeps the command-layer
      // body a thin pass-through to the HTTP client.
      const detailsInline = pickString(opts, "details");
      const detailsFile = pickString(opts, "detailsFile");
      if (detailsInline !== undefined && detailsFile !== undefined) {
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
      const metadataFile = pickString(opts, "metadataFile");
      let metadata: Readonly<Record<string, unknown>> | undefined;
      if (metadataFile !== undefined) {
        const parsed = readJsonFileArg("--metadata-file", metadataFile);
        if (!parsed.ok) {
          slot.result = { exitCode: 2, stderr: `${parsed.error}\n` };
          return;
        }
        const value = parsed.value;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          slot.result = {
            exitCode: 2,
            stderr: `--metadata-file must be a JSON object; got ${jsonShape(value)}\n`,
          };
          return;
        }
        metadata = value as Readonly<Record<string, unknown>>;
      }
      slot.result = await workflowCreate({
        ...parseWorkspaceFlags(opts),
        brief: pickString(opts, "brief") ?? "",
        coordAgent: pickString(opts, "coordAgent") ?? "",
        ...(details !== undefined ? { details } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
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

  withWorkspaceFlags(workflowCmd.command("node-show"))
    .description("Print one workflow node's projected wire shape (with taskId enrichment)")
    .requiredOption("--wfid <id>", "Workflow id")
    .requiredOption("--nid <id>", "Node id within the workflow")
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowNodeShow({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        nid: pickString(opts, "nid") ?? "",
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
      "--message <text>",
      "Free-text operator message persisted into cancellation.message (v2.2; defaults to empty)",
    )
    .option("--kind <kind>", 'Cancellation kind (v2.2 only emits "user"; defaults to "user")')
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowCancel({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        ...optionalString(opts, "message"),
        ...optionalString(opts, "kind"),
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
    .option(
      "--summary <text>",
      "Coordinator summary persisted into success.output (only with --outcome succeeded)",
    )
    .option(
      "--message <text>",
      "Failure message persisted into failure.message (required with --outcome failed)",
    )
    .action(async (opts: Record<string, unknown>) => {
      slot.result = await workflowFinish({
        ...parseWorkspaceFlags(opts),
        wfid: pickString(opts, "wfid") ?? "",
        outcome: pickString(opts, "outcome") ?? "",
        ...optionalString(opts, "summary"),
        ...optionalString(opts, "message"),
      });
    });

  withWorkspaceFlags(workflowCmd.command("recover-stuck"))
    .description(
      "Admin: insert a retry coord for a stuck workflow (--wfid <id>) or sweep all running (--all)",
    )
    .option("--wfid <id>", "Recover a single workflow if it's stuck")
    .option("--all", "Sweep all running workflows; recover any that are stuck")
    .action(async (opts: Record<string, unknown>) => {
      const all = opts.all === true;
      slot.result = await workflowRecoverStuck({
        ...parseWorkspaceFlags(opts),
        ...optionalString(opts, "wfid"),
        ...(all ? { all: true } : {}),
      });
    });
}
