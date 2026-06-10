import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { WorkflowNodeNotFoundError } from "./errors.js";
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

  /**
   * Unbounded list of workflow header rows ordered by `created_at`
   * descending (newest first). All four filter slots are AND-combined
   * when supplied; omitted slots widen the result set.
   *
   *   - `coordinatorAgent` — exact-match on `coordinator_agent`
   *     (denorm of the most-recent coord node's `spec.agent`). Uses
   *     the `workflows_coordinator_agent_idx` index.
   *   - `createdSince`     — ISO 8601 lower bound (inclusive) on
   *     `created_at`. Per-workspace volume is small enough that a
   *     full scan with a `WHERE created_at >= ?` clause is cheap
   *     enough not to need a dedicated index.
   *   - `idLike`           — substring match on the workflow id
   *     (case-sensitive, anchored on `LIKE %x%`). The SQL fragment
   *     escapes the `LIKE` metacharacters `%` / `_` so a literal id
   *     fragment from a search box doesn't accidentally widen.
   *
   * Per-workspace volume is small enough that pagination is not yet
   * needed — mirrors `ScheduleService.list` / `TaskService.list`
   * which are also unbounded on the same per-workspace scope.
   */
  async listWorkflows(opts?: {
    readonly coordinatorAgent?: string;
    readonly createdSince?: string;
    readonly idLike?: string;
  }): Promise<readonly WorkflowEntity[]> {
    const predicates = [];
    if (opts?.coordinatorAgent !== undefined) {
      predicates.push(eq(workflows.coordinatorAgent, opts.coordinatorAgent));
    }
    if (opts?.createdSince !== undefined) {
      predicates.push(gte(workflows.createdAt, opts.createdSince));
    }
    if (opts?.idLike !== undefined && opts.idLike !== "") {
      const pattern = `%${escapeLike(opts.idLike)}%`;
      predicates.push(sql`${workflows.id} LIKE ${pattern} ESCAPE '\\'`);
    }
    const where = predicates.length === 0 ? undefined : and(...predicates);
    const rows =
      where !== undefined
        ? this.db.select().from(workflows).where(where).orderBy(desc(workflows.createdAt)).all()
        : this.db.select().from(workflows).orderBy(desc(workflows.createdAt)).all();
    return rows.map((row) => WorkflowEntity.fromRow(row));
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
   *
   * Terminal-payload columns (`success` / `failure` / `cancellation`)
   * are written in the same UPDATE — exactly one of the three is
   * supplied by `finishWorkflow` / `cancelWorkflow` per the cross-
   * field invariant ("status='X' ⇒ X-payload column non-null"). The
   * service layer is responsible for picking the right one.
   */
  casUpdateWorkflowStatus(
    tx: Db,
    opts: {
      readonly id: string;
      readonly fromStatus: WorkflowStatus;
      readonly toStatus: WorkflowStatus;
      readonly endedAt: string;
      readonly successJson?: string;
      readonly failureJson?: string;
      readonly cancellationJson?: string;
    },
  ): boolean {
    assertValidWorkflowId(opts.id);
    const patch: Partial<typeof workflows.$inferInsert> = {
      status: opts.toStatus,
      endedAt: opts.endedAt,
    };
    if (opts.successJson !== undefined) patch.success = opts.successJson;
    if (opts.failureJson !== undefined) patch.failure = opts.failureJson;
    if (opts.cancellationJson !== undefined) patch.cancellation = opts.cancellationJson;
    const result = tx
      .update(workflows)
      .set(patch)
      .where(and(eq(workflows.id, opts.id), eq(workflows.status, opts.fromStatus)))
      .run();
    return result.changes > 0;
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
   * Replace a node's `spec_json` column with the JSON-encoded
   * `newSpec`. Used exclusively by `replaceNodeSpec` — the substrate
   * never overwrites `spec_json` from any other path. Throws
   * `WorkflowNodeNotFoundError` if the row is gone (concurrent
   * delete).
   */
  updateNodeSpecTx(tx: Db, id: string, newSpec: unknown): void {
    assertValidWorkflowNodeId(id);
    const result = tx
      .update(workflowNodes)
      .set({ specJson: JSON.stringify(newSpec) })
      .where(eq(workflowNodes.id, id))
      .run();
    if (result.changes === 0) throw new WorkflowNodeNotFoundError("<unknown>", id);
  }

  /**
   * Delete a single node row by id. Adjacent edges are NOT cascaded
   * by this helper — the caller must invoke
   * {@link deleteEdgesAdjacentToNodeTx} in the same tx so the edge
   * cleanup and the node delete are atomic.
   */
  deleteNodeTx(tx: Db, id: string): void {
    assertValidWorkflowNodeId(id);
    tx.delete(workflowNodes).where(eq(workflowNodes.id, id)).run();
  }

  /**
   * Update the denormalized `workflows.coordinator_agent` cache.
   * Used by `replaceNodeSpec` when the latest coord's spec is
   * mutated; the `insertCoordNodeInTx` path performs the same write
   * inline, but `replaceNodeSpec` cannot reuse that helper because
   * it doesn't INSERT the row.
   */
  updateWorkflowCoordinatorAgentTx(tx: Db, workflowId: string, agent: string): void {
    assertValidWorkflowId(workflowId);
    tx.update(workflows).set({ coordinatorAgent: agent }).where(eq(workflows.id, workflowId)).run();
  }

  /**
   * Return the id of the latest coordinator-kind node in a workflow,
   * ordered by `(created_at DESC, id DESC)`. The id tiebreaker
   * matters in fast test loops where two inserts can share a
   * millisecond timestamp; without it the "latest" choice would be
   * non-deterministic.
   *
   * Returns `null` if no coord-kind node exists (the bootstrap
   * window of `createWorkflow` between row inserts; not normally
   * reachable from `replaceNodeSpec`'s caller).
   */
  findLatestCoordIdTx(tx: Db, workflowId: string): string | null {
    assertValidWorkflowId(workflowId);
    const row = tx
      .select({ id: workflowNodes.id })
      .from(workflowNodes)
      .where(and(eq(workflowNodes.workflowId, workflowId), eq(workflowNodes.kind, "coordinator")))
      .orderBy(desc(workflowNodes.createdAt), desc(workflowNodes.id))
      .limit(1)
      .get();
    return row === undefined ? null : row.id;
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

  /**
   * Delete a single edge row. Returns true iff a row was actually
   * deleted (false on a (workflowId, from, to) that didn't exist —
   * the caller decides whether to surface as `WorkflowEdgeNotFoundError`
   * or treat as a no-op).
   */
  deleteEdgeTx(
    tx: Db,
    opts: { readonly workflowId: string; readonly from: string; readonly to: string },
  ): boolean {
    assertValidWorkflowId(opts.workflowId);
    assertValidWorkflowNodeId(opts.from);
    assertValidWorkflowNodeId(opts.to);
    const result = tx
      .delete(workflowEdges)
      .where(
        and(
          eq(workflowEdges.workflowId, opts.workflowId),
          eq(workflowEdges.fromNodeId, opts.from),
          eq(workflowEdges.toNodeId, opts.to),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /**
   * Delete every edge with `nodeId` as either endpoint. Used by
   * `removeNode` to cascade-clean the adjacency before the node row
   * delete (same tx — the substrate never persists dangling edges).
   */
  deleteEdgesAdjacentToNodeTx(tx: Db, workflowId: string, nodeId: string): void {
    assertValidWorkflowId(workflowId);
    assertValidWorkflowNodeId(nodeId);
    tx.delete(workflowEdges)
      .where(
        and(
          eq(workflowEdges.workflowId, workflowId),
          or(eq(workflowEdges.fromNodeId, nodeId), eq(workflowEdges.toNodeId, nodeId)),
        ),
      )
      .run();
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

  // ─── Stuck-coord recovery helpers ─────────────────────────

  /**
   * Tx-aware enumeration of the workflow's structural leaves — nodes
   * whose id never appears in any edge's `from_node_id` for this
   * workflow. Computed via an outer-join NOT-IN subquery so the query
   * stays single-trip and the substrate's small DAGs make the
   * O(N+E) cost a non-concern.
   *
   * Order is `(created_at, id)` ascending so the detector's
   * classifier sees a deterministic leaf list (the order isn't
   * semantically meaningful but determinism keeps test reasoning
   * tractable).
   */
  listLeavesInTx(tx: Db, workflowId: string): readonly WorkflowNodeEntity[] {
    assertValidWorkflowId(workflowId);
    const rows = tx
      .select()
      .from(workflowNodes)
      .where(
        and(
          eq(workflowNodes.workflowId, workflowId),
          sql`${workflowNodes.id} NOT IN (SELECT ${workflowEdges.fromNodeId} FROM ${workflowEdges} WHERE ${workflowEdges.workflowId} = ${workflowId})`,
        ),
      )
      .orderBy(workflowNodes.createdAt, workflowNodes.id)
      .all();
    return rows.map((row) => WorkflowNodeEntity.fromRow(row));
  }

  /**
   * Return the most-recent terminal coordinator-kind node for a
   * workflow ordered by `(ended_at DESC, created_at DESC, id DESC)`.
   * Used by the stuck-coord detector's
   * `workers_finished_without_coord` branch where the previous coord
   * has already terminated upstream of the worker leaves and the
   * retry coord needs an `of` pointer.
   *
   * Returns `null` if no terminal coord exists (the workflow is
   * either freshly created with only the bootstrap coord still
   * running, or a corrupted state where the coord chain is entirely
   * non-terminal — detector treats this as "not stuck").
   */
  findMostRecentCoordTerminalInTx(tx: Db, workflowId: string): WorkflowNodeEntity | null {
    assertValidWorkflowId(workflowId);
    const terminal: WorkflowNodeStatus[] = ["succeeded", "failed", "cancelled"];
    const row = tx
      .select()
      .from(workflowNodes)
      .where(
        and(
          eq(workflowNodes.workflowId, workflowId),
          eq(workflowNodes.kind, "coordinator"),
          inArray(workflowNodes.status, terminal as string[]),
        ),
      )
      .orderBy(desc(workflowNodes.endedAt), desc(workflowNodes.createdAt), desc(workflowNodes.id))
      .limit(1)
      .get();
    return row === undefined ? null : WorkflowNodeEntity.fromRow(row);
  }
}

/**
 * Escape SQL `LIKE` metacharacters in user-supplied substring search
 * input so the caller's payload is matched as a literal substring of
 * the column. SQLite's `LIKE` treats `%` (zero or more chars) and `_`
 * (single char) as wildcards; to forward them as literals we
 * pre-escape both (plus the escape character itself) with `\` and
 * the caller emits an explicit `ESCAPE '\'` clause in the SQL
 * fragment so the engine honours the escape.
 *
 * Effect: a bare `%` or `_` typed into the workflow id search box now
 * narrows to ids that contain the literal character — it no longer
 * silently collapses to a wildcard and widens the result set to all
 * rows. Mirrors the per-workspace search semantics most operators
 * expect (the search box takes id fragments, not SQL patterns).
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

// Re-export row helpers so the service layer keeps a single import root.
export type { WorkflowEdgeRow, WorkflowNodeRow, WorkflowRow };
