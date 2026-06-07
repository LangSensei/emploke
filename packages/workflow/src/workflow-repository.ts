import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { WorkflowNodeNotFoundError, WorkflowNotFoundError } from "./errors.js";
import type * as schema from "./schema.js";
import {
  type WorkflowEdgeRow,
  type WorkflowNodeRow,
  type WorkflowRow,
  workflowEdges,
  workflowNodes,
  workflows,
} from "./schema.js";
import type { WorkflowNodeStatus, WorkflowStatus } from "./types.js";
import { assertValidWorkflowId, assertValidWorkflowNodeId } from "./validate.js";
import { WorkflowEdgeEntity, WorkflowEntity, WorkflowNodeEntity } from "./workflow-entity.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Resolved row for the cross-cut auth gate read. A single SQL JOIN
 * across `workflow_nodes` (caller) and `workflows` so the predicate
 * is evaluated atomically — a two-read pattern would race with
 * concurrent terminations.
 */
export interface CallerCoordContextRow {
  readonly callerKind: string;
  readonly callerStatus: WorkflowNodeStatus;
  readonly callerWorkflowId: string;
  readonly callerSpecJson: string;
  readonly workflowStatus: WorkflowStatus;
}

/**
 * Drizzle-backed CRUD for `workflows` / `workflow_nodes` /
 * `workflow_edges`. Private to the pkg: external callers go through
 * `WorkflowService`. Kind-blind: the repository never reads or writes
 * any spec payload beyond passing it through as opaque JSON.
 *
 * Defense-in-depth id validation lives here so the table grammar is
 * enforced even if a future caller forgets to validate at the boundary.
 *
 * Reads accept the package's `Db`; writes inside a transaction accept
 * the transactional `Db` handed back from `db.transaction((tx) => …)`
 * so multi-statement mutations can compose repository primitives
 * with raw SQL inside the same atomic boundary.
 */
export class WorkflowRepository {
  private readonly db: Db;

  constructor(opts: { readonly db: Db }) {
    this.db = opts.db;
  }

  // ─── Workflow row ────────────────────────────────────────

  async readWorkflow(id: string): Promise<WorkflowEntity | null> {
    assertValidWorkflowId(id);
    const row = this.db.select().from(workflows).where(eq(workflows.id, id)).get();
    return row === undefined ? null : WorkflowEntity.fromRow(row);
  }

  insertWorkflow(tx: Db, entity: WorkflowEntity): void {
    const row = entity.toRow();
    assertValidWorkflowId(row.id);
    tx.insert(workflows).values(row).run();
  }

  /**
   * CAS-guarded status transition. Returns true iff a row was
   * updated. Used by `finishWorkflow` / `cancelWorkflow` so a
   * second caller can't double-terminate; the 0-row outcome is the
   * canonical signal to throw `WorkflowAlreadyTerminalError`.
   */
  casUpdateWorkflowStatus(
    tx: Db,
    opts: {
      readonly id: string;
      readonly fromStatus: WorkflowStatus;
      readonly toStatus: WorkflowStatus;
      readonly endedAt: string;
    },
  ): boolean {
    assertValidWorkflowId(opts.id);
    const result = tx
      .update(workflows)
      .set({ status: opts.toStatus, endedAt: opts.endedAt })
      .where(and(eq(workflows.id, opts.id), eq(workflows.status, opts.fromStatus)))
      .run();
    return result.changes > 0;
  }

  /**
   * Targeted update of the `coordinator_agent` denormalization. Used
   * inside the same transaction as a coord-kind insert so the cached
   * value never drifts from the most-recently-inserted coord's
   * `spec.agent`.
   */
  updateWorkflowCoordinatorAgent(tx: Db, id: string, agent: string): void {
    assertValidWorkflowId(id);
    const result = tx
      .update(workflows)
      .set({ coordinatorAgent: agent })
      .where(eq(workflows.id, id))
      .run();
    if (result.changes === 0) throw new WorkflowNotFoundError(id);
  }

  // ─── Node row ────────────────────────────────────────────

  async readNode(id: string): Promise<WorkflowNodeEntity | null> {
    assertValidWorkflowNodeId(id);
    const row = this.db.select().from(workflowNodes).where(eq(workflowNodes.id, id)).get();
    return row === undefined ? null : WorkflowNodeEntity.fromRow(row);
  }

  async listNodesByWorkflow(workflowId: string): Promise<readonly WorkflowNodeEntity[]> {
    assertValidWorkflowId(workflowId);
    const rows = this.db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflowId))
      .all();
    return rows.map((row) => WorkflowNodeEntity.fromRow(row));
  }

  insertNode(tx: Db, entity: WorkflowNodeEntity): void {
    const row = entity.toRow();
    assertValidWorkflowNodeId(row.id);
    assertValidWorkflowId(row.workflowId);
    tx.insert(workflowNodes).values(row).run();
  }

  /**
   * Targeted update of node lifecycle fields. Only the fields
   * present on `opts` are mutated; the rest are left untouched
   * (drizzle's `.set()` projects to the explicit set clause).
   */
  updateNodeLifecycle(
    tx: Db,
    opts: {
      readonly id: string;
      readonly status?: WorkflowNodeStatus;
      readonly readyAt?: string | null;
      readonly runningAt?: string | null;
      readonly endedAt?: string | null;
    },
  ): void {
    assertValidWorkflowNodeId(opts.id);
    const patch: Partial<WorkflowNodeRow> = {};
    if (opts.status !== undefined) patch.status = opts.status;
    if (opts.readyAt !== undefined) patch.readyAt = opts.readyAt;
    if (opts.runningAt !== undefined) patch.runningAt = opts.runningAt;
    if (opts.endedAt !== undefined) patch.endedAt = opts.endedAt;
    const result = tx.update(workflowNodes).set(patch).where(eq(workflowNodes.id, opts.id)).run();
    if (result.changes === 0) throw new WorkflowNodeNotFoundError("<unknown>", opts.id);
  }

  /**
   * Bulk phase update for the not_started subtree rooted at a node.
   * Each entry of `diff` is a `(nodeId, newPhase)` pair. Issued as a
   * sequence of single-row updates inside the caller's transaction.
   */
  updateNodePhases(tx: Db, diff: ReadonlyMap<string, number>): void {
    for (const [id, phase] of diff) {
      assertValidWorkflowNodeId(id);
      tx.update(workflowNodes).set({ phase }).where(eq(workflowNodes.id, id)).run();
    }
  }

  /**
   * Project just the columns needed by registry preflight so the
   * preflight scan doesn't pull every `spec_json` blob into memory.
   */
  async allRowsForPreflight(): Promise<readonly { readonly id: string; readonly kind: string }[]> {
    return this.db
      .select({ id: workflowNodes.id, kind: workflowNodes.kind })
      .from(workflowNodes)
      .all();
  }

  // ─── Edge row ────────────────────────────────────────────

  async listEdgesByWorkflow(workflowId: string): Promise<readonly WorkflowEdgeEntity[]> {
    assertValidWorkflowId(workflowId);
    const rows = this.db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, workflowId))
      .all();
    return rows.map((row) => WorkflowEdgeEntity.fromRow(row));
  }

  insertEdge(
    tx: Db,
    opts: { readonly workflowId: string; readonly from: string; readonly to: string },
  ): void {
    assertValidWorkflowId(opts.workflowId);
    assertValidWorkflowNodeId(opts.from);
    assertValidWorkflowNodeId(opts.to);
    tx.insert(workflowEdges)
      .values({
        workflowId: opts.workflowId,
        fromNodeId: opts.from,
        toNodeId: opts.to,
      })
      .run();
  }

  // ─── Auth-gate JOIN ──────────────────────────────────────

  /**
   * Single-statement JOIN backing the cross-cut mutation auth gate.
   * Reads the caller's `(kind, status, workflowId)` and the workflow's
   * `status` in one query so a concurrent termination on either side
   * cannot slip between two reads. Returns `null` when the caller node
   * does not exist (or the workflow row was deleted from underneath
   * it — should not happen, but the JOIN reports it consistently).
   */
  readCallerCoordContext(tx: Db, callerCoordNodeId: string): CallerCoordContextRow | null {
    assertValidWorkflowNodeId(callerCoordNodeId);
    const row = tx
      .select({
        callerKind: workflowNodes.kind,
        callerStatus: workflowNodes.status,
        callerWorkflowId: workflowNodes.workflowId,
        callerSpecJson: workflowNodes.specJson,
        workflowStatus: workflows.status,
      })
      .from(workflowNodes)
      .innerJoin(workflows, eq(workflows.id, workflowNodes.workflowId))
      .where(eq(workflowNodes.id, callerCoordNodeId))
      .get();
    if (row === undefined) return null;
    return {
      callerKind: row.callerKind,
      callerStatus: row.callerStatus as WorkflowNodeStatus,
      callerWorkflowId: row.callerWorkflowId,
      callerSpecJson: row.callerSpecJson,
      workflowStatus: row.workflowStatus as WorkflowStatus,
    };
  }

  // ─── Read-side helpers used by service primitives ────────

  /**
   * Fetch a set of node rows by id within one query. The substrate
   * needs this for parent-set reads inside the mutation tx (e.g.
   * checking parent statuses for `addNode`'s parent-state rule).
   */
  readNodesByIds(tx: Db, ids: readonly string[]): readonly WorkflowNodeEntity[] {
    if (ids.length === 0) return [];
    for (const id of ids) assertValidWorkflowNodeId(id);
    const rows = tx
      .select()
      .from(workflowNodes)
      .where(inArray(workflowNodes.id, ids as string[]))
      .all();
    return rows.map((row) => WorkflowNodeEntity.fromRow(row));
  }

  /**
   * Fetch all non-terminal nodes for a workflow inside the caller's
   * tx. Used by the cancel reconciliation paths in `finishWorkflow` /
   * `cancelWorkflow`.
   */
  listNonTerminalNodes(tx: Db, workflowId: string): readonly WorkflowNodeEntity[] {
    assertValidWorkflowId(workflowId);
    const nonTerminal: WorkflowNodeStatus[] = ["not_started", "ready", "running"];
    const rows = tx
      .select()
      .from(workflowNodes)
      .where(
        and(
          eq(workflowNodes.workflowId, workflowId),
          inArray(workflowNodes.status, nonTerminal as string[]),
        ),
      )
      .all();
    return rows.map((row) => WorkflowNodeEntity.fromRow(row));
  }

  /**
   * Tx-aware sibling of {@link listNodesByWorkflow}. Used by phase
   * recompute / dispatch readiness checks that must read inside the
   * caller's transaction so the just-inserted node / edge is visible.
   */
  listNodesByWorkflowTx(tx: Db, workflowId: string): readonly WorkflowNodeEntity[] {
    assertValidWorkflowId(workflowId);
    const rows = tx
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflowId))
      .all();
    return rows.map((row) => WorkflowNodeEntity.fromRow(row));
  }

  /**
   * Tx-aware sibling of {@link listEdgesByWorkflow}.
   */
  listEdgesByWorkflowTx(tx: Db, workflowId: string): readonly WorkflowEdgeEntity[] {
    assertValidWorkflowId(workflowId);
    const rows = tx
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, workflowId))
      .all();
    return rows.map((row) => WorkflowEdgeEntity.fromRow(row));
  }

  /**
   * Tx-aware read of a single workflow row. Used by mutation
   * primitives that need to read the header inside the auth tx.
   */
  readWorkflowTx(tx: Db, id: string): WorkflowEntity | null {
    assertValidWorkflowId(id);
    const row = tx.select().from(workflows).where(eq(workflows.id, id)).get();
    return row === undefined ? null : WorkflowEntity.fromRow(row);
  }

  /**
   * Tx-aware read of a single node. Used by mutation primitives that
   * need the latest persisted state (e.g. `dispatchAtomic` re-checks
   * the status inside the tx so a concurrent cancel wins the race).
   */
  readNodeTx(tx: Db, id: string): WorkflowNodeEntity | null {
    assertValidWorkflowNodeId(id);
    const row = tx.select().from(workflowNodes).where(eq(workflowNodes.id, id)).get();
    return row === undefined ? null : WorkflowNodeEntity.fromRow(row);
  }
}

// Re-export row helpers so the service layer keeps a single import root.
export type { WorkflowEdgeRow, WorkflowNodeRow, WorkflowRow };
