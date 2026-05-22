import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted row for one workflow. The substrate models a strictly
 * append-only DAG (CEO O5): rows are inserted once, the only mutable
 * column is `workflow_nodes.status` (forward-only), and `outcome` /
 * `archived_at` are stamped exactly once when the workflow archives.
 *
 * Verbatim columns from `IMPLEMENTATION_SPEC.md` §4.2 with one
 * normalization: `outcome` uses adjective form (`succeeded` /
 * `failed` / `cancelled`) to match the post-#119 Task enum. CEO sync
 * §"Open Question Resolutions" (O7) ratified the rename.
 *
 * Cross-column invariants (`outcome IS NOT NULL IFF status='archived'`)
 * live in `entity.ts`, not in DDL — matches the house rule (D11).
 */
export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  brief: text("brief").notNull(),
  details: text("details"),
  status: text("status").notNull(),
  outcome: text("outcome"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  archivedAt: text("archived_at"),
});

/**
 * Persisted row for one workflow node. Polymorphic on `type` (v1
 * locks to `'task'`); `spec` (immutable) + `data` (mutable) are
 * JSON-serialised application payloads — see spec §4.3 for the
 * shapes each node type carries.
 *
 * `workflow_id` is the only FK out of this table. The link to the
 * dispatched task lives application-layer in `data.task_id` per CEO
 * O1 (`tasks` table is intentionally NOT touched by this package).
 *
 * Status enum (`not_started → ready → running → succeeded|failed`,
 * with `cancelled` reachable only from `not_started`) is enforced in
 * `entity.ts`. DDL stays loose so future status additions don't need
 * a migration.
 */
export const workflowNodes = sqliteTable(
  "workflow_nodes",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    type: text("type").notNull().default("task"),
    status: text("status").notNull(),
    spec: text("spec").notNull().default("{}"),
    data: text("data").notNull().default("{}"),
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
 * Persisted row for one DAG edge. Composite PK `(workflow_id,
 * from_node_id, to_node_id)` enforces edge uniqueness; cycle
 * rejection is application-layer (`entity.addEdge` runs a DFS reach
 * check before persisting).
 *
 * No FK to `workflow_nodes.id` because drizzle-kit's SQLite migrator
 * leaves FKs opt-in (the cascade from the parent `workflows` row
 * matters at delete-time, but workflows are append-only per O5 so
 * deletes don't happen in normal operation). The substrate enforces
 * existence at the entity layer.
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
