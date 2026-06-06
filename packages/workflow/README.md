# @emploke/workflow

Open substrate for workflow DAGs in emploke. Owns three tables —
`workflows` / `workflow_nodes` / `workflow_edges` — plus the entity
layer that round-trips them, the error catalog, and the
`WorkflowNodeKindHandler` interface that callers register concrete
kinds against at compose time.

> **Status: phased implementation in flight.** v1.0.0 is a
> ground-up rewrite of the v0.6.0 append-only-DAG substrate. Phase
> 0 (data layer) ships on `feat/workflow-v1` / [PR #320]. Phases
> 1-5 land progressively on the same branch — see
> `packages/workflow/SPEC.md` for the authoritative design and
> [PR #320] for the phase plan. The repository / service / engine
> wiring is stubbed in Phase 0 and lands in Phase 1+.
>
> [PR #320]: https://github.com/LangSensei/emploke/pull/320

## Substrate model (v1.0.0)

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
- **Kind-agnostic**: the substrate ships zero hard-coded kinds.
  Each kind (v1 baseline: `task`, `coordinator`) is registered at
  compose time via `workflowService.registerKind(kind, handler)`
  (Phase 1+). Mirrors `@emploke/schedule`'s `ScheduleKindHandler`.

## API surface (v1.0.0)

Two tiers on the service:

- **8 mutation primitives** (coord-only auth, D22): `addNode`,
  `addEdge`, `addSubgraph`, `removeNode`, `removeEdge`,
  `replaceNodeSpec`, `cancelNode`, `finishWorkflow`. Each is
  independently atomic; the substrate has no monolithic-batch API.
- **4 read APIs** (unauthed, in-DAG eval workers can call):
  `getWorkflow`, `getDag`, `getNode`, `getNodeDir`.

See `SPEC.md` §"Substrate API surface" for the full contract and
the per-primitive rejection rules.

## Layout

Standard `packages/_template` shape:

```
src/
  schema.ts             Drizzle table definitions (private)
  workflow-entity.ts    Row ↔ entity round-trip (header / node / edge)
  workflow-repository.ts Drizzle-backed CRUD (private, Phase 1+)
  workflow-service.ts   8 mutation primitives + 4 read APIs (Phase 1+)
  compose.ts            composeWorkflowModule({ dbFile, ... }) (Phase 1+)
  testing.ts            openTestWorkflowDb() in-memory test helper
  errors.ts             WorkflowError + 15 v1 subclasses
  validate.ts           Id-grammar + enum-membership guards (pure)
  paths.ts              workflowDir / workflowNodeDir helpers
  types.ts              FSM enums + handler interface + ctx
  index.ts              public barrel
drizzle/                generated SQL migrations (committed)
README.md               this file
SPEC.md                 authoritative locked design
```

## Phase 0 caveat

`WorkflowService`, `WorkflowRepository`, and `composeWorkflowModule`
are stubs in Phase 0 — they throw on call. The data layer
(`schema.ts`, `workflow-entity.ts`, `errors.ts`, `validate.ts`,
`types.ts`, `paths.ts`, drizzle migrations) is final and exported
from the barrel. Per-kind wire DTOs (`WorkflowTaskNodeSpec`,
`WorkflowCoordinatorNodeSpec`, `WorkflowNodeWireSpec`) live in
`@emploke/contracts` and are re-exported here.

Phase 1+ wires up the real implementation per `SPEC.md`. Until
then, downstream packages should not depend on the service or
repository symbols.

## Wiring (Phase 1+ preview)

```ts
const workflowModule = await composeWorkflowModule({ dbFile });
workflowModule.service.registerKind("task",        makeTaskNodeHandler({ ... }));
workflowModule.service.registerKind("coordinator", makeCoordinatorNodeHandler({ ... }));
```

Both handlers live in `packages/api/src/wiring/` (Phase 4) because
they bridge `@emploke/workflow`, `@emploke/task`, and
`@emploke/catalog`.
