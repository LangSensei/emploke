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

- **8 mutation primitives**: `addNode`, `addEdge`,
  `addSubgraph`, `removeNode`, `removeEdge`, `replaceNodeSpec`,
  `cancelNode`, `finishWorkflow`. Each is independently atomic; the
  substrate has no monolithic-batch API.
- **4 read APIs**: `getWorkflow`, `getDag`, `getNode`, `getNodeDir`.

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

## Coord-callback API

The 8 mutation primitives on `WorkflowService` are exposed over HTTP
on `/api/workspaces/:id/workflows/:wfid/*` so a coordinator agent's
task can grow / shrink the DAG from its own process. HTTP routes
forward `workflowId` from the URL path and nothing else; the
substrate's only lifecycle gate is the workflow's own status — a
mutation against a terminal workflow surfaces
`WorkflowAlreadyTerminalError` → HTTP 409. Structural invariants
(coord-chain orphan / single-successor, parent-state rules,
sealing-rule rejection on non-`not_started` targets) still apply
and surface as their own typed errors.

| Verb     | Path                                       | Service method     | Body                                                                                                          | Response                                       |
| -------- | ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `POST`   | `/:wfid/nodes`                             | `addNode`          | `{ kind, spec, parents[] }`                                                                                   | `{ nodeId, phase }`                            |
| `POST`   | `/:wfid/edges`                             | `addEdge`          | `{ fromNodeId, toNodeId }`                                                                                    | `{ fromNodeId, toNodeId }`                     |
| `POST`   | `/:wfid/subgraph`                          | `addSubgraph`      | `{ nodes:[{tempId,kind,spec,existingParents?}], edges:[{from,to}] }` — `from`/`to` are `{nodeId}` or `{tempId}` | `{ insertedNodes:[{tempId,nodeId,phase}] }`    |
| `POST`   | `/:wfid/nodes/:nid/cancel`                 | `cancelNode`       | _none_                                                                                                        | `WorkflowNodeWire` (post-cancel projection)    |
| `POST`   | `/:wfid/finish`                            | `finishWorkflow`   | `{ outcome: "succeeded" \| "failed" }`                                                                        | `WorkflowHeaderWire` (post-finish projection)  |
| `DELETE` | `/:wfid/nodes/:nid`                        | `removeNode`       | _none_                                                                                                        | `204 No Content`                               |
| `DELETE` | `/:wfid/edges/:from/:to`                   | `removeEdge`       | _none_                                                                                                        | `204 No Content`                               |
| `PATCH`  | `/:wfid/nodes/:nid/spec`                   | `replaceNodeSpec`  | `{ newSpec }`                                                                                                 | `WorkflowNodeWire` (post-replace projection)   |

`NodeRefWire` on the wire is a structural-discriminator union — exactly
one of `{nodeId}` (resolve to an existing node) or `{tempId}` (resolve
to a temp node declared in the same `addSubgraph` batch). The route
boundary translates each shape to the substrate's tag-discriminated
`NodeRef` (`{kind:"existing",id}` / `{kind:"temp",tempId}`) before
calling the service.

### Error policy

| Substrate class                          | HTTP | Why                                                            |
| ---------------------------------------- | ---- | -------------------------------------------------------------- |
| `WorkflowNotFoundError`                  | 404  | addressing miss                                                |
| `WorkflowNodeNotFoundError`              | 404  | addressing miss                                                |
| `WorkflowEdgeNotFoundError`              | 404  | addressing miss                                                |
| `InvalidWorkflowIdError` / id grammar    | 400  | caller-fixable structural validation                           |
| `WorkflowNodeSpecError` (per-kind)       | 400  | caller-fixable spec validation                                 |
| `EmptyParentsError`                      | 400  | mutation body empty                                            |
| `WorkflowSubgraph*Error`                 | 400/409 | structural batch rules                                      |
| `WorkflowNodeKindUnknownError` etc.      | 400  | enum/kind guards (see `_error-policies/workflows.ts` doc)      |
| `WorkflowAlreadyTerminalError`           | 409  | CAS conflict — workflow is already terminal                    |
| `WorkflowNodeNotMutableError`            | 409  | sealing rule — status disallows the verb                       |
| `WorkflowEdgeCycleError`                 | 409  | DAG cycle would close                                          |
| `WorkflowRemoveNodeOrphansChildError`    | 409  | delete would orphan a child                                    |
| `WorkflowRemoveEdgeOrphansChildError`    | 409  | delete would orphan the to-node                                |

The CLI surface mirrors the HTTP surface 1:1 — every route has a
`emploke workflow <verb>` subcommand (`add-node`, `add-edge`,
`add-subgraph`, `remove-node`, `remove-edge`, `replace-spec`,
`cancel-node`, `finish`). Spec payloads are read from `--spec-file
<path>` so multi-line JSON survives shell quoting. See
`packages/cli/src/commands/workflow.ts` for the per-flag rationale.
