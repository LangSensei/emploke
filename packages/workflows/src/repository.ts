import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { Workflow, WorkflowNodeValue } from "./entity.js";
import { CorruptedWorkflowError } from "./errors.js";
import type * as schema from "./schema.js";
import {
  type WorkflowEdgeRow,
  type WorkflowNodeRow,
  type WorkflowRow,
  workflowEdges,
  workflowNodes,
  workflows,
} from "./schema.js";
import type {
  WorkflowNodeStatus,
  WorkflowNodeType,
  WorkflowOutcome,
  WorkflowStatus,
} from "./types.js";
import { assertValidWorkflowId } from "./validate.js";

const silentLogger: Logger = pino({ level: "silent" });

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed CRUD for the workflow aggregate. Private to the
 * pkg: external callers go through {@link WorkflowsService}.
 *
 * `save` is whole-aggregate replace inside a single SQLite
 * transaction — the append-only invariant means rows only ever grow,
 * but the simplest way to keep the in-DB graph in sync with the
 * in-memory aggregate is to wipe + reinsert per workflow id (cheap
 * for v1's expected ~100-node graphs; revisit if the working set
 * ever grows past that).
 */
export class WorkflowsRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    void this.logger;
  }

  async read(id: string): Promise<Workflow | null> {
    assertValidWorkflowId(id);
    const wfRow = this.db.select().from(workflows).where(eq(workflows.id, id)).get();
    if (wfRow === undefined) return null;
    const nodeRows = this.db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, id))
      .all();
    const edgeRows = this.db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, id))
      .all();
    return rowsToWorkflow(wfRow, nodeRows, edgeRows);
  }

  async list(): Promise<Workflow[]> {
    const wfRows = this.db.select().from(workflows).all();
    const out: Workflow[] = [];
    for (const wfRow of wfRows) {
      const nodeRows = this.db
        .select()
        .from(workflowNodes)
        .where(eq(workflowNodes.workflowId, wfRow.id))
        .all();
      const edgeRows = this.db
        .select()
        .from(workflowEdges)
        .where(eq(workflowEdges.workflowId, wfRow.id))
        .all();
      try {
        out.push(rowsToWorkflow(wfRow, nodeRows, edgeRows));
      } catch (err) {
        this.logger.warn(
          { workflowId: wfRow.id, err },
          "workflows: skipping corrupted workflow row",
        );
      }
    }
    return out;
  }

  /**
   * Persist `wf` as the new whole-of-aggregate state. Runs every
   * invariant check before writing.
   *
   * Implementation: wrap delete-then-insert in better-sqlite3's
   * synchronous transaction. Append-only at the API level still
   * benefits from a wholesale rewrite at the SQL level — it gives us
   * a single durable point of truth per save() without having to
   * compute row-by-row diffs.
   */
  async save(wf: Workflow): Promise<void> {
    assertValidWorkflowId(wf.id);
    wf.assertInvariants();
    const wfRow = workflowToRow(wf);
    const nodeRows = wf.nodes.map((n) => nodeToRow(n));
    const edgeRows = wf.edges.map((e) => ({
      workflowId: wf.id,
      fromNodeId: e.from,
      toNodeId: e.to,
    }));

    const txn = (
      this.db as unknown as {
        transaction: (fn: (tx: Db) => void) => void;
      }
    ).transaction;
    txn.call(this.db, (tx: Db) => {
      tx.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
      tx.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();
      tx.insert(workflows)
        .values(wfRow)
        .onConflictDoUpdate({ target: workflows.id, set: wfRow })
        .run();
      if (nodeRows.length > 0) {
        tx.insert(workflowNodes).values(nodeRows).run();
      }
      if (edgeRows.length > 0) {
        tx.insert(workflowEdges).values(edgeRows).run();
      }
    });
  }
}

function workflowToRow(wf: Workflow): {
  id: string;
  brief: string;
  details: string | null;
  status: WorkflowStatus;
  outcome: WorkflowOutcome | null;
  metadata: string;
  createdAt: string;
  startedAt: string | null;
  archivedAt: string | null;
} {
  return {
    id: wf.id,
    brief: wf.brief,
    details: wf.details ?? null,
    status: wf.status,
    outcome: wf.outcome ?? null,
    metadata: JSON.stringify(wf.metadata),
    createdAt: wf.createdAt,
    startedAt: wf.startedAt ?? null,
    archivedAt: wf.archivedAt ?? null,
  };
}

function nodeToRow(n: WorkflowNodeValue): {
  id: string;
  workflowId: string;
  type: WorkflowNodeType;
  status: WorkflowNodeStatus;
  spec: string;
  data: string;
  createdAt: string;
  readyAt: string | null;
  runningAt: string | null;
  endedAt: string | null;
} {
  return {
    id: n.id,
    workflowId: n.workflowId,
    type: n.type,
    status: n.status,
    spec: JSON.stringify(n.spec),
    data: JSON.stringify(n.data),
    createdAt: n.createdAt,
    readyAt: n.readyAt ?? null,
    runningAt: n.runningAt ?? null,
    endedAt: n.endedAt ?? null,
  };
}

function rowsToWorkflow(
  wfRow: WorkflowRow,
  nodeRows: readonly WorkflowNodeRow[],
  edgeRows: readonly WorkflowEdgeRow[],
): Workflow {
  const metadata = parseJsonObject(wfRow.id, "workflow.metadata", wfRow.metadata);
  const nodes = nodeRows.map((r) => {
    const spec = parseJsonObject(wfRow.id, `node[${r.id}].spec`, r.spec);
    const data = parseJsonObject(wfRow.id, `node[${r.id}].data`, r.data);
    return new WorkflowNodeValue(
      r.id,
      r.workflowId,
      r.type as WorkflowNodeType,
      r.status as WorkflowNodeStatus,
      spec,
      data,
      r.createdAt,
      r.readyAt ?? undefined,
      r.runningAt ?? undefined,
      r.endedAt ?? undefined,
    );
  });
  const edges = edgeRows.map((r) => ({ from: r.fromNodeId, to: r.toNodeId }));
  return Workflow.fromStored({
    id: wfRow.id,
    brief: wfRow.brief,
    ...(wfRow.details !== null ? { details: wfRow.details } : {}),
    status: wfRow.status as WorkflowStatus,
    ...(wfRow.outcome !== null ? { outcome: wfRow.outcome as WorkflowOutcome } : {}),
    metadata,
    createdAt: wfRow.createdAt,
    ...(wfRow.startedAt !== null ? { startedAt: wfRow.startedAt } : {}),
    ...(wfRow.archivedAt !== null ? { archivedAt: wfRow.archivedAt } : {}),
    nodes,
    edges,
  });
}

function parseJsonObject(
  id: string,
  field: string,
  raw: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptedWorkflowError(id, `${field} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptedWorkflowError(id, `${field} must decode to an object`);
  }
  return parsed as Record<string, unknown>;
}
