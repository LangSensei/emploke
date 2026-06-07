# @emploke/workflow

Closed-kind substrate for workflow DAGs in emploke. Owns three tables —
`workflows` / `workflow_nodes` / `workflow_edges` — plus the entity
layer that round-trips them, the error catalog, and the
`WorkflowNodeRunner` interface that callers implement once per
`NodeKind` and inject at compose time.

> **Status: rewrite in progress.** This branch is a ground-up rewrite
> of the v0.6.0 append-only-DAG substrate. The data layer (schema,
> migrations, entities, errors, validate, types, paths) is final and
> exported. The service / repository / engine wiring is stubbed and
> throws on call. Active dev tracker: [PR #320]. Design discussion:
> [issue #321].
>
> [PR #320]: https://github.com/LangSensei/emploke/pull/320
> [issue #321]: https://github.com/LangSensei/emploke/issues/321

## Substrate model

The substrate is a **smart DAG database with FSM**. A coordinator
agent composes whatever DAG shape it wants by calling **mutation
primitives**; the substrate enforces structural invariants (no dup
id, terminal/running sealed, acyclic, exactly-one-non-terminal-
coord) and nothing else. The "shape" of a coord turn is the coord's
prerogative.

- **WorkflowStatus** is 4 values: `running | succeeded | failed |
  cancelled`. `running` is the only non-terminal value; "is the
  coord awake right now" is derived from `workflow_nodes`
  (`hasLiveCoord(nodes)` helper).
- **Coordinator** is first-class: every coord run is a
  `kind='coordinator'` node, not a row in a separate table. The
  current coord agent FQN is denormalized into
  `workflows.coordinator_agent` for cheap "who's running this
  workflow" queries.
- **Closed kind enum**: the substrate ships exactly two `NodeKind`
  values — `'coordinator'` and `'worker'`. Adding a new kind is a
  substrate change: extend `NodeKind`, add a matching field on
  `WorkflowRunners`, and the compiler walks every `switch (kind)`
  branch until each is handled.

## API surface

Two tiers on the service:

- **8 mutation primitives** (coord-only auth): `addNode`, `addEdge`,
  `addSubgraph`, `removeNode`, `removeEdge`, `replaceNodeSpec`,
  `cancelNode`, `finishWorkflow`. Each is independently atomic; the
  substrate has no monolithic-batch API.
- **4 read APIs** (unauthed, in-DAG eval workers can call):
  `getWorkflow`, `getDag`, `getNode`, `getNodeDir`.

## Layout

Standard `packages/_template` shape:

```
src/
  schema.ts             Drizzle table definitions (private)
  workflow-entity.ts    Row ↔ entity round-trip (header / node / edge)
  workflow-repository.ts Drizzle-backed CRUD (private)
  workflow-service.ts   Mutation primitives + read APIs
  compose.ts            composeWorkflowModule({ dbFile, runners, ... })
  testing.ts            openTestWorkflowDb() in-memory test helper
  errors.ts             WorkflowError + concrete subclasses
  validate.ts           Id-grammar + enum-membership guards (pure)
  paths.ts              workflowDir / workflowNodeDir helpers
  types.ts              NodeKind + FSM enums + runner interface + ctx
  index.ts              public barrel
drizzle/                generated SQL migrations (committed)
README.md               this file
```

## Wiring

Runners are injected at compose time. Both fields are non-optional,
so a missing runner is a TypeScript compile error rather than a
runtime throw:

```ts
const workflowModule = await composeWorkflowModule({
  dbFile,
  workspaceDir,
  runners: {
    coordinator: makeCoordinatorNodeRunner({ ... }),
    worker:      makeWorkerNodeRunner({ ... }),
  },
});
```

Both runners live in `packages/api/src/wiring/` because they bridge
`@emploke/workflow`, `@emploke/task`, and `@emploke/catalog`.
