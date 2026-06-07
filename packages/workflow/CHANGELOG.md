# Changelog

All notable changes to `@emploke/workflow` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- `WorkflowRepository` — kind-blind drizzle CRUD for the
  `workflows` / `workflow_nodes` / `workflow_edges` tables. Reads
  return strongly-typed entities; multi-statement writes accept a
  transactional `db` handle so the service can compose primitives
  inside a single atomic boundary.
- `WorkflowService` — public mutation + read surface:
  - reads: `getWorkflow`, `getDag`, `getNode`, `getNodeDir`
  - mutations: `createWorkflow`, `addNode`, `addEdge`, `cancelNode`,
    `finishWorkflow`, `cancelWorkflow`
  - low-level engine entry point: `dispatchAtomic`
  - open per-kind handler registry: `registerKind(kind, handler)` +
    `recover()` (preflights every persisted row's `kind` against
    the registry; freezes the registry on first call)
- Errors: `WorkflowNodeKindAlreadyRegisteredError`,
  `WorkflowKindRegistryFrozenError`,
  `WorkflowNodeKindNotRegisteredError`.
- `composeWorkflowModule` now wires a real
  `{ repo, service, close }` triple over either a managed
  better-sqlite3 file or an injected drizzle `db`.

### Notes
- The substrate is hermetic: zero `@emploke/*` workspace
  dependencies. Per-kind concerns (catalog lookups, session
  spawning, etc.) live in caller-supplied
  `WorkflowNodeKindHandler` implementations.
- Mutation primitives evaluate the cross-cut auth predicate
  `caller.kind = 'coordinator' AND caller.status = 'running' AND
  workflow.status = 'running'` via a single SQL JOIN inside the
  mutation transaction. `cancelWorkflow` is the only mutation that
  bypasses this gate (external operator API).
- Async handler work (`validate`, `dispatch`, `cancel`) runs
  OUTSIDE the write transaction so handler calls never hold a SQLite
  write lock. On `dispatch` throw the substrate writes
  `status='failed'` via a separate transaction.
