---
name: coordinator
scope: emploke
description: "Generic workflow-coordinator framework — operating model, DAG introspection patterns, verdict.json schema, brief-plumbing meta-pattern, and authoring guidance for strategy skills"
version: 1.0.0
---

# Emploke Coordinator Skill

The framework every workflow coordinator wake-up loads: how to read the DAG, what schema reviewer workers emit in `verdict.json`, how to plumb context into worker briefs, and how to author a sibling strategy skill. The case bank, brief templates, and stop condition for any given workflow live in a sibling **strategy skill** (for v1: `emploke/dev-review-loop`); the scaffolding here is strategy-agnostic.

CLI invocations cited below (`workflow show`, `dag`, `node-show`, `add-subgraph`, `finish`, `task show`) are documented in the `emploke/cli` skill, loaded alongside this one.

---

## §A — Operating model

```
1. Read own node id from the task spec / env
2. Read workflow header:           emploke workflow show     --wfid $WF --json
3. Read full DAG:                  emploke workflow dag      --wfid $WF --json
4. Identify own parents:           edges where to == own node id
5. Identify selected strategy:
   - read workflow.metadata.strategy if set
   - else read workflow.brief for an explicit hint
   - else fall back to the only strategy declared in the coord agent's deps
6. Load the corresponding strategy skill's case bank (see §B in that skill)
7. Match own parents against the case bank, execute the matching case
8. Log decision + reasoning to <task-workdir>/coord-decision.md
9. Exit (coord run terminates; substrate detects task terminal;
   next coord wake-up only happens when its own future parents complete)
```

- One wake-up = one decision = one mutation. Use `add-subgraph` OR `finish`. Never loop waiting for parents — the substrate re-wakes coord when its parents land terminal.
- Re-read every identifier from the DAG snapshot every wake-up. Do not cache parent ids, task ids, or branch names across wake-ups. The DAG IS the state.
- The strategy skill owns the case bank; the scaffolding here is universal. Do not look for concrete cases in this skill.

### Strategy selection details

Resolve step 5 in priority order:

1. `workflow.metadata.strategy` — explicit strategy FQN set by the workflow creator (e.g. `"emploke/dev-review-loop"`).
2. An explicit hint inside `workflow.brief` (e.g. `strategy: emploke/research-synth`).
3. The sole strategy among the coord agent's `dependencies.skills` when exactly one is declared.

If none of the three yields a strategy, terminate: `workflow finish --outcome failed --message "coord could not select a strategy: no metadata, no brief hint, and the coord agent declares multiple strategy skills"`.

---

## §B — DAG introspection patterns

Snippets below assume `$DAG` and `$WF` hold the JSON fetched per §A steps 2–3. Parent order is not significant; downstream classification keys on `(kind, agent, status)`.

### Find own parents

```
SELF=$OWN_NODE_ID
PARENT_IDS=$(jq -r --arg self "$SELF" \
  '.edges[] | select(.to == $self) | .from' <<<"$DAG")
```

### Classify a parent: (kind, status, agent, taskId)

For each parent id, pull the node from the DAG; for worker parents also pull the task record via `emploke task show`:

```
for PID in $PARENT_IDS; do
  NODE=$(jq --arg id "$PID" '.nodes[] | select(.id == $id)' <<<"$DAG")
  KIND=$(jq -r '.kind' <<<"$NODE")          # "worker" | "coordinator"
  STATUS=$(jq -r '.status' <<<"$NODE")      # "succeeded" | "failed" | "cancelled" | ...
  AGENT=$(jq -r '.spec.agent // empty' <<<"$NODE")
  TASK_ID=$(jq -r '.taskId // empty' <<<"$NODE")
done
```

The 4-tuple `(kind, status, agent, taskId)` is the case-bank classifier key. `agent` is empty for `kind: "coordinator"` nodes; `taskId` is empty until the node has been dispatched.

### Find prior-iter siblings (same agent, lower phase)

Nearest sibling with the same `spec.agent` and a lower `phase`:

```
PRIOR=$(jq -r --arg agent "$WORKER_AGENT" --argjson myPhase "$MY_PHASE" '
  [ .nodes[]
    | select(.spec.agent == $agent and .phase < $myPhase) ]
  | sort_by(.phase) | last // empty | .id' <<<"$DAG")
PRIOR_TASK_ID=$(jq -r --arg id "$PRIOR" \
  '.nodes[] | select(.id == $id) | .taskId' <<<"$DAG")
```

The strategy writes `${PRIOR_*_TASK_ID}` into the next worker's brief; the worker fetches the prior `verdict.json` itself via `emploke task show` (workers stay workflow-unaware — see §D).

### Batch-mutate the DAG atomically via add-subgraph

Use `emploke workflow add-subgraph` with `tempId` references so every node + edge in a fan-out lands in a single transaction. Specific contents are strategy-driven; the SHAPE is universal:

```jsonc
{
  "nodes": [
    { "tempId": "<role-a>", "kind": "worker", "parents": ["<self-node-id>"],
      "spec": { "agent": "<agent-fqn>", "brief": "<substituted template>", "details": null } },
    { "tempId": "<role-b>", "kind": "worker", "parents": ["<self-node-id>"],
      "spec": { "agent": "<agent-fqn>", "brief": "<substituted template>", "details": null } },
    { "tempId": "coord",    "kind": "coordinator", "parents": [],
      "spec": { "agent": "emploke/coordinator" } }
  ],
  "edges": [
    { "from": "<role-a>", "to": "coord" },
    { "from": "<role-b>", "to": "coord" }
  ]
}
```

The substrate resolves the `tempId`s within the transaction and returns the assigned node ids in `inserted[].nodeId`. Two universal rules: every fan-out MUST end in a `next-coord` whose parents are the newly-inserted workers (otherwise the branch dead-ends), and exactly one `add-subgraph` per wake-up (splitting a fan-out across two CLI calls leaves a half-formed DAG and may re-wake the wrong coord).

---

## §C — verdict.json schema (universal)

Reviewer workers (any worker whose output a coord parses to decide "continue or finish") write a `verdict.json` to their task workdir; every strategy that uses reviewer parents consumes it via this schema.

```
verdict.json schema:
  {
    "verdict":  "APPROVE" | "REQUEST_CHANGES",
    "findings": [
      { "id":       string,                              // unique within this verdict
        "severity": "blocker" | "major" | "minor",
        "summary":  string,                              // ≤200 chars, single line
        "detail":   string                               // free-form, any length
      }
    ]
  }
```

Parse rules for coord:

- `verdict == "APPROVE"` ⇒ findings MAY be `[]` OR contain only `"minor"` items
- `verdict == "REQUEST_CHANGES"` ⇒ findings MUST contain ≥1 `"blocker"` or `"major"`
- `findings[].id` must be unique within this verdict
- Missing severity on a finding ⇒ treat as `"major"` (conservative: do not silently skip)
- Treat missing `findings` array as `[]`
- On parse failure: `workflow finish --outcome failed --message "reviewer <agent> did not produce valid verdict.json"` and exit

Strategy skills SHOULD re-quote this schema verbatim inside their reviewer brief templates so the worker receives the schema in its brief and need not load this skill.

---

## §D — Brief plumbing meta-pattern

Treat workers as pure specialists: they MUST NOT depend on any workflow-specific skill or know they are inside a workflow. All workflow context reaches them via the task brief coord writes when dispatching them. Every worker brief a strategy template emits MUST follow this pattern:

- **Always include**: workflow id (so the worker can call `emploke workflow show --wfid $WF --json` itself), `workflow.brief` verbatim (no trim, no summary, no paraphrase), `workflow.details` verbatim (empty string if `null`), and concrete fetch instructions for any prior-iter outputs the worker needs (e.g. `emploke task show --tid ${PRIOR_<role>_TASK_ID}` then `<task-workdir>/verdict.json`). Workers do their own fetching; coord does not pre-digest.
- **Never include**: technical content (quality bars, fix suggestions, design opinions — workers own those domains), coord's interpretation of prior-iter findings (the worker reads the raw `verdict.json` itself), or hints about future coord wake-ups (workers are workflow-unaware).
- **Always inline the output protocol**: for reviewer workers, the §C `verdict.json` schema verbatim plus validation rules and the optional narrative-file convention. For implementer workers, the expected branch / PR convention the next coord wake-up relies on.
- **Use `${PLACEHOLDER}` substitution** for every per-dispatch slot. Coord fills slots via plain string replacement before writing the brief into `add-subgraph`. Substitution is total — a literal `${...}` in the dispatched brief is a bug. Unresolved placeholders (e.g. `${WORKFLOW_DETAILS}` when the creator passed nothing) substitute the empty string.

---

## §E — How to author a strategy skill

A strategy skill is a content-only sibling skill the coord agent loads alongside this one — providing the case bank, brief templates, and stop condition for one orchestration strategy. Multiple strategy skills coexist; the coord agent picks one per workflow per §A step 5.

### Required frontmatter

```yaml
---
name: <strategy-short-name>          # kebab-case, e.g. dev-review-loop
scope: emploke                       # or your catalog's scope
description: "<one short sentence describing what the strategy orchestrates>"
version: 1.0.0                       # 3-segment semver
---
```

Content-only: **no `dependencies:`** (the coord agent already declares the generic `emploke/coordinator` skill as a peer dep; adding deps here would shadow that scope), **no `prereqs:`** (the skill body is the entire contract — nothing to install).

### Required body sections (use these exact headings — the coord LLM and lint tooling key on them)

1. **Case bank** — enumerate every parent-classification case. Each case carries the matching predicate on `(kind, status, agent)` tuples of own direct parents (use the §B classifier) plus an action: `addSubgraph: <node list>` (with the new workers + briefs + a trailing `next-coord` per §B) or `finishWorkflow(<outcome>, "<message>")`. Fall-through is forbidden; every reachable parent combination must match exactly one case (see "Failure-mode coverage" below).
2. **Brief templates** — one verbatim text block per worker role the strategy dispatches. Each template MUST follow the §D meta-pattern: workflow context + prior-iter fetch instructions + output protocol + `${PLACEHOLDER}` slots. The case bank quotes templates by reference (e.g. `brief=<template-review>`); coord substitutes placeholders at runtime.
3. **Placeholder resolution table** — for every `${...}` slot used in any template, the source it resolves from (`workflow.id`, `workflow.brief`, a parent `taskId`, a DAG-derived counter, etc.). Coord reads this table to resolve the slot before dispatch.
4. **Stop condition** — the explicit predicate that triggers `finishWorkflow(succeeded, ...)`. Strategies without a clean terminal state MUST NOT exist in this catalog.
5. **Failure-mode coverage** — an explicit `(role, terminal status)` matrix mapping each cell to the case that catches it, so a future author editing the case bank can re-check coverage without re-deriving it.

### Optional body sections

- **Tempid wiring sketches** — concrete `add-subgraph` JSON payloads for the strategy's common fan-outs, useful for the LLM to anchor output shape.
- **Decision-log shape** — strategy-specific extensions to the generic `coord-decision.md` (e.g. iteration counter, blockers-and-majors count).

### Constraints

- Strategy skills MUST NOT redefine the `verdict.json` schema — point at §C (verbatim re-quoting inside a reviewer brief template is fine; introducing a different schema is forbidden).
- Strategy skills MUST NOT introduce strategy selection logic — that lives in §A. A strategy skill body assumes "I have been selected; here is what I do".
- Strategy skills MUST NOT compose technical content. Quality bars, fix opinions, and review heuristics live in worker agents; strategy briefs only plumb workflow context and the verdict schema.

---

## Decision log

Each wake-up writes a `coord-decision.md` to its task workdir capturing: which strategy was selected, which case matched, parent ids + statuses observed, verdicts parsed (if any), and the action taken (`add-subgraph` specifics or `finish` outcome + reason). This is the audit trail for post-mortems on the workflow. Strategy skills may extend the record with extra fields (iteration counter, blocker/major counts, etc.).
