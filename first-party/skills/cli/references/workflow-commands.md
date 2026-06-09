# Workflow subcommands

`emploke workflow …` is the coordinator-facing surface: it lets a workflow
header live in the substrate, exposes the live DAG, and lets a `kind:
coordinator` task mutate the DAG (add nodes, add edges, replace specs,
cancel, finish) while it runs. Workers don't touch this surface — they
just do their job and exit; the substrate joins their result back to the
DAG node via `task.metadata.workflowNodeId`.

> All examples assume `EMPLOKE_WORKSPACE=<id>` is set; add
> `--workspace <id>` to act on a different workspace.

> **Output / exit-code discipline applies uniformly.** Every subcommand
> below accepts the common `--server / --home / --workspace / --output /
> --json` flags, returns table by default and machine-parseable JSON when
> `--json` is passed, and shares the exit-code table documented in
> `SKILL.md` (0 success, 2 usage error, 3 unreachable, 4 server 4xx/5xx).
> Per-command sections below only call out **additional** required /
> optional flags, the HTTP route the command wraps, and the response shape.

---

## Subcommand index

| Subcommand | Purpose | Coord-only? |
| --- | --- | --- |
| [`list`](#emploke-workflow-list) | List workflows in the workspace | no |
| [`create`](#emploke-workflow-create) | Seed a workflow + initial coord node | no |
| [`show`](#emploke-workflow-show) | Print one workflow's header | no |
| [`dag`](#emploke-workflow-dag) | Print the full DAG snapshot | no |
| [`node-show`](#emploke-workflow-node-show) | Print one node's projection | no |
| [`add-node`](#emploke-workflow-add-node) | Insert a single node attached to existing parents | **yes** |
| [`add-subgraph`](#emploke-workflow-add-subgraph) | Insert N nodes + intra-batch edges atomically | **yes** |
| [`add-edge`](#emploke-workflow-add-edge) | Add a single edge between two existing nodes | **yes** |
| [`remove-node`](#emploke-workflow-remove-node) | Delete a `not_started` node (and adjacent edges) | **yes** |
| [`remove-edge`](#emploke-workflow-remove-edge) | Delete a single edge | **yes** |
| [`replace-spec`](#emploke-workflow-replace-spec) | Re-validate + replace a node's opaque spec | **yes** |
| [`cancel`](#emploke-workflow-cancel) | Cancel a running workflow (operator) | no |
| [`cancel-node`](#emploke-workflow-cancel-node) | Cancel a single worker node | **yes** |
| [`finish`](#emploke-workflow-finish) | Flip the workflow terminal | **yes** |

"Coord-only" is a logical marker — the substrate no longer enforces a
caller-coord authorization gate, so any client with workspace access can
hit these endpoints. Mark mutation-style commands as coord-only in your
own playbook to keep the human-vs-orchestrator boundary explicit.

---

## `emploke workflow list`

- Args: none
- Route: `GET /workspaces/:id/workflows`
- Output (table): columns `id | brief | coordinatorAgent | status | createdAt`
- Output (json): `WorkflowHeaderWire[]` — each element omits `iterationCount`
  (the list path skips the per-row DAG fetch; use `show` when you need it)

```sh
emploke workflow list --json | jq '.[] | {id, status, coordinatorAgent}'
```

---

## `emploke workflow create`

- Required flags: `--brief <text>`, `--coord-agent <fqn>`
- Optional flags: `--details <text>`, `--details-file <path>`,
  `--metadata-file <path>` (JSON object, persisted on the workflow row)
- Route: `POST /workspaces/:id/workflows`
- Body: `CreateWorkflowBody` —
  `{ brief, coordinatorAgent, details?, metadata? }`
- Output: `WorkflowHeaderWire` (status `running`, `iterationCount: 1` —
  one freshly-created coord node)

```sh
WF=$(emploke workflow create \
       --brief        "Add /healthz endpoint returning {ok:true}" \
       --coord-agent  emploke/coordinator \
       --json | jq -r '.id')
```

The initial coord node is dispatched by the engine as soon as the row
lands; the coord's wake-up sees a single `not_started` self-parent-less
node and runs the strategy's "no parents" case.

---

## `emploke workflow show`

- Required flags: `--wfid <id>`
- Route: `GET /workspaces/:id/workflows/:wfid`
- Output: `WorkflowHeaderWire` with accurate `iterationCount` (count of
  worker dev nodes in the DAG, irrespective of status)

Use over `list` whenever you need iteration count or want a single-row
fetch by id.

---

## `emploke workflow dag`

- Required flags: `--wfid <id>`
- Route: `GET /workspaces/:id/workflows/:wfid/dag`
- Output (table): node table (`phase | nodeId | kind | status | agent`)
  followed by edge lines (`from → to`)
- Output (json): `WorkflowDagWire` —
  `{ header: WorkflowHeaderWire, nodes: WorkflowNodeWire[], edges: WorkflowEdgeWire[] }`

`WorkflowNodeWire.kind` is `"coordinator" | "worker"` (full word on both
write and read paths). `WorkflowNodeWire.spec.kind` mirrors the node kind.
`WorkflowNodeWire.taskId` is filled for worker nodes after dispatch; coord
nodes carry their own `taskId` once dispatched too.

```sh
# Coord's bread-and-butter: read the full DAG, find own parents.
DAG=$(emploke workflow dag --wfid "$WFID" --json)
echo "$DAG" | jq --arg me "$NODE_ID" \
  '.edges[] | select(.to == $me) | .from'
```

---

## `emploke workflow node-show`

- Required flags: `--wfid <id>`, `--nid <id>`
- Route: `GET /workspaces/:id/workflows/:wfid/nodes/:nid`
- Output: `WorkflowNodeWire` (table mirrors the `dag` node row, plus
  `taskId`)
- Errors: 400 invalid id, 404 not found

Use when you already know a node id (e.g. parent id from `dag`) and want
to skip re-fetching the whole snapshot. Common in coord wake-up when you
need to read a parent's `taskId` to look up its task and verdict.

```sh
# Read a single parent node — get its taskId, then read the verdict.
PARENT_TID=$(emploke workflow node-show \
               --wfid "$WFID" --nid "$PARENT_ID" --json | jq -r '.taskId')
emploke task show --tid "$PARENT_TID" --json | jq '.workdir'
```

---

## `emploke workflow add-node`

- Required flags: `--wfid <id>`, `--kind <coordinator|worker>`,
  `--spec-file <path>`
- Optional flags: `--parents <id1,id2,...>` (comma-separated; an empty
  list is rejected by the substrate — every non-initial node needs ≥1
  parent)
- Route: `POST /workspaces/:id/workflows/:wfid/nodes`
- Body: `AddNodeBody` — `{ kind, parents, spec }`; `spec` comes from
  `--spec-file` parsed as JSON
- Output (table): `nodeId | phase`
- Output (json): `AddNodeResultWire` — `{ nodeId, phase }`

Spec shape by kind (substrate-side validation; details enforced at write):

```jsonc
// coordinator spec — only field allowed is `agent`
{ "agent": "emploke/coordinator" }

// worker spec — `agent` required; `brief` and `details` overlay onto
// whatever the workflow header provides
{ "agent": "emploke/dev", "brief": "…", "details": "…" }
```

`add-node` is fine for single-parent appends but does NOT support
intra-batch wiring (cannot reference a node that doesn't exist yet). For
"add dev + add coord-after-dev" use `add-subgraph` to keep the operation
atomic.

---

## `emploke workflow add-subgraph`

- Required flags: `--wfid <id>`, `--spec-file <path>`
- Route: `POST /workspaces/:id/workflows/:wfid/subgraph`
- Body: `AddSubgraphBody` — entire payload from `--spec-file`:
  ```jsonc
  {
    "nodes": [
      { "tempId": "n1", "kind": "worker", "parents": ["<existing-node-id>"],
        "spec": { "agent": "emploke/dev", "brief": "…", "details": "…" } },
      { "tempId": "n2", "kind": "coordinator", "parents": [],
        "spec": { "agent": "emploke/coordinator" } }
    ],
    "edges": [
      { "from": "n1", "to": "n2" }   // tempIds resolve within the batch
    ]
  }
  ```
- Output (table): `tempId | nodeId | phase` per row
- Output (json): `AddSubgraphResultWire` —
  `{ inserted: [{ tempId, nodeId, phase }] }`

Substrate rules enforced atomically:
- Every node's `parents` may reference existing-node ids OR tempIds from
  the same batch.
- `edges` use tempIds OR existing ids; both are resolved before insertion.
- No cycles, no orphan coords (every batch with multiple coord-temps must
  have exactly one successor coord per parent group), at-most-one-live-
  coord-per-parent invariant preserved post-insert.

The coord strategies (see `emploke/coordinator` skill §B) build their
"dev + next-coord" or "review + designer + next-coord" expansions with
this command so the engine sees a self-consistent DAG slice.

---

## `emploke workflow add-edge`

- Required flags: `--wfid <id>`, `--from <id>`, `--to <id>`
- Route: `POST /workspaces/:id/workflows/:wfid/edges`
- Body: `AddEdgeBody` — `{ fromNodeId, toNodeId }`
- Output (table): `edge <from> → <to> inserted (toPhase=<n>)`
- Output (json): `AddEdgeResultWire` — `{ fromNodeId, toNodeId, toPhase }`

`toPhase` is the destination node's recomputed phase after insertion (an
edge can shift the to-node's phase forward in the topological order). Use
the returned value, not the previously-cached one, if your follow-up
logic depends on phase.

---

## `emploke workflow remove-node`

- Required flags: `--wfid <id>`, `--nid <id>`
- Route: `DELETE /workspaces/:id/workflows/:wfid/nodes/:nid`
- Output: `node <nid> removed from workflow <wfid>`

The node must be in `not_started`. Adjacent edges (in & out) are deleted
in the same transaction. Removing a running / terminal node is rejected
with `WorkflowNodeNotMutableError` (400).

---

## `emploke workflow remove-edge`

- Required flags: `--wfid <id>`, `--from <id>`, `--to <id>`
- Route: `DELETE /workspaces/:id/workflows/:wfid/edges/:from/:to`
- Output: `edge <from> → <to> removed from workflow <wfid>`

The destination node must still be `not_started`; removing an edge
feeding a running or terminal node is rejected.

---

## `emploke workflow replace-spec`

- Required flags: `--wfid <id>`, `--nid <id>`, `--spec-file <path>`
- Route: `PATCH /workspaces/:id/workflows/:wfid/nodes/:nid/spec`
- Body: `ReplaceNodeSpecBody` — `{ newSpec }` from `--spec-file`
- Output: `WorkflowNodeWire` (table mirrors `dag`'s node row)

The node's `kind` does not change; `newSpec` is re-validated against the
same kind rules. Used by coord to swap an agent or rewrite a brief on a
node it has already created but not yet dispatched (node must be
`not_started`).

---

## `emploke workflow cancel`

- Required flags: `--wfid <id>`
- Optional flags: `--message <text>` (defaults to empty),
  `--kind <user>` (only `"user"` accepted)
- Route: `POST /workspaces/:id/workflows/:wfid/cancel`
- Body: `CancelWorkflowBody` — `{ cancellation: { kind: "user", message } }`
- Output: `workflow <id> cancelled` + `WorkflowHeaderWire`

Triggers the cascade reconciler: every non-terminal node is cancelled
with reason `"workflow cancelled"`. Use sparingly — coord normally
finishes itself via `finish` instead of being externally cancelled.

---

## `emploke workflow cancel-node`

- Required flags: `--wfid <id>`, `--nid <id>`
- Route: `POST /workspaces/:id/workflows/:wfid/nodes/:nid/cancel`
- Output: `node <nid> cancelled` + `WorkflowNodeWire`

Body is empty (mirrors `task cancel`). Runner-level defaults supply the
reason: a worker node gets `"cancelled by coordinator"`; a coord node
gets `"cancelled by operator (workflow cancel)"`. The reason is stored
on the underlying task entity (`tasks.cancellation.message`); read it via
`emploke task show --tid <taskId>` for worker nodes.

---

## `emploke workflow finish`

- Required flags: `--wfid <id>`, `--outcome <succeeded|failed>`
- Mutually exclusive:
  - `--summary <text>` — only with `--outcome succeeded` (sets `success.output`)
  - `--message <text>` — **required** with `--outcome failed` (sets `failure.message`)
- Route: `POST /workspaces/:id/workflows/:wfid/finish`
- Body: `FinishWorkflowBody`:
  ```jsonc
  // succeeded
  { "outcome": "succeeded", "success": { "output": <string|null> } }
  // failed
  { "outcome": "failed",
    "failure": { "kind": "coordinator", "message": "<reason>" } }
  ```
  `failure.kind` is always `"coordinator"` (the only currently-valid
  arm; future arms are reserved). Don't try to send `"coord"` (the old
  3-letter value) — it is rejected.
- Output: `workflow <wfid> finished as <outcome>` + `WorkflowHeaderWire`

Idempotent on re-call with the same outcome (substrate compares and
no-ops); calling with a conflicting outcome returns
`WorkflowAlreadyTerminalError` (400).

---

## Common patterns

### Coord introspection (every wake-up)

```sh
# 1. Workflow header — brief, status, coord agent fqn.
WF_HDR=$(emploke workflow show --wfid "$WFID" --json)

# 2. Full DAG snapshot — nodes + edges.
DAG=$(emploke workflow dag --wfid "$WFID" --json)

# 3. Direct parents of own node id.
PARENT_IDS=$(echo "$DAG" | jq -r --arg me "$NODE_ID" \
               '.edges[] | select(.to == $me) | .from')

# 4. Per parent: kind / status / agent / taskId.
for P in $PARENT_IDS; do
  echo "$DAG" | jq --arg p "$P" \
    '.nodes[] | select(.id == $p) | {kind, status, agent: .spec.agent, taskId}'
done
```

### Reading a finished worker's verdict

```sh
# Given a parent worker node id, fetch the task workdir then read verdict.json.
TID=$(emploke workflow node-show \
        --wfid "$WFID" --nid "$PARENT_ID" --json | jq -r '.taskId')
WD=$(emploke task show --tid "$TID" --json | jq -r '.workdir')
jq . "$WD/verdict.json"
```

### Batch DAG mutation (the typical coord expansion)

```sh
# Build a subgraph payload that wires dev → next-coord using tempIds.
cat > /tmp/expand.json <<EOF
{
  "nodes": [
    { "tempId": "dev",   "kind": "worker", "parents": ["$ME"],
      "spec": { "agent": "emploke/dev",
                "brief":   $(printf '%s' "$WORKER_BRIEF" | jq -Rs .),
                "details": $(printf '%s' "$WORKER_DETAILS" | jq -Rs .) } },
    { "tempId": "coord", "kind": "coordinator", "parents": [],
      "spec": { "agent": "emploke/coordinator" } }
  ],
  "edges": [
    { "from": "dev", "to": "coord" }
  ]
}
EOF

emploke workflow add-subgraph --wfid "$WFID" --spec-file /tmp/expand.json --json
```

### Finishing the workflow

```sh
# Success.
emploke workflow finish --wfid "$WFID" --outcome succeeded \
  --summary "All reviewers approved with only minor findings remaining."

# Failure (reason required).
emploke workflow finish --wfid "$WFID" --outcome failed \
  --message "dev iteration ended in failed; cannot make progress."
```

---

## See also

- `emploke/coordinator` skill — coord's operating model, strategies, brief
  templates, and verdict.json schema. The skill is the contract for what
  *should* be dispatched; this reference documents *how* to dispatch it.
- `SKILL.md` (this skill) — output / exit-code discipline and workspace
  scoping conventions all subcommands inherit.
