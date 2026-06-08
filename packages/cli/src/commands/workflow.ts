/**
 * `emploke workflow …` — 5 subcommands wrapping the workspace-scoped
 * workflows HTTP surface (list / create / show / dag / cancel) shipped
 * by PR #330's M2 coordinator-runner landing.
 *
 * Shape mirrors `commands/schedule.ts` exactly — every function takes
 * opts, returns a `CommandResult`, and the commander wiring lives in
 * `../registrars/workflow.ts`. No commander imports here; this file is
 * pure business logic so tests can call the functions directly without
 * going through argv parsing.
 *
 * Flag-name choices:
 *  - `--brief` (not `--name`) for create — matches
 *    `CreateWorkflowBody.brief` on the wire and the
 *    `schedule create --brief` / `task dispatch --brief` precedent.
 *  - `--coord-agent` for the coordinator agent FQN, mapping to
 *    `CreateWorkflowBody.coordinatorAgent`.
 *  - `--wfid` (not a positional `<wfid>`) for show/dag/cancel — keeps
 *    the surface uniform with the rest of the workflow tree (no
 *    workflow command takes a positional id; an explicit flag pairs
 *    naturally with `--workspace` / `EMPLOKE_WORKSPACE`).
 *  - `--reason` on cancel is accepted for forward-compat with M3
 *    `outcomeReason` (#334). It is NOT sent on the wire today: the
 *    `workflows.cancel` route's contract has no `body` slot per R3
 *    sign-off (#pullrequestreview-4447183019). The flag is parsed so
 *    callers can adopt it now; once the substrate persists the reason,
 *    flipping the wire to include it is a one-line change here with no
 *    user-visible flag churn.
 */

import type { WorkflowHeaderWire, WorkflowStatusWire } from "@emploke/contracts";
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

const KNOWN_STATUSES: readonly WorkflowStatusWire[] = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

function isWorkflowStatus(s: string): s is WorkflowStatusWire {
  return (KNOWN_STATUSES as readonly string[]).includes(s);
}

// ─── list ──────────────────────────────────────────────────────────────
export interface WorkflowListOpts extends CommonFlags {
  /** Lifecycle status filter. One of {@link KNOWN_STATUSES}. */
  readonly status?: string;
}

export async function workflowList(opts: WorkflowListOpts = {}): Promise<CommandResult> {
  if (opts.status !== undefined && !isWorkflowStatus(opts.status)) {
    return {
      exitCode: 2,
      stderr: `--status must be one of: ${KNOWN_STATUSES.join(", ")}\n`,
    };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const query: { status?: WorkflowStatusWire } = {};
    if (opts.status !== undefined) query.status = opts.status as WorkflowStatusWire;
    const list = await client.call("workflows.list", { params: { id }, query });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["id", "brief", "coordinatorAgent", "status", "iterationCount", "createdAt"],
        list.map((wf) => [
          wf.id,
          wf.brief,
          wf.coordinatorAgent,
          wf.status,
          // `iterationCount` is projected as `0` on every list row by
          // design (see route doc-block: keeps the endpoint O(workflows)).
          // The number-as-string cast is just for table padding; callers
          // wanting the accurate count use `workflow show`.
          String(wf.iterationCount),
          wf.createdAt,
        ]),
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
  /** Optional multi-line workflow context. Maps to `CreateWorkflowBody.details`. */
  readonly details?: string;
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
    const body: {
      brief: string;
      coordinatorAgent: string;
      details?: string;
    } = {
      brief: opts.brief,
      coordinatorAgent: opts.coordAgent,
    };
    if (opts.details !== undefined) body.details = opts.details;
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
   * Forward-compat free-text reason. Accepted but NOT sent on the
   * wire today — `workflows.cancel`'s contract has no `body` slot
   * (per R3 sign-off of PR #330 / #pullrequestreview-4447183019).
   * Plumbed through so callers can adopt the flag now; the M3 work
   * tracked in #334 will start persisting it.
   */
  readonly reason?: string;
}

export async function workflowCancel(opts: WorkflowCancelOpts): Promise<CommandResult> {
  if (typeof opts.wfid !== "string" || opts.wfid.trim() === "") {
    return { exitCode: 2, stderr: "workflow id is required (--wfid <id>)\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    // `--reason` is intentionally NOT included in the call options
    // here: the route's typed contract has no `body` slot, so a body
    // would either fail to type-check or have to be smuggled in via
    // `callRaw`. The dashboard / MCP surfaces have the same gap and
    // also discard the value today. See `--reason` doc-block above.
    const updated = await client.call("workflows.cancel", {
      params: { id, wfid: opts.wfid },
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
