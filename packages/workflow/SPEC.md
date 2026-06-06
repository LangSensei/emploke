# `@emploke/workflow` v1.0.0 substrate spec

**Status: LOCKED for implementation.** This is the authoritative spec
for the v1.0.0 rewrite of `@emploke/workflow` (replaces v0.6.0 entire-
ly per D9 — drop + recreate, no data migration). Implementation lands
on branch `feat/workflow-v1` in phases 0-5 (see PR description).

Originally drafted as `schema-v2.md` in the design mission folder; the
companion design discussion (`coord-eval-design-discussion.md`, the
prior `schema-v1.md` iteration, and `spec.md` v0.6.0 baseline) all
live in `.pilot/active-missions/20260604-workflow-v1-design/` in the
workspace root.

This is the second design iteration of the v1 workflow substrate.

The **first** iteration (`schema-v1.md`, kept for reference in the
same directory) used a flat-shorthand `advancePhase(workNodes[])`
API plus an implicit "coord-at-even-phase / work-at-odd-phase"
structural pattern. It was rejected as too rigid for eval / audit /
fan-in patterns.

An **intermediate** iteration (visible in this file's git history,
also folded into `coord-eval-design-discussion.md`) generalized
that to a single atomic `extendDag(insertion: SubDagInsertion)`
call per coord turn, with 13 validation rules baked in. It was
rejected as over-constraining: it conflated "how the substrate
protects its invariants" with "how the coord chooses to think
about a turn", and it forced a once-only side-effect guard into
the schema (Q-schema-5).

This iteration replaces the atomic API with **mutation primitives**
plus **read APIs**. The substrate becomes a minimal "smart DAG
database with FSM": coord composes whatever DAG shape it wants by
calling primitives; substrate enforces structural invariants (no
dup id, terminal/running sealed, acyclic, exactly-one-non-terminal-
coord) and nothing else. The "shape" of a coord turn is entirely
coord's prerogative.

See `coord-eval-design-discussion.md` for the design discussion
leading to this iteration.

## Scope

This document defines:

1. The **3 tables** `@emploke/workflow` owns (all modified from
   v0.6.0; none new). Same table set as schema-v1.
2. The 2 partial functional indexes added to `@emploke/task`'s
   existing `tasks` table. NO column changes to `tasks`. (Unchanged
   from schema-v1.)
3. The TS-layer FSM enums, the `WorkflowNodeKindHandler` substrate
   interface, the **two v1 kind contracts** (`task`, `coordinator`),
   and the new **mutation-primitives API surface**.
4. The entity-layer invariants that aren't expressible as DDL.

Out of scope:

- The 2 doc-only frontmatter additions to `meta-agent-schema`
  (`dependencies.agents`, reserved `dependencies.subagents`) —
  tracked in §2.5 of spec.md.
- HTTP / dashboard surfaces (`OPEN`, §7 Q9; deferred to post-v1).
- `consecutive_failed_silent_retries` (DEFERRED — see R4 in
  `risks.md`; will revisit alongside `phase_budget` in v2).
- `resumeWorkflow` API (re-open a terminal workflow). Deferred to
  v2; see open questions.
- Cross-workflow sub-workflows (a coord that spawns a child
  workflow). Out of scope for v1.

## What changed from schema-v1 / intermediate-extendDag (cheat sheet)

| Topic | schema-v1 | intermediate (extendDag) | schema-v2 (this doc) |
|---|---|---|---|
| Coord-side mutation API | `advancePhase(workNodes[])` | `extendDag(insertion: SubDagInsertion)` | **Mutation primitives**: `addNode` / `addEdge` / `addSubgraph` / `removeNode` / `removeEdge` / `replaceNodeSpec` / `cancelNode` / `finishWorkflow` |
| Coord-side read API | (none explicit) | (none explicit) | **`getWorkflow` / `getDag` / `getNode` / `getNodeDir`**. Unauthed — any task can read |
| Per-call atomicity | per call | per `extendDag` (monolithic batch) | per primitive call (still atomic individually); `addSubgraph` available for explicit multi-node batching |
| Once-only guard per coord wake | (n/a) | OPEN (Q-schema-5) | **Dissolved**. No guard needed — primitives are independently atomic; `finishWorkflow` uses CAS on `workflows.status`; silent-retry liveness check catches "coord forgot to add successor coord" |
| `WorkflowStatus` enum | 5 values incl. `coordinating` | 5 values incl. `coordinating` | **4 values**: `running` / `succeeded` / `failed` / `cancelled` |
| "Coord awake" view | derived (`WorkflowCoordinatorStatus`) | derived (`WorkflowCoordinatorStatus`) | **Dropped**. Clients query `workflow_nodes` directly (`EXISTS(kind='coordinator' AND status='running')`) |
| Successor coord rule | substrate auto-appends | validation rule #10 + #11 (must include exactly 1 coord per insertion) | **Structural**: `addNode(coord)` rejected if caller already has ≥1 coord child; silent retry inserts one at coord-termination if none exists |
| Coord-per-phase invariant | "exactly one" | dropped | dropped (multiple coord nodes can co-exist at different depths; only "exactly one non-terminal coord" enforced) |
| Phase parity (coord even / work odd) | structural rule | dropped | dropped |
| Eval, audit, etc. | required new kinds / capabilities | `kind='task'` worker scheduled by coord | unchanged from intermediate; `kind='task'` worker reads DAG via `getDag` / `getNode` |
| Phase column | engine hot-path query | UI hierarchical rendering only | **UI rendering only**; recomputed across not_started subtree on edge mutation |
| Capability flags on KindHandler | (proposed mid-discussion, rejected) | (none) | (none) |
| `workflows.coordinator_agent` column | not present | KEPT as denorm cache (D14) | KEPT (D14 unchanged); maintained by `insertCoordNode` helper |
| Validation surface | 10 rules at one call | 13 rules at one call | **Per-primitive rejection rules**; total surface smaller (no rule for "exactly-one-coord-per-insertion", "tempId uniqueness", "successor present" — all become structural invariants enforced cross-call) |
| `WorkflowNodeKindHandler.validate` | `(spec)` | `(spec, ctx)` | `(spec, ctx)` (carried forward) |
| Dispatch primitive | implicit per-handler | `dispatchAtomic(nodeId)` (invariant #12 in intermediate) | unchanged; `dispatchAtomic` still the substrate primitive |
| Node ID generator | `nanoid()` | `randomUUID()` | `randomUUID()` (carried forward) |

The 3-table DDL is structurally unchanged from schema-v1; only the
phase-index set shrinks. Cross-package `tasks` indexes are
byte-for-byte identical.

## Locked design decisions

| # | Decision | Source |
|---|---|---|
| D1 | Workflow status enum **`running \| succeeded \| failed \| cancelled`** (4 values). Non-terminal = `running`. UI's "coord awake" view derived from `workflow_nodes` (no derived enum needed) | 2026-06-06 |
| D2 | Node status enum unchanged from v0.6.0 (`not_started \| ready \| running \| succeeded \| failed \| cancelled`) | round 4 |
| D3 | `phase` is a node column = topological depth = `MAX(parents.phase) + 1`. Recomputed across affected not_started subtree on every edge-mutating primitive. Used by clients for hierarchical DAG visualization | 2026-06-06 |
| D4 | `tasks` table gets ZERO new columns; integration mirrors `@emploke/schedule` (partial functional indexes on `tasks.metadata` JSON paths, scoped by `origin='workflow'`) | 2026-06-06 |
| D5 | `workflow_dir` NOT stored — derived via `workflowDir(workspaceDir, id)` (mirrors `tasks` convention) | 2026-06-06 |
| D6 | `outcome` column DROPPED from workflows (collapsed into status enum) | round 4.5 |
| D7 | `archived_at` RENAMED to `ended_at` (aligns with `tasks.ended_at`) | 2026-06-06 |
| D8 | `consecutive_failed_silent_retries` DEFERRED to v2 | 2026-06-06 |
| D9 | v0.6.0 → v1.0.0: drop + recreate (no real users) | round 3, §6.3 |
| D10 | `workflow_nodes.type` → `kind` (text NN, **no DEFAULT**); `workflow_nodes.spec` → `spec_json` (text NN, **no DEFAULT**). Mirrors `schedules.target_kind` / `schedules.target_json` | 2026-06-06 |
| D11 | `workflow_nodes.data` column DROPPED entirely. Substrate has no per-node mutable state; runtime state belongs to the backing unit (e.g. the task) | 2026-06-06 |
| D12 | `@emploke/workflow` substrate is **kind-agnostic**. Per-kind logic lives in a `WorkflowNodeKindHandler` registered at compose time. Mirrors `ScheduleKindHandler` | 2026-06-06 |
| D13 | **Wake-as-node unification.** Coordinator runs are first-class `workflow_nodes` with `kind='coordinator'`. NO separate `workflow_coordinator_runs` table | 2026-06-06 |
| D14 | **Coord agent stored in two places with clear roles.** `workflow_nodes.spec_json.agent` is the per-coord-node historical record (every coord ever ran is preserved). `workflows.coordinator_agent` is a denormalized read-optimized projection of the **current** coordinator agent (= latest coord node's `spec.agent`), kept in sync by substrate within the same transaction as any `kind='coordinator'` node INSERT. Clients querying "who's running this workflow" hit a single row; clients querying coord history walk `workflow_nodes` | 2026-06-06 |
| D15 | **NO `WorkflowCoordinatorStatus` derived view in TS layer.** Clients that want "is the coordinator awake right now" query `workflow_nodes` directly (`EXISTS WHERE kind='coordinator' AND status='running'`). Replaces the awake/sleeping/retired enum from prior iterations | 2026-06-06 (revised) |
| D16 | **`tasks.metadata` carries `{ workflowId, workflowNodeId }` for every workflow-origin task** — no role discriminator. The kind of work performed is encoded by the linked node's `kind` column | 2026-06-06 |
| D17 | **Mutation-primitives API.** Replace atomic extendDag with 8 fine-grained primitives (`addNode`, `addEdge`, `addSubgraph`, `removeNode`, `removeEdge`, `replaceNodeSpec`, `cancelNode`, `finishWorkflow`) + 4 read APIs (`getWorkflow`, `getDag`, `getNode`, `getNodeDir`). Each primitive is independently atomic. Substrate enforces minimal structural invariants; "shape of a coord turn" is coord's prerogative | 2026-06-06 (revised from intermediate) |
| D18 | **Substrate has exactly one special kind: `coordinator`.** The three and only three pieces of coord-kind special handling are: (a) all mutation primitives gated to coord-kind callers (read APIs unauthed); (b) coord-termination triggers liveness check + silent retry; (c) `workflows.coordinator_agent` denorm sync per coord-INSERT. No `runsAtPhaseBoundary` / `canAdvancePhase` / capability flag system | 2026-06-06 (carried) |
| D19 | **Coord agent swappable across coord nodes.** A coord at any phase may schedule its successor coord with a different `spec.agent` FQN. Substrate doesn't validate cross-coord agent identity. Enables mid-workflow coord-agent escalation based on eval feedback | 2026-06-06 |
| D20 | **Silent retry stays — triggered at coord-task termination.** If `workflows.status='running'` AND no non-terminal coord-kind node exists after the just-terminated coord, substrate auto-inserts a new coord-kind node with the same `spec_json` as the just-terminated one, parents = current DAG sinks (so the retry coord wakes after the existing frontier finishes). No retry budget in v1 | 2026-06-06 (revised) |
| D21 | **Terminology: "coord run" / "coord node" / "coord task" / "coord turn".** No more "wake" / "wake task". The Nth coord-kind node (by `created_at`) is informally "the Nth coordinator" or "iteration N" (derived, not stored) | 2026-06-06 |
| D22 | **Mutation auth gate.** All 8 mutation primitives share a single cross-cut auth predicate: caller node MUST have `kind='coordinator' AND status='running' AND workflows.status='running'`. Read APIs (`getWorkflow` / `getDag` / `getNode` / `getNodeDir`) have NO auth gate — any caller can read. Enables in-DAG eval workers (`kind='task'`) to read sibling output via `getNode` + `getNodeDir` without being coord | 2026-06-06 |
| D23 | **At most one successor coord per coord wake.** `addNode(coord)` and `addSubgraph(... coord ...)` are rejected if the caller already has ≥1 `kind='coordinator'` child node. Combined with D20 silent retry + D27 (caller must be parent), this structurally guarantees invariants #1 + #1a (non-terminal coord chain has length 1 or 2 when workflow is running) | 2026-06-06 |
| D24 | **Structural sealing of running and terminal nodes.** Mutations targeting a node whose status ∉ `{'not_started'}` are rejected. Specifically: `removeNode` / `replaceNodeSpec` reject anything not `not_started`; `addEdge` / `removeEdge` reject if the to-node is not `not_started`; `cancelNode` is the only mutation targeting `running` (task-kind only). Coord can never reach into already-dispatched work | 2026-06-06 |
| D25 | **Successor coord placement is coord's responsibility, not substrate's.** Coord prompt contract says "the successor coord SHOULD be at max DAG depth (last phase)". Substrate does NOT validate this position — only enforces "≤1 coord child per wake" + "≥1 non-terminal coord when workflow running". If a coord places its successor mid-DAG anyway, the workflow still progresses correctly (just suboptimally). May upgrade to substrate-enforced in v2 if real coord agents violate the convention | 2026-06-06 |
| D26 | **`workflows.status='running'` is the ONLY non-terminal value.** Substrate never writes `status='coordinating'` (the value doesn't exist). `running` is set at `createWorkflow` time and only changes when `finishWorkflow` or `cancelWorkflow` fires (both CAS-guarded). All "is coord awake" / "is workflow waiting on a coord" semantics derive from node-level state | 2026-06-06 |
| D27 | **Inserted coord must be a child of the caller coord.** `addNode(kind='coordinator')` and `addSubgraph(... coord ...)` reject unless the caller coord's id appears in the new coord's parent set (`addNode.parents` or an `addSubgraph` edge from caller to the coord temp). Closes the loophole where D23 (≤1 coord child per caller) could be bypassed by adding coord children to other nodes. Substrate-enforced; produces `OrphanCoordInsertError` on violation | 2026-06-06 |
| D28 | **Eager dispatch after mutation.** Every mutation that adds new edges or new nodes (`addNode`, `addEdge`, `addSubgraph`, silent-retry insert) ends with a dispatch-reaction pass over affected nodes: any node whose per-kind parent-readiness predicate (invariant #12) is now satisfied gets `dispatchAtomic(nodeId)` immediately, in the same post-commit step. Without this, nodes whose parents were ALREADY terminal at insert time would never dispatch (no future parent-termination event exists to trigger them) | 2026-06-06 |
| D29 | **Parent-state restriction is kind-aware** (resolves Q-schema-8). When inserting a node with `parents` containing failed/cancelled nodes: for `kind='task'` REJECT (task can never satisfy "all parents succeeded"; would be dead-on-arrival). For `kind='coordinator'` ALLOW (coord wakes on any terminal parent per invariant #12; failed parent is legitimate "handle this failure" input) | 2026-06-06 |
| D30 | **`finishWorkflow` excludes caller from cancel reconciliation.** Post-`finishWorkflow` cancel sweep over non-terminal nodes EXPLICITLY skips the calling coord node. Caller's task continues to natural exit; coord-termination handler then marks it terminal as usual. Without this skip, the substrate would cancel the very task that just called `finishWorkflow`, racing the task's own exit | 2026-06-06 |
| D31 | **Deterministic "latest coord" tie-break.** "Latest coord" for `workflows.coordinator_agent` denorm is defined as `ORDER BY created_at DESC, id DESC LIMIT 1`. The `id DESC` secondary sort breaks ISO-timestamp ties that can occur in fast local execution / tests. Substrate uses this ordering in every place the denorm helper queries "latest" | 2026-06-06 |

## Resolved open questions

- ~~Q-schema-1: `workflow_coordinator_runs` PK design.~~ **RESOLVED via D13**: table dropped entirely; coord runs ARE workflow nodes.
- ~~Q-schema-2: `capabilities` flag on `WorkflowNodeKindHandler`.~~ **RESOLVED via D18**: no flag; coord-kind is the only substrate-special kind.
- ~~Q-schema-3: How does eval fit?~~ **RESOLVED via D17+D18+D22**: eval is a regular `kind='task'` node; coord schedules it via mutation primitives with appropriate edges; eval worker reads sibling output via unauthed `getDag` / `getNode` / `getNodeDir`. See `coord-eval-design-discussion.md` §"Bonus".
- ~~Q-schema-4: Should `workflows` carry a `coordinator_agent` column?~~ **RESOLVED via D14**: KEEP as denormalized read-optimized projection of latest coord node's `spec.agent`. Substrate maintains via single `insertCoordNode` helper across all 4 INSERT paths (createWorkflow / addNode-with-coord / addSubgraph-with-coord / silent retry). Invariant #11 + D31 ordering guarantees the cache equals the deterministic latest's `spec.agent`.
- ~~Q-schema-5: Once-only side-effect guard per coord node.~~ **DISSOLVED via the mutation-primitives pivot (D17)**: each primitive is independently atomic; there is no monolithic batch to "double-call". `finishWorkflow` uses CAS on `workflows.status='running'` to enforce single-fire. "Coord adds 2 coord successors" is prevented structurally by D23. "Coord adds no successor at all" is recovered by D20 silent retry at coord-termination. There is no remaining vector that needs a per-coord-node action marker.
- ~~Q-schema-6: ID format for `workflow_nodes.id` and `workflows.id`.~~ **RESOLVED**: `randomUUID()` (UUID v4) consistent with workspace / schedule / catalog / request-id.
- ~~Q-schema-8: `addNode` parent-state restriction.~~ **RESOLVED via D29**: parent-state validation is kind-aware. Task-kind rejects parents in {failed, cancelled} (would deadlock per invariant #12). Coord-kind allows any terminal parent (coord wakes on failure to handle it).

## Open questions (still need decision before lock)

- **Q-schema-7: Successor-coord placement enforcement (D25).** Currently
  substrate trusts coord to place the successor at max DAG depth (last
  phase). If a coord places it mid-DAG, the workflow still progresses
  (the successor wakes when its parents complete per invariant #12, and
  the substrate's silent-retry safeguard catches the "no successor"
  case). Question: do we upgrade to substrate-enforced "successor coord
  must be at current max phase" for v1, or trust the coord prompt?
  **Leaning: trust the prompt for v1, upgrade if bad coord behavior is
  observed.**
- **Q-schema-9: `cancelNode` for coord-kind.** Currently spec'd as
  task-kind only. A buggy coord that's spinning could need an external
  abort, but `cancelWorkflow` already handles that. Worth a separate
  per-node abort? **Leaning: task-kind only for v1; coord lifecycle
  is workflow-scoped, not node-scoped.**
- **Q-schema-10: Atomic parent replacement primitive.** Today, changing
  a node's parents requires `addEdge(new) → removeEdge(old)`, which is
  2 non-atomic calls. Between them the node might transition to
  `ready`/`running` (eager dispatch D28 can fire after the addEdge),
  blocking the subsequent removeEdge. Coord can sidestep this by
  building topology before any parent becomes terminal-eligible, but
  it's a sharp edge. Consider adding `replaceParents(nodeId,
  newParents)` or `mutateEdges({add, remove})` as a v1 primitive.
  **Leaning: defer to v2 unless a coord use case hits it in v1
  dogfood.**

# Table definitions

## Table 1: `workflows` (modified from v0.6.0)

```sql
CREATE TABLE workflows (
  id                 TEXT PRIMARY KEY NOT NULL,
  brief              TEXT NOT NULL,
  details            TEXT,
  coordinator_agent  TEXT NOT NULL,             -- current coord agent FQN; denorm cache of latest coord node's spec.agent (D14)
  status             TEXT NOT NULL,             -- enum: 'running' | 'succeeded' | 'failed' | 'cancelled'  (D1, D26)
  metadata           TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  ended_at           TEXT                       -- RENAMED from archived_at; non-null iff status terminal
);
CREATE INDEX workflows_status_idx            ON workflows (status);
CREATE INDEX workflows_coordinator_agent_idx ON workflows (coordinator_agent);
```

Note on `coordinator_agent` (D14): this is a **denormalized
read-cache** of the latest coord-kind node's `spec_json.agent` for
this workflow. Substrate keeps it in sync — every transaction that
inserts a `kind='coordinator'` node ALSO updates this column in the
same transaction. Per invariant #11 below, the column ALWAYS equals
`json_extract(spec_json, '$.agent')` of the most-recently-created
coord-kind node for this workflow. Mid-flight coord-agent swap (D19)
naturally updates the column when the new coord node is inserted.

Clients querying "who's running this workflow" hit a single row
read. Clients querying coord history walk `workflow_nodes`. The
`spec_json` field on coord nodes remains the source of truth for the
per-iteration record; `workflows.coordinator_agent` is a fast view of
"current".

Note on `status` (D26): unlike prior iterations, there is no
`'coordinating'` value. The substrate never writes `coordinating`.
The column has exactly 4 values; non-terminal is always exactly
`'running'`. Whether the workflow is "actively coordinating right
now" is derived by clients from `workflow_nodes` (`EXISTS WHERE
kind='coordinator' AND status='running'`).

The workflow's directory is `<workspaceDir>/workflows/<workflow_id>/`,
resolved at the service layer via `workflowDir(workspaceDir, id)`
(`packages/workflow/src/paths.ts`). Same pattern as `tasks` (no
`task_dir` column either).

**Diff vs v0.6.0:**

| Column | v0.6.0 | v1.0.0 | Change |
|---|---|---|---|
| `id` | TEXT PK | TEXT PK | — |
| `brief` | TEXT NN | TEXT NN | — |
| `details` | TEXT | TEXT | — |
| `coordinator_agent` | — | TEXT NN | **added** (denorm cache; D14) |
| `status` | TEXT NN | TEXT NN | enum values change (4 values; D1) |
| `outcome` | TEXT | — | **dropped** (D6) |
| `metadata` | TEXT NN | TEXT NN | — |
| `created_at` | TEXT NN | TEXT NN | — |
| `started_at` | TEXT | TEXT | — |
| `archived_at` | TEXT | — | **renamed → ended_at** (D7) |
| `ended_at` | — | TEXT | (rename target) |

**Indexes:** v0.6.0 had no indexes on this table. v1.0.0 adds two:
- `workflows_status_idx` for status-filtered dashboard listings (primary read pattern).
- `workflows_coordinator_agent_idx` for the "list workflows running agent X" admin query, now a direct index lookup rather than a JOIN.

## Table 2: `workflow_nodes` (modified from v0.6.0)

```sql
CREATE TABLE workflow_nodes (
  id           TEXT PRIMARY KEY NOT NULL,
  workflow_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,                  -- discriminator: 'task' | 'coordinator' (v1.0.0); 'human' reserved
  spec_json    TEXT NOT NULL,                  -- opaque JSON envelope, owned by registered kind handler
  phase        INTEGER NOT NULL,               -- topological depth; recomputed at every edge-mutating primitive (D3)
  status       TEXT NOT NULL,                  -- enum: see WorkflowNodeStatus
  created_at   TEXT NOT NULL,
  ready_at     TEXT,
  running_at   TEXT,
  ended_at     TEXT
);
CREATE INDEX workflow_nodes_workflow_idx ON workflow_nodes (workflow_id);
CREATE INDEX workflow_nodes_status_idx   ON workflow_nodes (workflow_id, status);
CREATE INDEX workflow_nodes_phase_idx    ON workflow_nodes (workflow_id, phase);  -- for UI sorted rendering
```

**Diff vs v0.6.0:**

| Column | v0.6.0 | v1.0.0 | Change |
|---|---|---|---|
| `id` | TEXT PK | TEXT PK | — |
| `workflow_id` | TEXT NN | TEXT NN | — |
| `type` | TEXT NN DEFAULT 'task' | — | **renamed → kind**; DEFAULT dropped |
| `kind` | — | TEXT NN | (rename target); enum gains `'coordinator'` AND reserves `'human'` |
| `spec` | TEXT NN DEFAULT '{}' | — | **renamed → spec_json**; DEFAULT dropped |
| `spec_json` | — | TEXT NN | (rename target); envelope shape owned by kind handler |
| `data` | TEXT NN DEFAULT '{}' | — | **dropped** (D11) |
| `phase` | — | INTEGER NN | **added** (D3) |
| `status` | TEXT NN | TEXT NN | — |
| `created_at` | TEXT NN | TEXT NN | — |
| `ready_at` | TEXT | TEXT | — |
| `running_at` | TEXT | TEXT | — |
| `ended_at` | TEXT | TEXT | — |

**Indexes (v2 vs schema-v1):** schema-v1 had 3 phase-related indexes
for hot-path engine queries ("phase N all terminal?", "latest coord
by phase"). In v2 those queries don't exist:
- "Ready nodes" = edges-walking + parent-status check (no phase needed).
- "Latest coord" = `ORDER BY created_at DESC WHERE kind='coordinator' LIMIT 1` (no phase needed).

Only the UI hierarchical-render query (`WHERE workflow_id=? ORDER BY
phase`) genuinely benefits from a phase index. Keep one:
`(workflow_id, phase)`. Drop the other two.

**Note on `kind` and `spec_json`:** these mirror
`schedules.target_kind` / `schedules.target_json` byte-for-byte in
role. The substrate stores both opaquely; per-kind shape validation,
dispatch, in-flight check, and cancel live in a
`WorkflowNodeKindHandler` registered at compose time. The substrate
itself contains no mention of `'task'`, `'coordinator'`, or any other
concrete kind. Adding a future kind (`'human'`, etc.) requires zero
edits to `packages/workflow/src/`.

### v1.0.0 `'task'` kind contract (lives in `@emploke/contracts`)

A new file `packages/contracts/src/workflows.ts` defines wire-shape
DTOs for workflow kinds the same way `packages/contracts/src/schedules.ts`
does for schedule kinds.

```ts
// packages/contracts/src/workflows.ts

/**
 * Task-kind node spec payload — flat, matches the body shape minus
 * the discriminator. Persisted opaquely as `workflow_nodes.spec_json`
 * via the envelope; consumed flatly on the wire.
 */
export interface WorkflowTaskNodeSpec {
  /** Worker agent FQN. MUST appear in the most recent coord node's `spec.agent` `dependencies.agents`. */
  readonly agent: string;
  /** Single line, ≤ 200 chars. Mirrors `@emploke/task` `DispatchOpts.brief`. */
  readonly brief: string;
  /** Multi-line, optional. Mirrors `@emploke/task` `DispatchOpts.details`. */
  readonly details?: string;
  /** Optional runtime override. Mirrors `@emploke/task` `DispatchOpts.runtime`. */
  readonly runtime?: string;
}
```

**Validation rules** (enforced by the task-kind handler's `validate`;
throw `WorkflowTaskNodeSpecError` on violation):

1. `agent`: non-empty string AND exists in catalog AND appears in the
   caller coord's `spec.agent`'s `dependencies.agents`. The
   "caller coord" is provided via `ctx.callerCoordSpec.agent`.
2. `brief`: non-empty string, no `\n`/`\r`, length ≤ 200.
3. `details`: when present, must be string (empty allowed).
4. `runtime`: when present, must be non-empty string.

**Example persisted row** (the `spec_json` text column for a task-kind
node):

```json
{
  "agent": "myorg/variant-writer",
  "brief": "CTA variant A: urgency framing",
  "details": "Generate a 1-line CTA emphasizing time-limited offer.",
  "runtime": "copilot"
}
```

### v1.0.0 `'coordinator'` kind contract

```ts
/**
 * Coordinator-kind node spec payload. Every coord node carries its
 * own agent FQN (D14). When the substrate auto-inserts a silent-retry
 * coord (D20), it copies the predecessor's spec_json. When the coord
 * itself schedules a successor via mutation primitives, the coord
 * chooses what agent to use (D19) — inheritance is convention,
 * not enforced.
 */
export interface WorkflowCoordinatorNodeSpec {
  /**
   * Coordinator agent FQN. MUST be installed in catalog AND its
   * `dependencies.skills` MUST include `emploke/coordinator`.
   * Validated at insert time.
   */
  readonly agent: string;
}

/** Wire projections (flat, like schedule kinds). */
export type WorkflowTaskNodeSpecWire =
  { readonly kind: 'task' } & WorkflowTaskNodeSpec;

export type WorkflowCoordinatorNodeSpecWire =
  { readonly kind: 'coordinator' } & WorkflowCoordinatorNodeSpec;

export type WorkflowNodeWireSpec =
  | WorkflowTaskNodeSpecWire
  | WorkflowCoordinatorNodeSpecWire
  | { readonly kind: string; readonly spec: unknown };  // forward-compat for new kinds
```

**Validation rules** for coordinator kind:

1. `agent`: non-empty string AND exists in catalog AND
   `dependencies.skills` includes `emploke/coordinator`.

**Example persisted row** (coord node):

```json
{ "agent": "myorg/saas-builder-coord" }
```

## Table 3: `workflow_edges` (unchanged from v0.6.0)

```sql
CREATE TABLE workflow_edges (
  workflow_id   TEXT NOT NULL,
  from_node_id  TEXT NOT NULL,
  to_node_id    TEXT NOT NULL,
  PRIMARY KEY (workflow_id, from_node_id, to_node_id)
);
CREATE INDEX workflow_edges_from_idx ON workflow_edges (workflow_id, from_node_id);
CREATE INDEX workflow_edges_to_idx   ON workflow_edges (workflow_id, to_node_id);
```

**Diff vs v0.6.0:** none. Carried verbatim.

# Cross-package: `@emploke/task` indexes only

**No ALTER on the `tasks` table.** Integration mirrors how
`@emploke/schedule` connects to tasks: the `tasks.metadata` JSON
blob carries the workflow context, and partial functional indexes
make the lookup cheap.

```sql
-- @emploke/task/drizzle/00NN_tasks_workflow_indexes.sql

CREATE INDEX tasks_workflow_id_idx
  ON tasks (json_extract(metadata, '$.workflowId'))
  WHERE origin = 'workflow';

CREATE INDEX tasks_workflow_node_id_idx
  ON tasks (json_extract(metadata, '$.workflowNodeId'))
  WHERE origin = 'workflow';
```

**Metadata shape — uniform across all workflow-origin tasks:**

```jsonc
{
  "workflowId":     "<workflow.id>",
  "workflowNodeId": "<node.id>"
}
```

Every task dispatched on behalf of a workflow node — whether
`kind='task'` or `kind='coordinator'` — has BOTH fields. There is no
role discriminator in metadata; the kind of work performed is the
linked node's `kind` column.

`tasks.origin = 'workflow'` for both, so the partial indexes engage.

**Reverse-lookup queries:**

```sql
-- All tasks for a workflow
SELECT * FROM tasks
WHERE origin = 'workflow'
  AND json_extract(metadata, '$.workflowId') = ?;

-- The single task backing a given node (work or coord)
SELECT * FROM tasks
WHERE origin = 'workflow'
  AND json_extract(metadata, '$.workflowNodeId') = ?
LIMIT 1;
```

# TS-layer types (`packages/workflow/src/types.ts`)

```ts
// ─── FSM enums ────────────────────────────────────────────────────

// Workflow-level FSM. Only ONE non-terminal value (D1, D26).
export type WorkflowStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

// Per-node FSM (unchanged from v0.6.0; applies to BOTH task-kind and
// coordinator-kind nodes).
export type WorkflowNodeStatus =
  | 'not_started'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

// ─── Derived-view helpers (NOT persisted) ─────────────────────────

/**
 * "Is there a coord actively running right now?" — derived from node
 * state, not from a workflow column (D15). Clients call this OR run
 * the SQL directly; this helper is sugar.
 */
export function hasLiveCoord(nodes: ReadonlyArray<Pick<WorkflowNodeEntity, 'kind' | 'status'>>): boolean {
  return nodes.some(n => n.kind === 'coordinator' && n.status === 'running');
}

/**
 * Iteration count — = "how many coord nodes have ever been created
 * in this workflow". UI / CLI use it to render "Iteration 5" labels.
 */
export function deriveIterationCount(coordNodeCount: number): number {
  return coordNodeCount;
}

// ─── Kind-handler substrate interface ─────────────────────────────

/**
 * Opaque envelope persisted by the workflow pkg for every node. The
 * `spec` payload is `unknown` because the substrate deliberately
 * doesn't know per-kind shape; the registered
 * `WorkflowNodeKindHandler` owns parsing / validation / dispatch /
 * in-flight check / cancel.
 *
 * On disk: `kind` lives in `workflow_nodes.kind` and `spec` is
 * `JSON.stringify`ed into `workflow_nodes.spec_json`. The kind is
 * NOT nested inside `spec_json` (mirrors `ScheduleEntity.toRow`).
 */
export interface WorkflowNodeSpecEnvelope {
  readonly kind: string;
  readonly spec: unknown;
}

/**
 * Per-kind handler registered at compose time via
 * `WorkflowService.registerKind(kind, handler)`. The substrate has
 * NO built-in knowledge of `'task'`, `'coordinator'`, or any other
 * concrete kind. Both v1.0.0 kinds are wired identically — task
 * handler dispatches a worker task, coordinator handler dispatches
 * a coord task with framing/rootDir overrides. The substrate only
 * sees `dispatch` calls returning unit ids.
 *
 * No capabilities flag (D18). The substrate's coord-special
 * behaviors are encoded in the engine itself, not in this interface.
 *
 * Mirrors `@emploke/schedule`'s `ScheduleKindHandler` byte-for-byte
 * in role. Concrete handlers live in `packages/api/src/wiring/`.
 */
export interface WorkflowNodeValidateCtx {
  readonly workflowId: string;
  /** The coord node calling the mutation primitive — i.e. the parent in the auth/causality sense. */
  readonly callerCoordNodeId: string;
  /** The caller coord's persisted spec; for task validation against `dependencies.agents`. */
  readonly callerCoordSpec: { readonly agent: string };
  /** Useful for cross-workflow-state checks; rarely needed. */
  readonly workflowStatus: WorkflowStatus;
}

export interface WorkflowNodeKindHandler {
  /**
   * Validate an inbound `spec` payload. MUST throw on invalid shape;
   * MAY perform async side-effects (e.g. catalog existence lookup
   * for an agent FQN). Returns the validated / normalized payload,
   * which the substrate persists as `spec_json`.
   *
   * `ctx` carries caller-coord context: task-kind validation uses
   * `ctx.callerCoordSpec.agent` to enforce invariant #9 (worker
   * agent must appear in caller coord's dependencies.agents). For
   * `createWorkflow`'s initial coord insert, ctx fields are set as:
   *   workflowId         = freshly-minted workflow id
   *   callerCoordNodeId  = same as the node being inserted (self)
   *   callerCoordSpec    = the agent being installed (self)
   *   workflowStatus     = 'running'
   * For silent-retry coord insert, ctx mirrors the just-terminated
   * coord since the substrate is acting on its behalf.
   */
  validate(spec: unknown, ctx: WorkflowNodeValidateCtx): Promise<unknown>;

  /**
   * Fire the unit of work backing this node. Called by the engine
   * when the node transitions `not_started|ready → running` (via
   * dispatchAtomic; see invariant #12). The handler dispatches
   * whatever it needs (e.g. a task) and stamps
   * `{ workflowId, workflowNodeId }` into the unit's metadata so
   * the reverse-lookup partial indexes engage.
   *
   * Returns a substrate-side identifier (e.g. task id) for audit;
   * the substrate does NOT persist this id — reverse lookup goes
   * through the unit's metadata, not through a `workflow_nodes`
   * column.
   */
  dispatch(opts: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly spec: unknown;
    readonly nodeDir: string;     // resolved by substrate; see paths.ts
  }): Promise<{ readonly unitId: string }>;

  /**
   * Whether this kind currently has a dispatched-but-incomplete
   * unit-of-work for `nodeId`. Used by cancel reconciliation and
   * by engine-restart recovery (running rows with no in-flight unit
   * get rolled back to ready).
   */
  hasInFlightForNode(nodeId: string): Promise<boolean>;

  /**
   * Cancel the in-flight unit-of-work for `nodeId`. Idempotent.
   */
  cancel(nodeId: string): Promise<void>;
}
```

# Substrate API surface

The substrate exposes two API tiers. Both live on the
`WorkflowService` class in `packages/workflow/src/workflow-service.ts`.

## Tier 1: Read APIs (unauthed; D22)

Any caller — coord, in-DAG worker, dashboard, CLI — can read.
Enables `kind='task'` workers (e.g. eval workers) to inspect sibling
output via SQL without being coord. The substrate performs no auth
gating on these; rate-limiting / access control is the surrounding
service's responsibility.

```ts
interface WorkflowReadAPI {
  /** Single workflow row with the denorm `coordinator_agent` cache (D14). */
  getWorkflow(workflowId: string): Promise<WorkflowEntity>;

  /**
   * Full DAG snapshot. Convenience for UI rendering and for in-DAG
   * eval workers that need to walk the graph.
   */
  getDag(workflowId: string): Promise<{
    readonly workflow: WorkflowEntity;
    readonly nodes: ReadonlyArray<WorkflowNodeEntity>;
    readonly edges: ReadonlyArray<WorkflowEdgeEntity>;
  }>;

  /** Single node row. */
  getNode(nodeId: string): Promise<WorkflowNodeEntity>;

  /**
   * Resolved on-disk directory for the backing unit of this node
   * (e.g. for coord nodes, the per-iteration coord task dir).
   * Composed from `<workspaceDir>/workflows/<wf>/<...>/<task_id>/`.
   *
   * Returns `null` if the node has NOT yet dispatched a backing
   * unit — covers `status='not_started'`, `status='ready'`, AND the
   * brief window inside `dispatchAtomic` where `status='running'`
   * has been written but `handler.dispatch` has not yet returned
   * (no `unitId` exists yet). Callers needing a stable
   * "dispatched, has unit" signal should also check `running_at`
   * is non-null AND `handler.hasInFlightForNode = true`.
   */
  getNodeDir(nodeId: string): Promise<string | null>;
}
```

**Read API auth note (D22):** "unauthed" means the substrate
itself imposes NO coord-node auth gate on read calls — any caller
threaded through the service layer can read. It does NOT mean
"globally public": the surrounding HTTP / CLI / IPC layer is
responsible for workspace-level access control. `spec_json` may
contain agent prompts and operational context; treat the substrate
as a read-anywhere store inside a workspace boundary, with
workspace boundary enforcement done outside this package.

## Tier 2: Mutation primitives (coord-only; D22)

All 8 primitives share a **single cross-cut auth predicate**,
checked atomically inside the mutation's transaction:

```text
caller node MUST satisfy:
  workflow_nodes.kind   = 'coordinator'
  workflow_nodes.status = 'running'
  workflows.status      = 'running'

(caller identity is supplied by the service-layer auth context;
 see api-layer auth-context.ts for how it's threaded through.)

Reject otherwise with WorkflowMutationUnauthorizedError.
```

This is the only auth gate. There are no per-primitive role checks
beyond this and the structural per-primitive rules below.

```ts
interface WorkflowMutationAPI {
  /**
   * Insert a single new node with at least one parent. `parents`
   * may include any existing nodes in this workflow (not just
   * caller's children).
   *
   * Parent-state restriction is **kind-aware** (D29):
   *   - new node `kind='task'`: REJECT if any parent in
   *     {failed, cancelled} — task would be permanently un-dispatchable.
   *   - new node `kind='coordinator'`: ALLOW any terminal parent —
   *     coord wakes on failures per invariant #12.
   *
   * If `kind='coordinator'`:
   *   - The caller coord's id MUST appear in `parents` (D27).
   *     Rejected with `OrphanCoordInsertError` otherwise.
   *   - The caller MUST NOT already have a coord-kind child (D23).
   *     Rejected with `MultipleSuccessorCoordsError` otherwise.
   *
   * After commit, substrate runs an eager dispatch reaction (D28):
   * if the new node's per-kind parent-readiness predicate is already
   * satisfied (e.g. parents already all terminal), it dispatches
   * immediately. Without this, nodes added with already-terminal
   * parents would deadlock.
   *
   * Returns the assigned id and computed phase.
   */
  addNode(opts: {
    readonly kind: string;
    readonly spec: unknown;
    readonly parents: ReadonlyArray<string>;   // ≥ 1
  }): Promise<{ readonly nodeId: string; readonly phase: number }>;

  /**
   * Add an edge between two existing nodes. The to-node MUST be
   * `status='not_started'` (D24) — running and terminal nodes
   * structurally sealed.
   *
   * From-node state restriction is **kind-aware** (D29, by to-node):
   *   - to-node `kind='task'`: REJECT if from-node in
   *     {failed, cancelled}.
   *   - to-node `kind='coordinator'`: ALLOW any from-node terminal
   *     state.
   *
   * Cycle check on the full DAG ∪ {new edge}.
   *
   * Side effect: recompute phase across the not_started subtree
   * rooted at to-node (= to-node plus all its descendants, all of
   * which must themselves be not_started by structural invariant).
   * Then an eager dispatch reaction (D28) over to-node and any
   * descendants whose readiness predicate is now satisfied.
   *
   * Returns the new phase of the to-node.
   */
  addEdge(fromNodeId: string, toNodeId: string): Promise<{ readonly toPhase: number }>;

  /**
   * Atomic batch insert with intra-batch edges. The most common
   * primitive — coord uses this to add a "fan-out + eval + next-coord"
   * pattern in one transaction.
   *
   * Edges may target temp nodes (refs by `tempId`) or existing
   * not_started nodes (refs by node id). Edges may originate from
   * temp nodes OR existing nodes (state-restricted per D29 by the
   * to-node's kind, same as `addEdge`).
   *
   * Per-batch rules (atomically enforced; reject the entire batch
   * on any violation):
   *   - `tempId` non-empty, unique within batch
   *   - **every** temp node has ≥1 parent (from `existingParents` OR
   *     incoming intra-batch edge). No parentless temp roots.
   *   - intra-batch acyclic
   *   - joining the batch to the live DAG doesn't introduce cycles
   *   - kind-aware parent-state restriction (D29) per temp node's kind
   *   - at most 1 `kind='coordinator'` node in batch (D23). If 1
   *     present: caller MUST have 0 existing coord children AND
   *     caller's id MUST appear among the coord temp's parents (D27).
   *   - each `spec` validates via the registered kind handler
   *
   * After commit, eager dispatch reaction (D28) over all inserted
   * temp nodes plus any existing-to-target nodes that gained edges.
   *
   * Returns the `tempId → nodeId, phase` mapping.
   */
  addSubgraph(batch: {
    readonly nodes: ReadonlyArray<{
      readonly tempId: string;
      readonly kind: string;
      readonly spec: unknown;
      /**
       * Optional parents from EXISTING nodes (real ids). Intra-batch
       * parents are expressed via `edges` below using NodeRef.
       * If this is empty, the temp MUST have ≥1 incoming intra-batch
       * edge (no parentless temp roots).
       */
      readonly existingParents?: ReadonlyArray<string>;
    }>;
    readonly edges: ReadonlyArray<{
      readonly from: NodeRef;   // temp or existing
      readonly to: NodeRef;     // temp or existing-not-started
    }>;
  }): Promise<{
    readonly insertedNodes: ReadonlyArray<{
      readonly tempId: string;
      readonly nodeId: string;
      readonly phase: number;
    }>;
  }>;

  /**
   * Delete a node. MUST be `status='not_started'` (D24). All
   * adjacent edges are deleted in the same tx.
   *
   * Reject if removal would leave any child with 0 parents (would
   * orphan the child). Coord must `removeNode` the children first
   * (cascading bottom-up) OR add replacement parent edges first.
   *
   * Side effect: recompute phase on the not_started descendants
   * whose phase depended on this node (rare; only if this node was
   * the longest-path predecessor of a downstream node).
   */
  removeNode(nodeId: string): Promise<void>;

  /**
   * Delete an edge. The to-node MUST be `status='not_started'`
   * (D24). Reject if removal would leave to-node with 0 parents.
   *
   * Side effect: recompute phase of to-node and its not_started
   * descendants.
   */
  removeEdge(fromNodeId: string, toNodeId: string): Promise<void>;

  /**
   * Replace the `spec_json` of an existing node. MUST be
   * `status='not_started'` (D24). Kind cannot change.
   *
   * New spec is re-validated via `handler.validate(newSpec, ctx)`.
   * Phase unchanged (spec doesn't affect topology).
   */
  replaceNodeSpec(nodeId: string, newSpec: unknown): Promise<void>;

  /**
   * Cancel an in-flight task-kind node. Per Q-schema-9, coord-kind
   * nodes are NOT cancelable via this primitive — cancel the
   * workflow if you need to stop a coord. (External `cancelWorkflow`
   * is a separate API, not in this interface.)
   *
   * Allowed source statuses: `not_started`, `ready`, `running`.
   * For `running`: calls `handler.cancel(nodeId)` AFTER tx commit.
   * Sets node.status = 'cancelled'.
   *
   * **Cancel semantics (v1):** "cancelled" means the substrate will
   * ignore the unit-of-work, NOT proof that the unit has actually
   * stopped. If `handler.cancel` fails (network etc.) the substrate
   * remains in `cancelled` state; the unit may complete and its
   * output is discarded by the substrate (no edge-readiness or
   * coord-termination event fires for the cancelled node). Engine
   * logs `handler.cancel` failures for observability. May tighten
   * in v2 with a `cancelling` intermediate state.
   */
  cancelNode(nodeId: string): Promise<void>;

  /**
   * Terminate the workflow with the given outcome. CAS-guarded on
   * `workflows.status = 'running'` so a second call is a no-op
   * (or throws `WorkflowAlreadyTerminalError`).
   *
   * outcome ∈ {'succeeded', 'failed'}. (Cancellation is an external
   * action via `cancelWorkflow`, not a coord choice. The semantic
   * difference vs `finishWorkflow({outcome:'failed'})` is intent
   * provenance: `failed` is "coord decided this workflow failed";
   * `cancelled` is "external operator aborted in-flight".)
   *
   * Post-commit: substrate cancels any remaining non-terminal nodes
   * via `handler.cancel`, EXCLUDING the calling coord itself (D30).
   * The calling coord's task continues running to its natural exit;
   * the coord-termination handler then marks the coord node terminal
   * via the usual path. Without the caller-skip, the substrate would
   * race-cancel the very task that just called `finishWorkflow`.
   */
  finishWorkflow(opts: {
    readonly outcome: 'succeeded' | 'failed';
  }): Promise<void>;
}

/** Reference used by `addSubgraph.edges`. */
export type NodeRef =
  | { readonly kind: 'existing'; readonly id: string }
  | { readonly kind: 'temp'; readonly tempId: string };
```

### Per-primitive rejection rule summary

| Primitive | Auth gate | Structural rules | Side effects |
|---|---|---|---|
| `addNode` | D22 cross-cut | parents.length ≥ 1; parents same wf; kind-aware parent-state (D29): task rejects failed/cancelled parents, coord allows; spec validates; if coord-kind: caller ∈ parents (D27) AND caller has 0 coord children (D23) | Eager dispatch reaction on new node (D28) |
| `addEdge` | D22 | both endpoints same wf; to-node status='not_started'; kind-aware from-state by to-kind (D29); DAG ∪ {edge} acyclic | Phase recompute on to-node + not_started descendants; eager dispatch reaction on to-node + descendants (D28) |
| `addSubgraph` | D22 | tempId non-empty + unique; every temp has ≥1 parent (existing or batch); intra-batch acyclic; joined DAG acyclic; existing-targets are not_started; kind-aware per-temp parent-state (D29); ≤1 coord in batch; if coord present: caller ∈ coord's parents (D27) AND caller has 0 coord children (D23); each spec validates | Phase computed for inserted; recompute on existing not_started descendants of newly-edged to-nodes; eager dispatch on inserted + affected (D28) |
| `removeNode` | D22 | node.status='not_started'; no child left with 0 parents | Adjacent edges deleted; phase recompute on not_started descendants |
| `removeEdge` | D22 | to-node.status='not_started'; to-node retains ≥1 parent post-remove | Phase recompute on to-node + not_started descendants |
| `replaceNodeSpec` | D22 | node.status='not_started'; new spec validates; kind unchanged | If coord & this is latest coord (per D31 ordering): denorm refresh |
| `cancelNode` | D22 | node.kind='task'; status ∈ {'not_started','ready','running'} | If running: `handler.cancel` post-tx (best-effort; D-cancel-semantics in cancelNode doc) |
| `finishWorkflow` | D22 | outcome ∈ {'succeeded','failed'}; CAS `workflows.status='running'` → outcome | Cancel reconciliation for non-terminal nodes EXCEPT calling coord (D30) |

# Cross-package wiring sketch

Two concrete `WorkflowNodeKindHandler` implementations, both in
`packages/api/src/wiring/`:

```ts
// packages/api/src/wiring/workflow-task-node-handler.ts
//
// The 'task' kind. Dispatches a regular work task via TaskDispatcher.
// rootDir defaults to <workspaceDir>/tasks/<task_id>/ (no override).
// framingPromptOverride: none (worker agent's normal framing).

export function createWorkflowTaskNodeHandler(deps: {
  readonly taskDispatcher: TaskDispatcher;
  readonly catalog: CatalogService;
  readonly latestCoordAgentFor: (workflowId: string) => Promise<string>;
  // ^ trivially `SELECT coordinator_agent FROM workflows WHERE id=?`
  //   (D14 denorm). Kept as a service abstraction so handlers don't
  //   reach into the SQL layer directly.
}): WorkflowNodeKindHandler { ... }
```

```ts
// packages/api/src/wiring/workflow-coordinator-node-handler.ts
//
// The 'coordinator' kind. Dispatches a coord task via TaskDispatcher
// with:
//   - rootDirOverride       = <wfDir>/coordinator/runs/<task_id>/
//   - framingPromptOverride = FRAMING_PROMPT_COORDINATOR
//   - agent                 = spec.agent
//   - brief / details        = derived from DAG context (auto-generated)

export function createWorkflowCoordinatorNodeHandler(deps: {
  readonly taskDispatcher: TaskDispatcher;
  readonly catalog: CatalogService;
  readonly workspaceDir: string;
  readonly readDagContext: (workflowId: string, nodeId: string) => Promise<CoordContext>;
}): WorkflowNodeKindHandler { ... }
```

Both registered at server compose time:

```ts
workflowService.registerKind('task',        taskNodeHandler);
workflowService.registerKind('coordinator', coordinatorNodeHandler);
```

The substrate pkg `@emploke/workflow` itself has zero dependency on
`@emploke/task` or `@emploke/catalog`. All cross-package knowledge
lives in `packages/api/src/wiring/`.

# Entity-layer invariants (not in DDL)

1. **Workflow liveness.** While `workflow.status='running'` there
   exists **at least one** `kind='coordinator'` node whose status ∈
   `{not_started, ready, running}`. (Normally one — the chain head.
   Briefly two between `addNode(coord)` and the calling coord task's
   exit: the running caller + the not_started successor.) Substrate
   guarantees by: (a) inserting the initial coord at `createWorkflow`;
   (b) D23 limiting at most 1 coord-kind child per coord (rejects 2nd
   `addNode(coord)`); (c) D27 requiring caller coord to be a parent
   of any inserted coord, so coord chain shape is preserved; (d) D20
   silent retry inserting one if coord terminates without leaving a
   successor.

1a. **Non-terminal coord chain shape.** The non-terminal coord-kind
    nodes at any instant form a linear chain of length 1 (chain head
    only) or 2 (running caller → not_started successor). They never
    form a tree, fork, or longer chain. Guaranteed by D23 + D27.
2. **DAG acyclic.** No cycles. Substrate checks on `addEdge` /
   `addNode` / `addSubgraph`; impossible via `removeNode` /
   `removeEdge` / `replaceNodeSpec` / `cancelNode` / `finishWorkflow`.
3. **Phase = topological depth.** For every node N, `N.phase =
   MAX(parents.phase) + 1` where the max over empty parent set is
   `-1` (so roots get phase 0). Substrate guarantees by recomputing
   across the not_started subtree on every edge-mutating primitive.
4. **Status terminal ⇔ `ended_at` non-null** (workflow and node
   both).
5. **Forward-only FSM.** Once a node OR workflow hits a terminal
   status, no further status mutations. (Note: `running → terminal`
   is the only running-state transition; running nodes do NOT go
   back to `ready` except in engine-restart recovery, which is an
   internal substrate operation, not a mutation primitive.)
6. **Structural sealing (D24).** `replaceNodeSpec` / `removeNode`
   target `not_started` only. `addEdge` / `removeEdge` require
   to-node `not_started`. `cancelNode` is the only mutation
   touching `running` (task-kind only). Coord can never reach into
   already-dispatched work.
7. **Immutability of `kind`, `workflow_id`, `id`, `created_at`,
   `phase` (across mutations).** None of these columns change after
   the INSERT that creates the row. `phase` exception: substrate
   may rewrite phase as part of an edge-mutating primitive's
   recomputation cascade across the not_started subtree (D3); from
   the caller's perspective this is observable only on subsequent
   reads.
8. **Coord agent FQN validation** at every coord-kind node INSERT:
   FQN must be installed AND its `dependencies.skills` must include
   `emploke/coordinator`. Applies to `createWorkflow`, `addNode`,
   `addSubgraph`, AND silent retry (D20).
9. **Worker agent FQN validation** at every task-kind node INSERT:
   FQN must be installed AND must appear in the **caller coord
   node's** `spec_json.agent`'s `dependencies.agents`. Mid-workflow
   coord-agent swaps (D19) inherit their new worker palette from
   the swap point forward.
10. **Registered kind required.** `workflow_nodes.kind` must be a
    kind registered via `WorkflowService.registerKind`. Substrate
    throws `UnknownWorkflowNodeKindError` if not registered.
11. **`workflows.coordinator_agent` sync (D14).** The column ALWAYS
    equals `spec_json.agent` of the most-recently-INSERTED
    `kind='coordinator'` node for this workflow. "Most recent" is
    defined by `ORDER BY created_at DESC, id DESC LIMIT 1` (D31
    tie-break — `id DESC` over `randomUUID()` is the deterministic
    fallback when ISO-timestamp collisions happen in fast tests).
    Substrate guarantees by funneling every coord-kind INSERT
    through a single `insertCoordNode(...)` helper that performs
    the `UPDATE workflows SET coordinator_agent = ?` in the SAME
    transaction. D23 + D27 ensure each INSERT path (createWorkflow,
    addNode, addSubgraph, silent retry) inserts exactly 1 coord-kind
    row per transaction. Unit test asserts the invariant after each
    path.
12. **Dispatch atomicity.** Every transition `not_started|ready →
    running` happens via the substrate's `dispatchAtomic(nodeId)`
    primitive, which in a single tx: (a) verifies `workflow.status
    = 'running'` (defends against cancel race); (b) verifies
    `node.status ∈ {'not_started','ready'}`; (c) re-checks parent
    readiness **per-kind**: for `kind='task'` requires all parents
    `status='succeeded'`; for `kind='coordinator'` requires all
    parents in terminal state (any outcome) — so a coord wakes to
    deal with failures, not only to consume successful work; (d)
    writes `status='running', running_at=now`. `handler.dispatch`
    runs AFTER tx commit; if it throws, a follow-up tx writes
    `status='failed'`. Engine-restart recovery: any node in
    `running` with `handler.hasInFlightForNode = false` is reset to
    `ready` for re-dispatch.
13. **`finishWorkflow` once-only.** Substrate CAS:
    `UPDATE workflows SET status=outcome WHERE id=? AND status='running'`.
    Second call sees 0 rows affected and throws
    `WorkflowAlreadyTerminalError`.

# Engine writes (state-mutation cheat sheet)

## createWorkflow(brief, details, coordinatorAgent)

```text
  ├── validate coordinatorAgent (installed + emploke/coordinator skill)  [fail-fast]
  ├── wf_id   = randomUUID()
  ├── coord_0 = randomUUID()
  ├── now     = ISO timestamp
  ├── txn (single):
  │   ├── INSERT workflows (id=wf_id, brief, details,
  │   │                     coordinator_agent=coordinatorAgent,    -- D14 denorm
  │   │                     status='running',                      -- D1, D26
  │   │                     created_at=now)
  │   └── INSERT workflow_nodes (id=coord_0,
  │                              workflow_id=wf_id,
  │                              kind='coordinator',
  │                              spec_json=JSON({agent: coordinatorAgent}),
  │                              phase=0,
  │                              status='not_started',
  │                              created_at=now)
  │   -- (The above two are wrapped by insertCoordNode helper for invariant #11.)
  ├── mkdir <wfDir>/ + write WORKFLOW.md
  └── engine reaction tick:
        └── dispatchAtomic(coord_0)
              → coord_0 has no parents → readiness trivially satisfied
              → status='running', running_at=now
              → handler.dispatch({workflowId, nodeId=coord_0, spec, nodeDir})
                  → TaskDispatcher.dispatch(
                       agent=coordinatorAgent,
                       origin='workflow',
                       metadata={workflowId: wf_id, workflowNodeId: coord_0},
                       rootDirOverride=<wfDir>/coordinator/runs/<task_id>/,
                       framingPromptOverride=FRAMING_PROMPT_COORDINATOR,
                     )
```

## addNode(kind, spec, parents) — caller is coord C

```text
  ├── auth gate D22: C.kind='coordinator' AND C.status='running' AND wf.status='running'
  ├── parents.length ≥ 1; all in same wf
  ├── kind-aware parent-state (D29):
  │     if kind='task':         require no parent in {failed, cancelled}  → reject ParentStateError
  │     if kind='coordinator':  any terminal parent OK (coord wakes on failure per invariant #12)
  ├── normalized = await handler.validate(spec, {workflowId, callerCoordNodeId=C.id, callerCoordSpec=C.spec, workflowStatus='running'})
  ├── if kind='coordinator':
  │     require C.id ∈ parents  [D27, reject OrphanCoordInsertError]
  │     require NOT EXISTS(coord-kind child of C)  [D23, reject MultipleSuccessorCoordsError]
  ├── new_id = randomUUID()
  ├── phase  = MAX(parent.phase for parent in parents) + 1
  ├── txn:
  │   ├── INSERT workflow_nodes (id=new_id, workflow_id, kind, spec_json=JSON(normalized), phase, status='not_started', created_at=now)
  │   ├── INSERT workflow_edges (workflow_id, from_node_id=parent, to_node_id=new_id) for each parent in parents
  │   └── if kind='coordinator':
  │         UPDATE workflows SET coordinator_agent = normalized.agent WHERE id=wf  -- D14 (insertCoordNode helper)
  ├── (tx commits)
  └── eager dispatch reaction (D28):
        if all parents of new_id satisfy per-kind readiness (invariant #12):
          dispatchAtomic(new_id)
        (covers the case where parents were already terminal at insert time —
         no future parent-termination event would have fired)
  └── return {nodeId: new_id, phase}
```

## addEdge(fromId, toId) — caller is coord C

```text
  ├── auth gate D22
  ├── both endpoints in same wf as C
  ├── to-node.status = 'not_started'  [D24, reject NodeNotMutableError]
  ├── kind-aware from-state by to-node kind (D29):
  │     if to-node.kind='task':         require from-node not in {failed, cancelled}
  │     if to-node.kind='coordinator':  any from-state OK
  ├── DAG ∪ {(fromId, toId)} acyclic  [reject EdgeCycleError]
  ├── txn:
  │   ├── INSERT workflow_edges (workflow_id, from_node_id=fromId, to_node_id=toId)
  │   ├── recomputed = topoSortAndRecomputePhases(starting from toId, traversing only not_started descendants)
  │   └── for each (nodeId, newPhase) in recomputed where newPhase changed:
  │         UPDATE workflow_nodes SET phase = newPhase WHERE id = nodeId
  ├── (tx commits)
  └── eager dispatch reaction (D28):
        for n in {toId} ∪ (not_started descendants of toId):
          if all parents of n satisfy per-kind readiness (invariant #12):
            dispatchAtomic(n)
  └── return {toPhase}
```

## addSubgraph(batch) — caller is coord C

```text
  ├── auth gate D22
  ├── for each batch.nodes[i]:
  │     tempId non-empty, unique within batch
  │     ≥1 parent (from existingParents OR incoming intra-batch edge)  [reject ParentlessTempError]
  │     normalized[i] = await handler.validate(nodes[i].spec, {... callerCoord=C ...})
  │     existingParents[i] (if any): all in same wf
  ├── for each batch.edges[i]:
  │     from = resolve(edge.from): temp or existing
  │     to   = resolve(edge.to):   temp or existing-not-started
  │     if to is existing: to.status = 'not_started'  [D24]
  ├── kind-aware per-temp parent-state (D29):
  │     for each temp T:
  │       if T.kind='task':         no resolved parent (existing or temp) in {failed, cancelled}
  │       if T.kind='coordinator':  any parent state OK (terminal parents allowed)
  ├── intra-batch graph (temp nodes + intra-batch edges) acyclic
  ├── joined graph (live DAG ∪ batch) acyclic
  ├── coord-count-in-batch ≤ 1; if 1 coord T_c:
  │     C has 0 existing coord children  [D23]
  │     C ∈ resolved parents of T_c     [D27, reject OrphanCoordInsertError]
  ├── tempId → real id map = {tempId: randomUUID() for each batch.nodes[i]}
  ├── topo sort the batch + existing-parents structure
  ├── for each node in topo order:
  │     parent_phases = [(existing parent's phase from DB)] ∪ [(temp parent's just-computed phase)]
  │     phase[node] = MAX(parent_phases) + 1
  ├── recomputeDescendants = {existing not_started descendants of any existing-to-target that gained a new edge}
  ├── txn:
  │   ├── INSERT workflow_nodes for each batch node (id from map, phase from above, status='not_started', created_at=now)
  │   ├── INSERT workflow_edges for each batch edge (resolved ids) AND each (existing-parent, temp-node) pair
  │   ├── for each (nodeId, newPhase) in recomputeDescendants:
  │   │     UPDATE workflow_nodes SET phase = newPhase WHERE id = nodeId
  │   └── if batch contained a coord node:
  │         UPDATE workflows SET coordinator_agent = coord_node.normalized.agent WHERE id=wf  -- D14
  ├── (tx commits)
  └── eager dispatch reaction (D28):
        for n in (all inserted temps) ∪ (existing not_started nodes that gained edges):
          if all parents of n satisfy per-kind readiness (invariant #12):
            dispatchAtomic(n)
  └── return {insertedNodes: [{tempId, nodeId, phase}, ...]}
```

## removeNode(nodeId) — caller is coord C

```text
  ├── auth gate D22
  ├── node.workflow_id = C.workflow_id
  ├── node.status = 'not_started'  [D24]
  ├── for each child (via outgoing edges):
  │     if child has only 1 parent (this node) and child is not_started → reject WouldOrphanChildError
  │       (coord must removeNode the children first, or add replacement parent edges)
  │     -- (children with multiple parents survive with one less parent; their phase may shrink)
  ├── recomputeDescendants = {not_started descendants whose longest-path-from-root included this node}
  ├── txn:
  │   ├── DELETE workflow_edges WHERE to_node_id=nodeId OR from_node_id=nodeId
  │   ├── DELETE workflow_nodes WHERE id=nodeId
  │   └── for each (n, newPhase) in recomputeDescendants:
  │         UPDATE workflow_nodes SET phase = newPhase WHERE id = n
  └── return
```

## removeEdge(fromId, toId) — caller is coord C

```text
  ├── auth gate D22
  ├── edge exists
  ├── to-node.status = 'not_started'  [D24]
  ├── to-node has > 1 parent (removing wouldn't leave it orphaned)  [else reject WouldOrphanChildError]
  ├── recomputeDescendants = {not_started descendants whose longest-path-from-root included fromId via toId}
  ├── txn:
  │   ├── DELETE workflow_edges WHERE from_node_id=fromId AND to_node_id=toId
  │   └── for each (n, newPhase) in recomputeDescendants:
  │         UPDATE workflow_nodes SET phase = newPhase WHERE id = n
  └── return
```

## replaceNodeSpec(nodeId, newSpec) — caller is coord C

```text
  ├── auth gate D22
  ├── node.workflow_id = C.workflow_id
  ├── node.status = 'not_started'  [D24]
  ├── normalized = await handler.validate(newSpec, {... callerCoord=C ...}) for node.kind
  ├── (kind unchanged)
  ├── txn:
  │   ├── UPDATE workflow_nodes SET spec_json = JSON(normalized) WHERE id=nodeId
  │   └── if node.kind='coordinator':
  │         -- Only refresh denorm if THIS node IS the latest coord (D31 ordering).
  │         -- If a newer coord was inserted after this one (e.g. caller C is itself
  │         -- the latest), the denorm should not change.
  │         UPDATE workflows SET coordinator_agent = normalized.agent
  │           WHERE id = wf
  │             AND nodeId = (SELECT id FROM workflow_nodes
  │                            WHERE workflow_id = wf AND kind = 'coordinator'
  │                            ORDER BY created_at DESC, id DESC LIMIT 1)
  └── return
```

## cancelNode(nodeId) — caller is coord C

```text
  ├── auth gate D22
  ├── node.workflow_id = C.workflow_id
  ├── node.kind = 'task'  [Q-schema-9: task-kind only]
  ├── node.status ∈ {'not_started', 'ready', 'running'}
  ├── txn:
  │   └── UPDATE workflow_nodes SET status='cancelled', ended_at=now WHERE id=nodeId
  ├── post-tx: if previous status = 'running': handler.cancel(nodeId) (idempotent)
  └── engine reaction: for each child via edges:
        if child.kind = 'task' and all its parents now in terminal-failed-or-cancelled:
          (the child can never become ready — leave it not_started; coord cleanup expected)
```

## finishWorkflow({outcome}) — caller is coord C

```text
  ├── auth gate D22
  ├── outcome ∈ {'succeeded', 'failed'}
  ├── (optional runtime guard) if outcome='succeeded':
  │     verify <wfDir>/artifact/index.html exists  [or other v1 success contract]
  ├── txn:
  │   └── UPDATE workflows SET status=outcome, ended_at=now WHERE id=wf AND status='running'
  │       └── if 0 rows affected: throw WorkflowAlreadyTerminalError
  └── post-tx cancel reconciliation (D30 — SKIP caller C):
        for each non-terminal workflow_nodes row WHERE workflow_id=wf AND id != C.id:
          ├── handler.cancel(node.id)   -- no-op if no in-flight unit; best-effort, logs on failure
          └── txn: UPDATE workflow_nodes SET status='cancelled', ended_at=now WHERE id=node.id
        -- The calling coord C is EXCLUDED. C's task continues to its natural exit;
        -- the coord-termination handler later marks C.status terminal via the normal path.
        -- workflow.status is already terminal so silent retry won't fire on C's exit.
        -- This avoids the race where reconciliation cancels the very task currently
        -- inside finishWorkflow.
```

## A coord node's task terminates — substrate event handler

```text
  ├── txn:
  │   └── UPDATE workflow_nodes SET status=<terminal>, ended_at=now WHERE id = <coord node id>
  ├── if workflow.status terminal (succeeded / failed / cancelled): done
  │
  ├── ── liveness check (D20 silent retry) ──
  │   has_live_coord = EXISTS(
  │     SELECT 1 FROM workflow_nodes
  │     WHERE workflow_id = wf
  │       AND kind = 'coordinator'
  │       AND status NOT IN ('succeeded','failed','cancelled')
  │   )
  │   if NOT has_live_coord:
  │     ── coord failed to leave a successor; silent-retry insert one ──
  │     retry_id   = randomUUID()
  │     prev_spec  = <just-terminated coord>.spec_json
  │     -- parents = current DAG sinks (= nodes with 0 outgoing edges that aren't this retry coord)
  │     -- These may include {running, succeeded, failed, cancelled} sinks. Per invariant
  │     -- #12, a coord-kind node dispatches when ALL parents are terminal (any outcome), so:
  │     --   - If all sinks terminal: retry coord ready immediately → eager dispatch fires below
  │     --   - If any sink running:   retry coord waits; its eventual termination event triggers dispatch
  │     -- Edge case: if just-terminated coord had no children, sinks = {just-terminated coord}.
  │     -- It's terminal, so retry coord is immediately ready → eager dispatch.
  │     sinks      = SELECT id FROM workflow_nodes wn
  │                  WHERE workflow_id = wf
  │                    AND NOT EXISTS(SELECT 1 FROM workflow_edges we WHERE we.from_node_id = wn.id)
  │                    AND wn.id != retry_id
  │     phase      = MAX(sink.phase for sink in sinks) + 1
  │     txn:
  │       ├── INSERT workflow_nodes (id=retry_id, workflow_id=wf, kind='coordinator',
  │       │                           spec_json=prev_spec, phase=phase,
  │       │                           status='not_started', created_at=now)
  │       ├── INSERT workflow_edges (workflow_id=wf, from_node_id=sink, to_node_id=retry_id) for sink in sinks
  │       └── UPDATE workflows SET coordinator_agent = json_extract(prev_spec, '$.agent') WHERE id=wf  -- D14
  │     -- (Above wrapped by insertCoordNode helper for invariant #11.)
  │     -- (Note: coordinator_agent often unchanged from prev value, but the UPDATE
  │     --  keeps the invariant unambiguous and the helper signature consistent.)
  │     -- post-tx: eager dispatch (D28)
  │     if all sinks ∈ {'succeeded','failed','cancelled'}:
  │       dispatchAtomic(retry_id)
  │
  └── ── dispatch reaction ──
      for each child of <just-terminated coord> via outgoing edges:
        if all its parents are now in terminal state:
          dispatchAtomic(child.id)   -- invariant #12 enforces per-kind parent-status guard atomically
      (the silent-retry retry coord, if just inserted, was already handled
       by the eager dispatch above)
```

## A task node's task terminates — substrate event handler

```text
  ├── txn:
  │   └── UPDATE workflow_nodes SET status=<terminal>, ended_at=now WHERE id=<task node>
  ├── if workflow.status terminal: done
  └── dispatch reaction: for each child via outgoing edges:
        if all child's parents are now in terminal state:
          dispatchAtomic(child.id)   -- per-kind readiness guard inside (invariant #12)
```

## dispatchAtomic(nodeId)  [substrate primitive; invariant #12]

```text
  ├── txn:
  │   ├── SELECT workflow.status, node.status, node.kind
  │   │   FROM workflow_nodes JOIN workflows ON workflow_id=workflows.id
  │   │   WHERE node.id=nodeId
  │   ├── if workflow.status terminal: ABORT (cancelled before dispatch)
  │   ├── if node.status ∉ {'not_started','ready'}: ABORT (already dispatched)
  │   ├── per-kind parent-readiness re-check (topo may have raced):
  │   │     if node.kind = 'task':
  │   │       verify ALL parents.status = 'succeeded'    -- work needs successful inputs
  │   │     if node.kind = 'coordinator':
  │   │       verify ALL parents.status ∈ {'succeeded','failed','cancelled'}  -- coord wakes
  │   │       (any terminal status OK; coord uses the failure as input)         -- to handle failure
  │   └── UPDATE workflow_nodes SET status='running', running_at=now WHERE id=nodeId
  ├── (tx commits)
  ├── try: handler.dispatch({workflowId, nodeId, spec, nodeDir})
  └── on dispatch error: separate tx — UPDATE workflow_nodes SET status='failed', ended_at=now WHERE id=nodeId

  (engine restart recovery: scan status='running' nodes whose
   handler.hasInFlightForNode returns false; reset to 'ready'.)
```

## cancelWorkflow(wfId)  [external API; NOT in WorkflowMutationAPI]

```text
  ├── (no D22 auth gate — this is external operator action via CLI/dashboard;
  │    surface-layer auth governs caller authority)
  ├── txn:
  │   └── UPDATE workflows SET status='cancelled', ended_at=now WHERE id=wfId AND status='running'
  │       └── if 0 rows: throw WorkflowAlreadyTerminalError
  └── post-tx cancel reconciliation:
        for each non-terminal workflow_nodes row WHERE workflow_id=wfId:
          ├── handler.cancel(node.id)
          └── txn: UPDATE workflow_nodes SET status='cancelled', ended_at=now WHERE id=node.id
```

# §Extensibility — eval / audit / any "agent at phase boundary"

The substrate has no `kind='evaluator'`, no `kind='auditor'`, no
`kind='monitor'`. These patterns are achieved by the coord scheduling
ordinary `kind='task'` worker nodes with the appropriate agent FQN.
Eval workers read sibling output via the **unauthed read APIs** (D22):
no coord-kind privilege needed.

**Eval-of-work pattern.** Coord schedules an `eval_work` task node
with parent edges from all work nodes whose output it evaluates:

```
coord_N → work_a, work_b, work_c
work_a, work_b, work_c → eval_work
eval_work → coord_{N+1}
```

`eval_work`'s agent calls `getDag(workflowId)` (unauthed) to walk
the DAG and `getNodeDir(nodeId)` for each sibling work node to read
their output dirs. Substrate is unaware of the "eval" role.

**Eval-of-coord pattern.** Coord schedules an `eval_coord_N` task
node with a parent edge from the coord itself (which terminates
before its children are ready, so eval_coord_N reads complete coord
activity log):

```
coord_N → eval_coord_N
coord_N → work_a, work_b, work_c
work_a, work_b, work_c → eval_work
eval_work, eval_coord_N → coord_{N+1}
```

`eval_coord_N`'s agent reads `getNodeDir(coord_N.id)` →
`<wfDir>/coordinator/runs/<coord_N_task_id>/`. Coord_{N+1} reads
the eval and may swap coord agent for coord_{N+2} (D19).

**Audit, fan-in-summary, etc.** Same pattern. Coord schedules the
audit/summary node with appropriate edges. No substrate awareness.

**Construction shape: a single `addSubgraph` call.** A coord typically
expresses the eval-of-work pattern as one `addSubgraph` batch
containing work + eval + next-coord + intra-batch edges (atomic
commit). Could also use multiple `addNode` + `addEdge` calls; either
works.

**Trust caveat.** A bad coord can refuse to schedule eval of itself,
or schedule a sycophantic eval agent. This is not preventable
architecturally — same trust assumption as any agent-based system.
Mitigations: framing prompt convention + offline cross-workflow
monitoring + downstream output quality as ground-truth signal.

See `coord-eval-design-discussion.md` §"Bonus" for fuller treatment.

# §UI rendering

DAG visualization is a first-class requirement (not nice-to-have). UI
fetches `GET /workflows/{id}/dag` returning `{ workflow, nodes, edges }`
(equivalent to `getDag(id)`) and renders hierarchically using `phase`
as Y-axis layer:

```sql
-- Equivalent of getDag(id):
SELECT id, brief, details, coordinator_agent, status, metadata,
       created_at, started_at, ended_at
FROM workflows WHERE id = ?;

SELECT id, kind, spec_json, phase, status, created_at, ready_at, running_at, ended_at
FROM workflow_nodes WHERE workflow_id = ? ORDER BY phase, created_at;

SELECT from_node_id, to_node_id
FROM workflow_edges WHERE workflow_id = ?;
```

`phase` is the **sole reason** the column survives (engine no
longer needs it; see schema-v1.md for the obsolete engine uses). Each
phase becomes a horizontal band in the rendered DAG; edges go
vertically across phases.

"Is coord awake right now?" is computed client-side:

```ts
const awake = nodes.some(n => n.kind === 'coordinator' && n.status === 'running');
```

(or with the `hasLiveCoord(nodes)` helper exported from
`packages/workflow/src/types.ts`.)

"Iteration count" UI label (`Iteration N`) is derived:

```sql
SELECT COUNT(*) FROM workflow_nodes
WHERE workflow_id = ? AND kind = 'coordinator';
```

**Note on silent-retry coords**: this count INCLUDES silent-retry
coord nodes (D20). They are indistinguishable from planned coord
iterations in the schema. This is intentional for v1 — a retry IS
an iteration from the user's perspective ("the coord woke up
again"). If UI wants to distinguish, add a `metadata` column or a
`source: 'planned' | 'silent_retry'` field on the coord spec in v2.

Render together: `Workflow X · Iteration 5 · DAG depth 11 · Coord awake`.

# Migration plan (v0.6.0 → v1.0.0)

Per D9, no real-user data exists. The migration is a drop + recreate
of the three workflow tables.

```sql
-- packages/workflow/drizzle/0001_v1_recreate.sql

DROP TABLE IF EXISTS workflow_edges;
DROP TABLE IF EXISTS workflow_nodes;
DROP TABLE IF EXISTS workflows;

-- (recreate workflows, workflow_nodes, workflow_edges per Tables 1-3 above)
```

```sql
-- packages/task/drizzle/00NN_tasks_workflow_indexes.sql
-- (additive only — never existed before)

CREATE INDEX tasks_workflow_id_idx
  ON tasks (json_extract(metadata, '$.workflowId'))
  WHERE origin = 'workflow';

CREATE INDEX tasks_workflow_node_id_idx
  ON tasks (json_extract(metadata, '$.workflowNodeId'))
  WHERE origin = 'workflow';
```

No data migration script. No `tasks` row backfill.

# Open questions (v2 / post-v1)

None blocking v1.0.0 implementation start. For v2 consideration:

- **Silent retry budget.** `consecutive_failed_silent_retries`
  deferred to v2. Without it, an infinitely-failing coord agent can
  fill the DAG with ever-deeper silent-retry coord chains until the
  workflow is cancelled externally. Acceptable for v1 dogfooding.
- **`resumeWorkflow(wfId)` API.** A workflow that reached terminal
  state (e.g., `cancelled` after user thought it done, or
  `succeeded` then user wants to add follow-up work) cannot be
  re-opened in v1. Adding this is straightforward: CAS
  `workflows.status='running'` on a terminal row + insert a new
  coord-kind node. Defer to v2 to keep v1 surface tight.
- **Cross-workflow sub-workflows.** A coord that spawns a child
  workflow (and waits on its outcome) requires either a new
  `kind='sub_workflow'` node OR a cross-table reference scheme.
  Out of scope for v1.
- **Substrate-enforced successor-coord placement (Q-schema-7).**
  Promote D25 from "trust the prompt" to substrate-enforced "successor
  coord must be at max(phase)". Implementation cost is moderate
  (recompute every edge-mutation to check); only worth it if real
  coord agents violate the convention enough to matter.
- **Coord-kind `cancelNode` (Q-schema-9).** Allow per-node cancel for
  coord-kind nodes (currently task-kind only). Today `cancelWorkflow`
  is the only way to stop a running coord. If granular coord control
  becomes a pain point, lift the restriction.
