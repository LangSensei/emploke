import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted row for one workflow (v1.0.0).
 *
 * Substrate model: the workflow is a header row carrying lifecycle
 * status + a denormalized cache of the current coordinator agent FQN
 * (D14). All structural state — nodes, edges, the coord chain — lives
 * in `workflow_nodes` / `workflow_edges`.
 *
 * Diff vs v0.6.0 (drop + recreate per D9 — no real users to migrate):
 *
 *   + `coordinator_agent` (TEXT NN)  — D14 denorm of latest coord
 *     node's `spec.agent`. Substrate keeps it in sync inside every
 *     `kind='coordinator'` INSERT tx (`insertCoordNode` helper,
 *     Phase 1+).
 *   - `outcome`                     — collapsed into the 4-value
 *     status enum (D6).
 *   ~ `archived_at` → `ended_at`    — aligns with `tasks.ended_at`
 *     (D7); non-null iff status is terminal (engine-enforced).
 *   ~ `status`                      — was 5 values, now 4 (D1):
 *     `running | succeeded | failed | cancelled`. `running` is the
 *     only non-terminal value; "is the coord awake right now" is
 *     derived from `workflow_nodes` (D15), not persisted here.
 *
 * Indexes added in v1: `workflows_status_idx` (status-filtered
 * dashboard listings — primary read pattern); `workflows_coordinator
 * _agent_idx` ("list workflows running agent X" admin lookup,
 * cheaper than re-deriving via JOIN).
 *
 * Workflow directory is NOT stored — derived via
 * `workflowDir(workspaceDir, id)` (D5; mirrors `tasks` convention).
 *
 * Cross-column invariants (`ended_at IS NOT NULL iff status terminal`,
 * `coordinator_agent = latest coord node's spec.agent`) are
 * engine-enforced (Phase 2+), NOT DDL constraints. The DDL stays
 * permissive so future schema tweaks don't require a migration.
 */
export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    brief: text("brief").notNull(),
    details: text("details"),
    coordinatorAgent: text("coordinator_agent").notNull(),
    status: text("status").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("workflows_status_idx").on(t.status),
    index("workflows_coordinator_agent_idx").on(t.coordinatorAgent),
  ],
);

/**
 * Persisted row for one workflow node (v1.0.0).
 *
 * Polymorphic on `kind` (renamed from v0.6.0's `type`). v1.0.0 ships
 * two kinds: `'task'` and `'coordinator'`; `'human'` is reserved for
 * a future iteration. The substrate is kind-agnostic — every kind is
 * routed through a `WorkflowNodeKindHandler` registered at compose
 * time (mirrors `@emploke/schedule`'s `ScheduleKindHandler`).
 *
 * Diff vs v0.6.0:
 *
 *   ~ `type` → `kind` (TEXT NN, **no DEFAULT** per D10; mirrors
 *     `schedules.target_kind`). The default-free shape forces every
 *     INSERT to spell the kind out, which makes the kind-handler
 *     registration story honest.
 *   ~ `spec` → `spec_json` (TEXT NN, **no DEFAULT**; mirrors
 *     `schedules.target_json`). Opaque JSON owned by the registered
 *     kind handler; the substrate never introspects it.
 *   - `data`                        — dropped entirely (D11). The
 *     substrate has no per-node mutable state; runtime state belongs
 *     to the backing unit (the task, the coord run dir).
 *   + `phase` (INTEGER NN)          — topological depth = `MAX(
 *     parents.phase) + 1` (D3). Substrate recomputes across the
 *     not_started subtree on every edge-mutating primitive. Used by
 *     UI for hierarchical DAG rendering. Not used by the engine's
 *     readiness check (which walks edges directly).
 *
 * Indexes:
 *   - `workflow_nodes_workflow_idx`        (workflow_id)
 *   - `workflow_nodes_status_idx`          (workflow_id, status)
 *     — composite for "ready nodes in this workflow" and similar
 *     per-workflow status-filtered scans.
 *   - `workflow_nodes_phase_idx`           (workflow_id, phase)
 *     — composite, NEW in v1. Sole consumer is the UI's `ORDER BY
 *     phase` rendering query. The engine does NOT use it (no
 *     "all of phase N terminal?" query exists in v1).
 *
 * `ended_at` is nullable; the engine-level invariant `status terminal
 * iff ended_at non-null` (Phase 2+) is NOT a DB constraint so the
 * DDL stays portable.
 */
export const workflowNodes = sqliteTable(
  "workflow_nodes",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    kind: text("kind").notNull(),
    specJson: text("spec_json").notNull(),
    phase: integer("phase").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    readyAt: text("ready_at"),
    runningAt: text("running_at"),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("workflow_nodes_workflow_idx").on(t.workflowId),
    index("workflow_nodes_status_idx").on(t.workflowId, t.status),
    index("workflow_nodes_phase_idx").on(t.workflowId, t.phase),
  ],
);

/**
 * Persisted row for one DAG edge (v1.0.0; unchanged from v0.6.0).
 *
 * Composite PK `(workflow_id, from_node_id, to_node_id)` enforces
 * edge uniqueness; cycle rejection is engine-layer (the substrate
 * runs a DFS reach check on every edge-introducing primitive before
 * persist).
 *
 * No FK to `workflow_nodes.id` because drizzle-kit's SQLite migrator
 * leaves FKs opt-in. The substrate enforces endpoint existence at
 * the mutation-primitive layer.
 */
export const workflowEdges = sqliteTable(
  "workflow_edges",
  {
    workflowId: text("workflow_id").notNull(),
    fromNodeId: text("from_node_id").notNull(),
    toNodeId: text("to_node_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workflowId, t.fromNodeId, t.toNodeId] }),
    index("workflow_edges_from_idx").on(t.workflowId, t.fromNodeId),
    index("workflow_edges_to_idx").on(t.workflowId, t.toNodeId),
  ],
);

export type WorkflowRow = typeof workflows.$inferSelect;
export type NewWorkflowRow = typeof workflows.$inferInsert;
export type WorkflowNodeRow = typeof workflowNodes.$inferSelect;
export type NewWorkflowNodeRow = typeof workflowNodes.$inferInsert;
export type WorkflowEdgeRow = typeof workflowEdges.$inferSelect;
export type NewWorkflowEdgeRow = typeof workflowEdges.$inferInsert;
