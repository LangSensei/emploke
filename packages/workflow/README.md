# @emploke/workflow

Append-only DAG substrate for emploke. Owns three tables —
`workflows` / `workflow_nodes` / `workflow_edges` — plus the entity
invariants (DAG, forward-only FSM, append-only nodes/edges) and the
8-tool orchestrator surface (`createWorkflow`, `createNode`,
`addEdge`, `launchNode`, `markDone`, `markFailed`, `cancelNode`,
`finishWorkflow`).

v1 locks node `type` to `'task'`; `launchNode` dispatches the
backing task via an injected `TaskDispatcher` (`@emploke/task`'s
`TaskService.dispatch` is the production binding) with
`origin: 'workflow'`.

No HTTP / CLI / dashboard surface — those land in follow-up missions
M4 (HTTP+CLI) and M6 (dashboard).

## Layout

Standard `packages/_template` shape:

```
src/
  schema.ts             Drizzle table definitions (private)
  entity.ts             Workflow / WorkflowNodeValue value objects + invariants
  repository.ts         Drizzle-backed CRUD (private)
  service.ts            WorkflowService — 8 tools + reads
  compose.ts            composeWorkflowModule({ dbFile, taskDispatcher })
  testing.ts            openTestWorkflowDb() in-memory test helper
  paths.ts              workflowDir / workflowNodeDir helpers
  index.ts              public barrel
drizzle/                generated SQL migrations (committed)
```

## Invariants (TASK.md §4)

1. DAG — `addEdge` runs a DFS reach check and throws
   `WorkflowCycleError` on cycle.
2. Append-only nodes — no `removeNode` API.
3. Node FSM is strictly forward:
   `not_started → ready → running → succeeded|failed`. `cancelled` is
   reachable **only** from `not_started` (CEO O5).
4. Edges immutable once added; an upstream edge into a non-`not_started`
   node throws.
5. `launchNode` requires every upstream node to be `succeeded`.

Encoded in `entity.ts`; `repository.save` re-runs every invariant
before write.

## Wiring

`composeWorkflowModule({ dbFile, taskDispatcher })` is the only
production composition path. `taskDispatcher` is any object satisfying
the `TaskDispatcher` interface — in practice `@emploke/task`'s
`TaskService` (the `dispatch(opts)` method matches structurally).
