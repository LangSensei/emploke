import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted row for one workflow.
 *
 * The workflow is a header row carrying lifecycle status plus a
 * denormalized cache of the current coordinator agent FQN. All
 * structural state — nodes, edges, the coordinator chain — lives in
 * `workflow_nodes` / `workflow_edges`.
 *
 * `coordinator_agent` caches the FQN of the most-recently-created
 * coordinator-kind node's `spec.agent`. The substrate keeps it in
 * sync inside every coordinator INSERT transaction (via the single
 * `insertCoordNode` helper), so `"who's running this workflow?"`
 * answers from a single-row read instead of a join + ORDER BY.
 *
 * `status` is a 4-value enum: `running | succeeded | failed |
 * cancelled`. `running` is the only non-terminal value. There's no
 * separate `"is the coord awake right now?"` flag — that's derived
 * from `workflow_nodes` (live coord = a `coordinator`-kind node with
 * non-terminal status).
 *
 * `ended_at` is non-null iff `status` is terminal, but this and the
 * `coordinator_agent` denorm rule are engine-enforced inside the
 * mutation primitives, NOT DDL constraints, so the DDL stays
 * permissive across future tweaks.
 *
 * The workflow's on-disk directory is NOT stored — it's derived via
 * `workflowDir(workspaceDir, id)` so a workspace move only requires
 * a config change, never a row rewrite.
 *
 * Indexes serve two read patterns: dashboard listings filter on
 * `status`, and the "list workflows currently run by agent X" admin
 * lookup filters on `coordinator_agent`.
 */
export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    brief: text("brief").notNull(),
    cancellation: text("cancellation"),
    coordinatorAgent: text("coordinator_agent").notNull(),
    createdAt: text("created_at").notNull(),
    details: text("details"),
    endedAt: text("ended_at"),
    failure: text("failure"),
    metadata: text("metadata").notNull().default("{}"),
    startedAt: text("started_at"),
    status: text("status").notNull(),
    success: text("success"),
  },
  (t) => [
    index("workflows_status_idx").on(t.status),
    index("workflows_coordinator_agent_idx").on(t.coordinatorAgent),
  ],
);

/**
 * Persisted row for one workflow node.
 *
 * Polymorphic on `kind`. Two kinds ship: `'worker'` and `'coordinator'`.
 * (`'human'` is reserved for a future iteration.) The substrate is
 * kind-agnostic — each row is routed through a compose-time
 * `WorkflowNodeRunner` for kind-specific concerns (spec
 * validation, dispatch, cancel).
 *
 * `kind` and `spec_json` are stored without a column DEFAULT: every
 * INSERT must spell them out. This keeps the per-kind runner
 * indirection honest — there's no implicit "default kind" a
 * caller could rely on, and the substrate never invents a spec.
 *
 * `spec_json` is opaque JSON owned by the per-kind runner;
 * the substrate never introspects it. Cross-kind invariants (e.g.
 * "worker's `agent` exists in the catalog") are validated by the
 * runner's `validate(spec, ctx)` at insert time, not by SQL.
 *
 * `phase` is the node's topological depth = `MAX(parents.phase) + 1`
 * (roots are phase 0). It's recomputed across the `not_started`
 * subtree on every edge-mutating primitive. Used by UI for
 * hierarchical DAG rendering. The engine's dispatch-readiness check
 * walks edges directly, not phase, so phase has no engine
 * semantics — it's purely a render hint.
 *
 * `ended_at` is non-null iff `status` is terminal. Like the workflow
 * header, this is an engine-enforced invariant, not a DB constraint,
 * to keep the DDL portable.
 *
 * Indexes:
 *   - `workflow_nodes_workflow_idx` — per-workflow scans.
 *   - `workflow_nodes_status_idx` (composite `(workflow_id, status)`)
 *     — "ready nodes in this workflow" and similar per-workflow
 *     status-filtered scans.
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
  ],
);

/**
 * Persisted row for one DAG edge.
 *
 * Composite PK `(workflow_id, from_node_id, to_node_id)` enforces
 * edge uniqueness at the storage layer. Cycle rejection happens in
 * the mutation-primitive layer: each edge-introducing primitive runs
 * a DFS reach check before persist.
 *
 * No FK to `workflow_nodes.id` — drizzle-kit's SQLite migrator
 * leaves FKs opt-in, and the substrate already enforces endpoint
 * existence at the mutation-primitive layer.
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
