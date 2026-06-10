/**
 * `emploke workflow …` — workspace-scoped DAG run commands.
 *
 * Initial subcommand set (M2.3, PR #335): list / create / show / dag /
 * cancel.
 *
 * M2.5 (this file) adds the 8 coord-callback mutation primitives that
 * back the coordinator-agent contract:
 *  - `add-node` / `add-subgraph` / `add-edge`         — grow the DAG
 *  - `remove-node` / `remove-edge`                    — shrink it
 *  - `replace-spec`                                   — re-validate + swap
 *  - `cancel-node`                                    — terminate one worker
 *  - `finish`                                         — flip the workflow terminal
 *
 * Shape mirrors `commands/schedule.ts` exactly — every function takes
 * opts, returns a `CommandResult`, and the commander wiring lives in
 * `../registrars/workflow.ts`. No commander imports here; this file is
 * pure business logic so tests can call the functions directly without
 * going through argv parsing.
 *
 * Flag-name choices (M2.3):
 *  - `--brief` (not `--name`) for create — matches
 *    `CreateWorkflowBody.brief` on the wire and the
 *    `schedule create --brief` / `task dispatch --brief` precedent.
 *  - `--coord-agent` for the coordinator agent FQN, mapping to
 *    `CreateWorkflowBody.coordinatorAgent`.
 *  - `--wfid` (not a positional `<wfid>`) for show/dag/cancel — keeps
 *    the surface uniform with the rest of the workflow tree (no
 *    workflow command takes a positional id; an explicit flag pairs
 *    naturally with `--workspace` / `EMPLOKE_WORKSPACE`).
 *  - `--message` / `--kind` on cancel send the v2.2 terminal payload
 *    (`cancellation: { kind, message }`). Pre-v2.2 `--reason` is
 *    removed; the wire shape now requires `cancellation.message` so
 *    the flag has migrated from forward-compat placeholder to
 *    first-class wire field.
 *  - `--summary` on finish (succeeded path) → `success.output`.
 *    `--message` on finish (failed path) → `failure.message`.
 *
 * Flag-name choices (M2.5):
 *  - `--wfid <id>` is universal across every mutation command — the
 *    workflow id is the URL path arg, identical surface to show/dag.
 *  - `--kind <coordinator|worker>` for `add-node` / `add-subgraph`,
 *    matching the substrate's `NodeKind` (the wire alias is
 *    `WorkflowNodeKindWire`). Note: the existing dag-projection wire
 *    spells worker-kind as `"task"` for historical reasons (M1
 *    landing predates the kind rename); add/replace bodies use the
 *    substrate canonical names because they hit the un-projected
 *    write path.
 *  - `--spec-file <path>` (not inline `--spec`) for the opaque spec
 *    payload, because per-kind specs are routinely multi-line JSON
 *    (instructions, parents, etc) and shell-quoting is hostile. Same
 *    rationale as `catalog skill upsert --content-file`. No inline
 *    `--spec` overload is provided — agents always write a temp file
 *    via the host filesystem.
 *  - `--parents <ids>` on add-node is comma-separated; empty is
 *    rejected (substrate emits `EmptyParentsError` → 400). On
 *    add-subgraph, intra-batch parents go in the spec file via the
 *    nodes[].existingParents array.
 *  - `--from <id>` / `--to <id>` on add-edge / remove-edge — symmetric
 *    pair, names match the substrate args.
 *  - `--outcome <succeeded|failed>` on finish — the only enum-typed
 *    flag; both values are accepted (cancellation is the separate
 *    `workflow cancel` route).
 *
 * Auth note: every M2.5 command requires the caller to be running as
 * a workflow's coordinator task (the substrate's `WorkflowMutation
 * UnauthorizedError` → 403). A human at a terminal will get rejected
 * with a clear HTTP 403 + structured body; the CLI is here for
 * scripted use from a coord agent's task command line.
 */

import { readFileSync } from "node:fs";
import type {
  AddEdgeBody,
  AddNodeBody,
  AddSubgraphBody,
  CancelWorkflowBody,
  CreateWorkflowBody,
  FinishWorkflowBody,
  RecoverStuckBody,
  RecoverStuckResponse,
  ReplaceNodeSpecBody,
  WorkflowHeaderWire,
  WorkflowNodeKindWire,
  WorkflowNodeWire,
} from "@emploke/contracts";
import { makeClient, resolveWorkspace } from "../connect.js";
import { formatError, formatJson, formatRecord, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

interface CommonFlags {
  readonly server?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly output?: string;
  readonly json?: boolean;
}

// ─── list ──────────────────────────────────────────────────────────────
export interface WorkflowListOpts extends CommonFlags {
  /**
   * Case-sensitive substring match on the workflow id. Maps to the
   * HTTP query parameter `q` (the substrate forwards it to a SQL
   * `LIKE` predicate with the metacharacters escaped). Flag name
   * mirrors the wire param name.
   */
  readonly q?: string;
  /**
   * Exact match on the workflow's denormalised `coordinator_agent`
   * column. Maps to the HTTP query parameter `coordinatorAgent`.
   */
  readonly coordinatorAgent?: string;
  /**
   * ISO 8601 lower bound (inclusive) on `created_at`. Maps to the
   * HTTP query parameter `createdSince`. Mirrors
   * `task list --created-since` semantics.
   */
  readonly createdSince?: string;
}

export async function workflowList(opts: WorkflowListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const query: {
      q?: string;
      coordinatorAgent?: string;
      createdSince?: string;
    } = {};
    if (opts.q !== undefined) query.q = opts.q;
    if (opts.coordinatorAgent !== undefined) query.coordinatorAgent = opts.coordinatorAgent;
    if (opts.createdSince !== undefined) query.createdSince = opts.createdSince;
    const list = await client.call("workflows.list", { params: { id }, query });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["id", "brief", "coordinatorAgent", "status", "createdAt"],
        list.map((wf) => [wf.id, wf.brief, wf.coordinatorAgent, wf.status, wf.createdAt]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── create ────────────────────────────────────────────────────────────
export interface WorkflowCreateOpts extends CommonFlags {
  /** Workflow brief — non-empty. Maps to `CreateWorkflowBody.brief`. */
  readonly brief: string;
  /** Coordinator agent FQN — non-empty. Maps to `CreateWorkflowBody.coordinatorAgent`. */
  readonly coordAgent: string;
  /**
   * Optional multi-line workflow context. Maps to
   * `CreateWorkflowBody.details`. The registrar resolves
   * `--details-file <path>` into this same field before the call,
   * mirroring the `task dispatch` precedent (file IO lives in the
   * registrar, the command is a thin pass-through).
   */
  readonly details?: string;
  /**
   * Opaque metadata object persisted verbatim onto the workflow row.
   * Maps to `CreateWorkflowBody.metadata`. The registrar resolves
   * `--metadata-file <path>` (file read + JSON parse + object-shape
   * validation) into this field before the call.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function workflowCreate(opts: WorkflowCreateOpts): Promise<CommandResult> {
  if (typeof opts.brief !== "string" || opts.brief.trim() === "") {
    return { exitCode: 2, stderr: "missing required --brief <text>\n" };
  }
  if (typeof opts.coordAgent !== "string" || opts.coordAgent.trim() === "") {
    return { exitCode: 2, stderr: "missing required --coord-agent <fqn>\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: CreateWorkflowBody = {
      brief: opts.brief,
      coordinatorAgent: opts.coordAgent,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    };
    const created = await client.call("workflows.create", { params: { id }, body });
    return { exitCode: 0, stdout: renderHeader(created, opts) };
  } catch (err) {
    return formatError(err);
  }
}

// ─── show ──────────────────────────────────────────────────────────────
export interface WorkflowShowOpts extends CommonFlags {
  /** Workflow id. */
  readonly wfid: string;
}

export async function workflowShow(opts: WorkflowShowOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const found = await client.call("workflows.get", { params: { id, wfid: opts.wfid } });
    return { exitCode: 0, stdout: renderHeader(found, opts) };
  } catch (err) {
    return formatError(err);
  }
}

// ─── node-show ─────────────────────────────────────────────────────────
export interface WorkflowNodeShowOpts extends CommonFlags {
  /** Workflow id. */
  readonly wfid: string;
  /** Node id within the workflow. */
  readonly nid: string;
}

export async function workflowNodeShow(opts: WorkflowNodeShowOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.nid !== "string" || opts.nid.trim() === "") {
    return { exitCode: 2, stderr: "node id is required (--nid <id>)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const node = await client.call("workflows.getNode", {
      params: { id, wfid: opts.wfid, nid: opts.nid },
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(node) };
    const rows: Array<readonly [string, string]> = [
      ["id", node.id],
      ["workflowId", node.workflowId],
      ["phase", String(node.phase)],
      ["kind", node.spec.kind],
      ["status", node.status],
      ["agent", agentForSpec(node.spec)],
      ["createdAt", node.createdAt],
    ];
    if (node.readyAt !== undefined) rows.push(["readyAt", node.readyAt]);
    if (node.runningAt !== undefined) rows.push(["runningAt", node.runningAt]);
    if (node.endedAt !== undefined) rows.push(["endedAt", node.endedAt]);
    if (node.taskId !== undefined) rows.push(["taskId", node.taskId]);
    return {
      exitCode: 0,
      stdout: `${formatTable(
        ["field", "value"],
        rows.map(([k, v]) => [k, v]),
      )}\n`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── dag ───────────────────────────────────────────────────────────────
export interface WorkflowDagOpts extends CommonFlags {
  readonly wfid: string;
}

export async function workflowDag(opts: WorkflowDagOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const dag = await client.call("workflows.dag", { params: { id, wfid: opts.wfid } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(dag) };
    const nodesTable = formatTable(
      ["phase", "nodeId", "kind", "status", "agent"],
      dag.nodes.map((n) => [
        String(n.phase),
        n.id,
        n.spec.kind,
        n.status,
        // `agent` is present on both task-kind and coordinator-kind
        // spec wires (flattened by the contracts package). For any
        // future kind that projects through as the opaque envelope
        // `{ kind, spec }`, leave the agent column blank rather than
        // poking at `spec.agent` blindly.
        agentForSpec(n.spec),
      ]),
    );
    const edgeLines =
      dag.edges.length === 0
        ? "  (no edges)"
        : dag.edges.map((e) => `  ${e.from} → ${e.to}`).join("\n");
    const stdout = `${nodesTable}\nedges:\n${edgeLines}\n`;
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── cancel ────────────────────────────────────────────────────────────
export interface WorkflowCancelOpts extends CommonFlags {
  readonly wfid: string;
  /**
   * Free-text operator-supplied message persisted into the
   * workflow's `cancellation` JSON column. Empty string is allowed
   * but the flag itself MUST be present — the route rejects `{}` with
   * a 400 because the `cancellation.message` field is required by the
   * wire contract.
   */
  readonly message?: string;
  /**
   * Cancellation kind. Currently only `"user"` is emitted; the flag is
   * accepted as a forward-compatibility seam for future kinds.
   * Defaults to `"user"` when omitted.
   */
  readonly kind?: string;
}

export async function workflowCancel(opts: WorkflowCancelOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (opts.kind !== undefined && opts.kind !== "user") {
    return { exitCode: 2, stderr: '--kind must be "user" when supplied\n' };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: CancelWorkflowBody = {
      cancellation: { kind: "user", message: opts.message ?? "" },
    };
    const updated = await client.call("workflows.cancel", {
      params: { id, wfid: opts.wfid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(updated) };
    return {
      exitCode: 0,
      stdout: `workflow ${opts.wfid} cancelled\n${renderHeader(updated, opts)}`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

/** Render a {@link WorkflowHeaderWire} via either JSON or the record formatter. */
function renderHeader(
  header: WorkflowHeaderWire,
  flags: { readonly output?: string; readonly json?: boolean } | undefined,
): string {
  const fmt = pickFormat(flags, "table");
  if (fmt === "json") return formatJson(header);
  return formatRecord({ ...header });
}

/**
 * Pluck the `agent` field off a workflow-node wire spec. Task-kind
 * and coordinator-kind both carry it as a flat field; any future
 * opaque-envelope kind returns blank rather than risking a nonsense
 * key extraction on `spec.spec`.
 */
function agentForSpec(spec: { readonly kind: string; readonly agent?: string }): string {
  return typeof spec.agent === "string" ? spec.agent : "";
}

// ─── M2.5 coord-callback mutations ─────────────────────────────────────

const KNOWN_NODE_KINDS: readonly WorkflowNodeKindWire[] = ["coordinator", "worker"];
const KNOWN_FINISH_OUTCOMES: readonly ("succeeded" | "failed")[] = ["succeeded", "failed"];

function isNodeKind(s: string): s is WorkflowNodeKindWire {
  return (KNOWN_NODE_KINDS as readonly string[]).includes(s);
}

function isFinishOutcome(s: string): s is "succeeded" | "failed" {
  return (KNOWN_FINISH_OUTCOMES as readonly string[]).includes(s);
}

/**
 * Parse `--parents <id1,id2,...>`. Empty / unset returns `[]`; the
 * substrate rejects an empty list with `EmptyParentsError` → 400 for
 * every non-bootstrap insertion. The CLI does NOT pre-reject — the
 * server's rejection carries the canonical error name + status.
 *
 * Whitespace inside an id is preserved (substrate's
 * `InvalidWorkflowNodeIdError` will catch malformed ids); only the
 * outer comma-split is trimmed.
 */
function parseParents(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * Read a `<flagName> <path>` JSON file. Returns the parsed value or
 * an `{ ok: false, error }` envelope the caller surfaces as
 * exit-code-2 usage feedback. The parsed value is intentionally typed
 * `unknown` — the per-kind runner is the validator on the server, and
 * the CLI's job is to forward the JSON faithfully.
 *
 * The `flagName` parameter (e.g. `"--spec-file"`, `"--metadata-file"`)
 * is woven into both the "failed to read" and "JSON parse error"
 * messages so callers don't have to post-process the result.
 *
 * Exported because the workflow-create registrar reuses this helper
 * for `--metadata-file`, keeping the read+parse+error-wrap pattern
 * in one place (no per-call-site flag-name rewriting).
 *
 * Synchronous to mirror the `task dispatch` registrar's `readFileSync`
 * precedent; the await-cost of an extra microtask hop is meaningless
 * compared to the actual fs read but the sync shape keeps the
 * registrar action body flat and the helper signature easy to share
 * between the registrar (which uses sync fs) and the command-layer
 * callers (which previously used async fs).
 */
export function readJsonFileArg(
  flagName: string,
  value: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(value, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `failed to read ${flagName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return {
      ok: false,
      error: `${flagName} JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── add-node ──────────────────────────────────────────────────────────
export interface WorkflowAddNodeOpts extends CommonFlags {
  readonly wfid: string;
  readonly kind: string;
  readonly specFile: string;
  readonly parents?: string;
}

export async function workflowAddNode(opts: WorkflowAddNodeOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.kind !== "string" || !isNodeKind(opts.kind)) {
    return {
      exitCode: 2,
      stderr: `--kind must be one of: ${KNOWN_NODE_KINDS.join(", ")}\n`,
    };
  }
  if (typeof opts.specFile !== "string" || opts.specFile.trim() === "") {
    return { exitCode: 2, stderr: "missing required --spec-file <path>\n" };
  }
  const specResult = readJsonFileArg("--spec-file", opts.specFile);
  if (!specResult.ok) {
    return { exitCode: 2, stderr: `${specResult.error}\n` };
  }
  const spec = specResult.value;
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: AddNodeBody = {
      kind: opts.kind,
      spec,
      parents: parseParents(opts.parents),
    };
    const result = await client.call("workflows.addNode", {
      params: { id, wfid: opts.wfid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(result) };
    return { exitCode: 0, stdout: formatRecord({ ...result }) };
  } catch (err) {
    return formatError(err);
  }
}

// ─── add-subgraph ──────────────────────────────────────────────────────
export interface WorkflowAddSubgraphOpts extends CommonFlags {
  readonly wfid: string;
  /**
   * Path to a JSON file matching {@link AddSubgraphBody}:
   * `{ nodes: [{tempId, kind, spec, existingParents?}], edges: [{from, to}] }`.
   * NodeRefWire shapes (`{nodeId}` / `{tempId}`) are forwarded as-is.
   */
  readonly specFile: string;
}

export async function workflowAddSubgraph(opts: WorkflowAddSubgraphOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.specFile !== "string" || opts.specFile.trim() === "") {
    return { exitCode: 2, stderr: "missing required --spec-file <path>\n" };
  }
  const payloadResult = readJsonFileArg("--spec-file", opts.specFile);
  if (!payloadResult.ok) {
    return { exitCode: 2, stderr: `${payloadResult.error}\n` };
  }
  const payload = payloadResult.value;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { nodes?: unknown }).nodes) ||
    !Array.isArray((payload as { edges?: unknown }).edges)
  ) {
    return {
      exitCode: 2,
      stderr: "--spec-file must be a JSON object with `nodes` and `edges` arrays\n",
    };
  }
  const body = payload as unknown as AddSubgraphBody;
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("workflows.addSubgraph", {
      params: { id, wfid: opts.wfid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(result) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["tempId", "nodeId", "phase"],
        result.insertedNodes.map((n) => [n.tempId, n.nodeId, String(n.phase)]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── add-edge ──────────────────────────────────────────────────────────
export interface WorkflowAddEdgeOpts extends CommonFlags {
  readonly wfid: string;
  readonly from: string;
  readonly to: string;
}

export async function workflowAddEdge(opts: WorkflowAddEdgeOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.from !== "string" || opts.from.trim() === "") {
    return { exitCode: 2, stderr: "missing required --from <node-id>\n" };
  }
  if (typeof opts.to !== "string" || opts.to.trim() === "") {
    return { exitCode: 2, stderr: "missing required --to <node-id>\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: AddEdgeBody = { fromNodeId: opts.from, toNodeId: opts.to };
    const result = await client.call("workflows.addEdge", {
      params: { id, wfid: opts.wfid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(result) };
    return {
      exitCode: 0,
      stdout: `edge ${result.fromNodeId} → ${result.toNodeId} inserted (toPhase ${result.toPhase})\n`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── remove-node ───────────────────────────────────────────────────────
export interface WorkflowRemoveNodeOpts extends CommonFlags {
  readonly wfid: string;
  readonly nid: string;
}

export async function workflowRemoveNode(opts: WorkflowRemoveNodeOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.nid !== "string" || opts.nid.trim() === "") {
    return { exitCode: 2, stderr: "node id is required (--nid <id>)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    await client.call("workflows.removeNode", {
      params: { id, wfid: opts.wfid, nid: opts.nid },
    });
    return { exitCode: 0, stdout: `node ${opts.nid} removed from workflow ${opts.wfid}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── remove-edge ───────────────────────────────────────────────────────
export interface WorkflowRemoveEdgeOpts extends CommonFlags {
  readonly wfid: string;
  readonly from: string;
  readonly to: string;
}

export async function workflowRemoveEdge(opts: WorkflowRemoveEdgeOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.from !== "string" || opts.from.trim() === "") {
    return { exitCode: 2, stderr: "missing required --from <node-id>\n" };
  }
  if (typeof opts.to !== "string" || opts.to.trim() === "") {
    return { exitCode: 2, stderr: "missing required --to <node-id>\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    await client.call("workflows.removeEdge", {
      params: { id, wfid: opts.wfid, from: opts.from, to: opts.to },
    });
    return {
      exitCode: 0,
      stdout: `edge ${opts.from} → ${opts.to} removed from workflow ${opts.wfid}\n`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── replace-spec ──────────────────────────────────────────────────────
export interface WorkflowReplaceSpecOpts extends CommonFlags {
  readonly wfid: string;
  readonly nid: string;
  readonly specFile: string;
}

export async function workflowReplaceSpec(opts: WorkflowReplaceSpecOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.nid !== "string" || opts.nid.trim() === "") {
    return { exitCode: 2, stderr: "node id is required (--nid <id>)\n" };
  }
  if (typeof opts.specFile !== "string" || opts.specFile.trim() === "") {
    return { exitCode: 2, stderr: "missing required --spec-file <path>\n" };
  }
  const newSpecResult = readJsonFileArg("--spec-file", opts.specFile);
  if (!newSpecResult.ok) {
    return { exitCode: 2, stderr: `${newSpecResult.error}\n` };
  }
  const newSpec = newSpecResult.value;
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: ReplaceNodeSpecBody = { newSpec };
    const updated = await client.call("workflows.replaceNodeSpec", {
      params: { id, wfid: opts.wfid, nid: opts.nid },
      body,
    });
    return { exitCode: 0, stdout: renderNode(updated, opts) };
  } catch (err) {
    return formatError(err);
  }
}

// ─── cancel-node ───────────────────────────────────────────────────────
export interface WorkflowCancelNodeOpts extends CommonFlags {
  readonly wfid: string;
  readonly nid: string;
}

export async function workflowCancelNode(opts: WorkflowCancelNodeOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.nid !== "string" || opts.nid.trim() === "") {
    return { exitCode: 2, stderr: "node id is required (--nid <id>)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const updated = await client.call("workflows.cancelNode", {
      params: { id, wfid: opts.wfid, nid: opts.nid },
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(updated) };
    return { exitCode: 0, stdout: `node ${opts.nid} cancelled\n${renderNode(updated, opts)}` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── finish ────────────────────────────────────────────────────────────
export interface WorkflowFinishOpts extends CommonFlags {
  readonly wfid: string;
  readonly outcome: string;
  /**
   * Coordinator's free-form summary persisted into `success.output`
   * when `--outcome succeeded`. Mutually exclusive with `--message`.
   * `null` (no value supplied) is persisted as a null `output` field.
   */
  readonly summary?: string;
  /**
   * Failure message persisted into `failure.message` when
   * `--outcome failed`. REQUIRED when the outcome is `failed`
   * (empty string is allowed).
   */
  readonly message?: string;
}

export async function workflowFinish(opts: WorkflowFinishOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  if (typeof opts.outcome !== "string" || !isFinishOutcome(opts.outcome)) {
    return {
      exitCode: 2,
      stderr: `--outcome must be one of: ${KNOWN_FINISH_OUTCOMES.join(", ")}\n`,
    };
  }
  if (opts.outcome === "failed" && opts.message === undefined) {
    return {
      exitCode: 2,
      stderr: "--message is required when --outcome failed\n",
    };
  }
  if (opts.outcome === "succeeded" && opts.message !== undefined) {
    return {
      exitCode: 2,
      stderr: "--message is only valid with --outcome failed; use --summary instead\n",
    };
  }
  if (opts.outcome === "failed" && opts.summary !== undefined) {
    return {
      exitCode: 2,
      stderr: "--summary is only valid with --outcome succeeded; use --message instead\n",
    };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: FinishWorkflowBody =
      opts.outcome === "succeeded"
        ? { outcome: "succeeded", success: { output: opts.summary ?? null } }
        : { outcome: "failed", failure: { kind: "coordinator", message: opts.message ?? "" } };
    const updated = await client.call("workflows.finish", {
      params: { id, wfid: opts.wfid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(updated) };
    return {
      exitCode: 0,
      stdout: `workflow ${opts.wfid} finished as ${opts.outcome}\n${renderHeader(updated, opts)}`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── recover-stuck ─────────────────────────────────────────────────────
export interface WorkflowRecoverStuckOpts extends CommonFlags {
  /** Recover a single workflow if it's stuck. */
  readonly wfid?: string;
  /** Sweep all running workflows; recover any that are stuck. */
  readonly all?: boolean;
}

export async function workflowRecoverStuck(opts: WorkflowRecoverStuckOpts): Promise<CommandResult> {
  const hasWfid = typeof opts.wfid === "string" && opts.wfid.trim() !== "";
  const hasAll = opts.all === true;
  if (hasWfid === hasAll) {
    return {
      exitCode: 2,
      stderr: "exactly one of --wfid <id> or --all must be supplied\n",
    };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const body: RecoverStuckBody = hasAll ? { all: true } : { workflowId: opts.wfid as string };
    const response: RecoverStuckResponse = await client.call("workflows.recoverStuck", {
      params: { id },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(response) };
    if (response.results.length === 0) {
      return { exitCode: 0, stdout: "no running workflows scanned\n" };
    }
    const lines = response.results.map((r) =>
      r.inserted
        ? `${r.workflowId}: inserted retry coord ${r.retryNodeId} (reason=${r.reason}, attempt=${r.attempt})`
        : `${r.workflowId}: not stuck`,
    );
    const inserted = response.results.filter((r) => r.inserted).length;
    const footer = hasAll
      ? `\nscanned ${response.results.length} workflow(s); recovered ${inserted}`
      : "";
    return { exitCode: 0, stdout: `${lines.join("\n")}${footer}\n` };
  } catch (err) {
    return formatError(err);
  }
}

/** Render a {@link WorkflowNodeWire} via either JSON or the record formatter. */
function renderNode(
  node: WorkflowNodeWire,
  flags: { readonly output?: string; readonly json?: boolean } | undefined,
): string {
  const fmt = pickFormat(flags, "table");
  if (fmt === "json") return formatJson(node);
  return formatRecord({
    id: node.id,
    phase: node.phase,
    kind: node.spec.kind,
    status: node.status,
    agent: agentForSpec(node.spec),
    createdAt: node.createdAt,
    ...(node.readyAt !== undefined ? { readyAt: node.readyAt } : {}),
    ...(node.runningAt !== undefined ? { runningAt: node.runningAt } : {}),
    ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
  });
}
