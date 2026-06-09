---
name: coordinator
scope: emploke
description: "Generic workflow-coordinator framework — operating model, DAG introspection patterns, verdict.json schema, brief-plumbing meta-pattern, and authoring guidance for strategy skills"
version: 1.0.0
---

# Emploke Coordinator Skill

You are inside a workflow coordinator agent (`emploke/coordinator`). This
skill is the **generic orchestration framework**: it tells you how a
coord wake-up is shaped, how to read the DAG, what schema the workers'
verdicts use, the meta-pattern you follow when writing worker briefs,
and what a sibling strategy skill must contain. It is loaded fresh at
every coord wake-up. Same agent + same skill = identical behaviour at
every coord node in the DAG; position-in-loop is derived purely from
DAG introspection — there is no hidden per-coord state to carry
between wake-ups.

**This skill is strategy-agnostic.** It does NOT contain any concrete
case bank, brief template, or stop condition. Those live in **strategy
skills** (sibling skills the coord agent also declares as deps), one per
strategy. For v1 the only strategy skill is `emploke/dev-review-loop`.
Future strategies (`emploke/research-synth`, `emploke/data-pipeline`,
etc.) ship as additional sibling skills — never by editing this skill.

Five sections that together cover the generic contract:

- §A — Operating model (the wake-up loop)
- §B — DAG introspection patterns (reusable snippets every strategy uses)
- §C — `verdict.json` schema (universal output protocol for reviewer workers)
- §D — Brief plumbing meta-pattern (how to write worker briefs)
- §E — How to author a strategy skill (the meta-guide for the next author)

CLI invocations referenced below (`emploke workflow show`, `dag`,
`node-show`, `add-subgraph`, `finish`, `task show`) are documented in the
`emploke/cli` skill, which the agent loads alongside this one. Consult
the `emploke/cli` skill's `references/workflow-commands.md` for the full
per-subcommand reference (flags, routes, response shapes).

---

## §A — Operating model

How a coord wake-up proceeds:

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

Discipline:

- **One wake-up = one decision = one mutation.** Either `add-subgraph`
  (expand the DAG with new worker / coord nodes per the matching case)
  or `finish` (terminal). Coord never sits in a loop waiting for
  parents — that's the substrate's job. If parents aren't terminal yet,
  the substrate would not have dispatched this coord wake-up in the
  first place.
- **All identifiers come from the DAG snapshot.** Don't cache parent ids,
  task ids, or branch names between wake-ups; re-read every time. The
  DAG IS the state.
- **The strategy skill owns the case bank.** Coord-the-agent loads BOTH
  this generic skill and the matching strategy skill, then matches
  parents against the strategy skill's case bank. This skill provides
  the universal scaffolding only; do not look for concrete cases here.

### Strategy selection details

Step 5 above resolves the strategy in priority order:

1. `workflow.metadata.strategy` — if the workflow creator set an explicit
   strategy FQN (e.g. `"emploke/dev-review-loop"`), use it.
2. `workflow.brief` — if the brief contains an explicit hint
   ("strategy: emploke/research-synth"), use it.
3. The only strategy declared in the coord agent's `dependencies.skills` —
   when there is exactly one strategy skill among the agent's deps,
   default to it. (For v1 with a single strategy this is the common
   path and steps 1–2 are typically empty.)

If none of the three sources yields a strategy, terminate the workflow
with `workflow finish --outcome failed --message "coord could not select
a strategy: no metadata, no brief hint, and the coord agent declares
multiple strategy skills"`.

---

## §B — DAG introspection patterns

Reusable snippets for the universal sub-tasks every strategy performs.
The pseudocode below assumes the DAG and workflow header have already
been fetched per §A steps 2–3 and bound to `$DAG` and `$WF` (JSON).

### Find own parents

```
SELF=$OWN_NODE_ID
PARENT_IDS=$(jq -r --arg self "$SELF" \
  '.edges[] | select(.to == $self) | .from' <<<"$DAG")
```

The parent set is the input to every case-match decision. Order is not
significant; downstream classification keys on `(kind, agent, status)`.

### Classify a parent: (kind, status, agent, taskId)

For each parent id, pull the node record from the DAG and (if it is a
worker) the task record via `emploke task show`:

```
for PID in $PARENT_IDS; do
  NODE=$(jq --arg id "$PID" '.nodes[] | select(.id == $id)' <<<"$DAG")
  KIND=$(jq -r '.kind' <<<"$NODE")          # "worker" | "coordinator"
  STATUS=$(jq -r '.status' <<<"$NODE")      # "succeeded" | "failed" | "cancelled" | ...
  AGENT=$(jq -r '.spec.agent // empty' <<<"$NODE")
  TASK_ID=$(jq -r '.taskId // empty' <<<"$NODE")
done
```

The 4-tuple `(kind, status, agent, taskId)` is the classifier key every
strategy case bank uses. `agent` is empty for `kind: "coordinator"`
nodes; `taskId` is empty until the node has been dispatched.

### Find prior-iter siblings (same agent, lower phase)

When a strategy needs to propagate context across iterations (e.g.
iteration N reads iteration N−1's output to confirm prior findings are
addressed), the canonical way to find the prior-iter sibling is: same
`spec.agent`, lower `phase` (or lower position in topological order),
nearest match.

```
PRIOR=$(jq -r --arg agent "$WORKER_AGENT" --argjson myPhase "$MY_PHASE" '
  [ .nodes[]
    | select(.spec.agent == $agent and .phase < $myPhase) ]
  | sort_by(.phase) | last // empty | .id' <<<"$DAG")
PRIOR_TASK_ID=$(jq -r --arg id "$PRIOR" \
  '.nodes[] | select(.id == $id) | .taskId' <<<"$DAG")
```

The strategy then writes `${PRIOR_*_TASK_ID}` into the next worker's
brief; the worker fetches the prior verdict.json itself via `emploke
task show` (workers stay workflow-unaware — see §D).

### Batch-mutate the DAG atomically via add-subgraph

Use `emploke workflow add-subgraph` with `tempId` references so every
node + edge in a fan-out lands in a single transaction. Example payload
shape (the specific contents are strategy-driven; the SHAPE is
universal):

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

The substrate resolves the `tempId`s within the transaction and returns
the assigned node ids in `inserted[].nodeId`. Two rules apply
universally:

1. **Every fan-out ends in a `next-coord` node** whose parents are the
   newly-inserted workers. Without a `next-coord`, the DAG branch dead-ends
   when the workers finish.
2. **One `add-subgraph` per wake-up.** Splitting a fan-out across two CLI
   calls means the substrate sees a half-formed DAG and could re-wake the
   wrong coord. Bundle the whole slice into one call.

---

## §C — verdict.json schema (universal)

Every reviewer-style worker (any worker whose output a coord needs to
parse to decide "continue or finish") writes a `verdict.json` to its task
workdir. The schema is part of this generic skill because every strategy
that uses reviewer parents consumes it the same way.

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

Pseudocode coord can adapt (actual implementation is at the agent
runtime's discretion; this is the contract):

```js
function parseVerdict(workdir, agentFqn) {
  const raw = readFile(`${workdir}/verdict.json`);
  let v;
  try { v = JSON.parse(raw); }
  catch (e) { finishWorkflow("failed", `reviewer ${agentFqn} did not produce valid verdict.json`); throw; }

  if (v.verdict !== "APPROVE" && v.verdict !== "REQUEST_CHANGES") {
    finishWorkflow("failed", `reviewer ${agentFqn} verdict.json has invalid verdict field`); throw;
  }
  const findings = Array.isArray(v.findings) ? v.findings : [];
  return {
    verdict: v.verdict,
    findings: findings.map((f) => ({
      id: f.id,
      severity: ["blocker", "major", "minor"].includes(f.severity) ? f.severity : "major",
      summary: f.summary,
      detail: f.detail,
    })),
  };
}
```

Strategy skills should reference this schema verbatim inside their
reviewer-role brief template (so the worker receives the schema in its
brief and need not load this skill).

---

## §D — Brief plumbing meta-pattern

Workers (implementer agents, reviewer agents, etc.) are pure specialists. They MUST NOT depend on any
workflow-specific skill or know they're running inside a workflow. All
workflow context is plumbed to them via the **task brief** coord writes
when dispatching them.

Every worker brief a strategy template emits MUST follow this pattern:

1. **Always include**:
   - The workflow id (so the worker can call `emploke workflow show
     --wfid $WF --json` if it needs further context).
   - The workflow brief, **verbatim** from `workflow.brief` — do not
     trim, summarize, or paraphrase.
   - The workflow details, verbatim from `workflow.details` (substitute
     empty string if `null`).
   - Where to fetch prior-iter outputs, expressed as concrete task ids
     the worker reads itself (e.g. "fetch the prior reviewer's verdict via
     `emploke task show --tid ${PRIOR_<role>_TASK_ID}` then read
     `<task-workdir>/verdict.json`" — the concrete slot name comes from the
     strategy skill's placeholder resolution table). Workers do their own
     fetching; coord does not pre-digest.

2. **Never include**:
   - Technical content (quality bars, fix suggestions, implementation
     guidance, design opinions). Workers own those domains.
   - Coord's own interpretation of prior-iter findings. The worker reads
     the raw verdict.json itself; coord MUST NOT pre-classify or
     prioritise findings for it.
   - Hints about what the next coord wake-up will do. Workers are
     workflow-unaware; the coord state machine is not their concern.

3. **Always inline the output protocol** the worker should follow:
   - For reviewer workers: the §C verdict.json schema, verbatim, plus
     the validation rules and the optional narrative file convention.
   - For implementer workers: the expected branch / PR convention,
     which the next coord wake-up will rely on.

4. **Use `${PLACEHOLDER}` substitution syntax** for every slot whose
   value is per-dispatch. Coord at runtime fills the slots via plain
   string replacement before writing the brief into the
   `add-subgraph` payload. Substitution is total — leaving a literal
   `${...}` in the dispatched brief is a bug. If a placeholder has no
   value (e.g. `${WORKFLOW_DETAILS}` when the creator passed nothing),
   substitute an empty string rather than the literal `${…}`.

This meta-pattern is universal across strategies. **Each strategy
skill provides the concrete templates** (the actual prose workers
receive) plus the placeholder-resolution table mapping each `${...}` to
its source (`workflow.brief`, parent `taskId`, DAG-derived counters,
etc.). See §E.

---

## §E — How to author a strategy skill

A strategy skill is a content-only sibling skill the coord agent loads
alongside this one. Its job: provide the case bank, brief templates, and
stop condition for one orchestration strategy. Multiple strategy skills
can coexist; the coord agent picks one per workflow per §A step 5.

### Required frontmatter

```yaml
---
name: <strategy-short-name>          # kebab-case, e.g. dev-review-loop
scope: emploke                       # or your catalog's scope
description: "<one short sentence describing what the strategy orchestrates>"
version: 1.0.0                       # 3-segment semver
---
```

Strategy skills are **content-only**:

- **No `dependencies:`** — they are loaded by the coord agent, which
  already declares the generic `emploke/coordinator` skill as a peer
  dep. Adding deps here would shadow that scope.
- **No `prereqs:`** — there is nothing to install or set up; the skill
  body is the entire contract.

### Required body sections

Every strategy skill MUST contain these sections (use these exact
headings or near-equivalents — the coord LLM and the lint tooling key
on them):

1. **Case bank** — enumerate every parent-classification case the
   strategy expects. For each case:
   - The matching predicate on `(kind, status, agent)` tuples of own
     direct parents (use the classifier from §B).
   - The action: either `addSubgraph: <node list>` (with the new
     workers + their briefs + the trailing `next-coord` per §B) OR
     `finishWorkflow(<outcome>, "<message>")`.
   Fall-through is forbidden — every reachable combination of parent
   `(kind, status, agent)` must match exactly one case. See "Failure-mode
   coverage" below.

2. **Brief templates** — one verbatim text block per worker role the
   strategy dispatches. Each template MUST follow the §D meta-pattern:
   workflow context + prior-iter fetch instructions + output protocol +
   `${PLACEHOLDER}` slots. Templates are quoted into the case bank by
   reference (e.g. `brief=<template-review>`); coord at runtime
   substitutes placeholders.

3. **Placeholder resolution table** — for each `${...}` slot used in any
   template, the source it resolves from. Example rows:

   | Placeholder | Source | Notes |
   | --- | --- | --- |
   | `${WORKFLOW_ID}` | `workflow.id` from `emploke workflow show` | string |
   | `${WORKFLOW_BRIEF}` | `workflow.brief` | verbatim |
   | `${ITERATION_NUMBER}` | count of relevant worker nodes in DAG + 1 | integer |

   Every placeholder appearing in any template MUST have a row. Coord
   reads this table to resolve the slot before dispatch.

4. **Stop condition** — the explicit predicate that triggers
   `finishWorkflow(succeeded, ...)`. Strategies that never succeed
   (forever-loops) MUST NOT exist in this catalog — every strategy
   needs a clean terminal state.

5. **Failure-mode coverage** — an explicit subsection that verifies every
   `failed` / `cancelled` terminal status on every parent role the
   strategy expects is covered by a case in the case bank. List the
   `(role, status)` matrix and the case that catches each cell. The
   verifier comment is part of the skill body so a future author
   editing the case bank can re-check coverage without re-deriving it.

### Optional body sections

- **Tempid wiring sketches** — concrete `add-subgraph` JSON payloads
  for the strategy's most common fan-outs, useful for the LLM to anchor
  its output shape. (Coord generates payloads from the case bank
  pseudocode; sketches are purely illustrative.)
- **Decision-log shape** — strategies may extend the generic
  `coord-decision.md` template with strategy-specific fields (e.g.
  iteration counter, blockers-and-majors count).

### Constraints

- **Strategy skills MUST NOT redefine the verdict.json schema** — they
  point at §C of the generic skill (verbatim re-quoting in a reviewer
  brief template is fine; introducing a different schema is forbidden).
- **Strategy skills MUST NOT introduce strategy selection logic** — that
  lives in §A of this skill. A strategy skill's body assumes "I have
  been selected; here is what I do".
- **Strategy skills MUST NOT compose technical content.** Quality bars,
  fix opinions, and review heuristics live in worker agents — strategy
  briefs only plumb workflow context and the verdict schema.

---

## Decision log

Every wake-up writes a `coord-decision.md` to the coord task's workdir
documenting: which strategy was selected, which case matched, the parent
ids + statuses inspected, the verdicts parsed (if any), and the action
taken (`add-subgraph` with which children, or `finish` with which
outcome and reason). This is the audit trail for any post-mortem on the
workflow.

Template (strategy skills may extend with extra fields):

```
# Coord decision — node ${OWN_NODE_ID} (wfid ${WORKFLOW_ID})

## Strategy selected
${STRATEGY_FQN}  (source: workflow.metadata | brief hint | sole agent dep)

## Parents observed
- ${PARENT_ID}: kind=${kind} status=${status} agent=${agent} taskId=${taskId}
  …

## Verdicts read
- ${PARENT_ID} (${agent}): verdict=${verdict}, findings=${counts by severity}
  …

## Case matched
${case label from the strategy skill's case bank}

## Action taken
- add-subgraph: ${new node summary}
  OR
- finish: outcome=${outcome}, reason="${reason}"

## Reasoning
${one paragraph}
```

---

## What this skill is NOT

- **Not a strategy.** This skill defines the framework. The matching
  strategy skill (e.g. `emploke/dev-review-loop`) defines the case
  bank and brief templates the framework dispatches.
- **Not a CLI reference.** The `emploke/cli` skill (loaded alongside)
  carries the per-subcommand surface for `emploke workflow …`. Consult
  it for flag names, body schemas, and exit codes.
- **Not a substitute for the workflow substrate.** Coord makes one
  decision per wake-up and exits; the substrate handles dispatch,
  parent-readiness, and re-waking coord nodes when their parents land
  terminal. Don't try to "loop" inside a single coord wake-up.

---

## See also

- `emploke/cli` skill — flags, routes, and bodies for every `emploke
  workflow …` subcommand referenced here, plus the `--json` /
  workspace-scoping discipline this skill's pseudocode assumes.
- `emploke/dev-review-loop` skill — the v1 strategy skill (case bank,
  brief templates, placeholder table, stop condition, failure-mode
  coverage for the dev → review+designer iterate-to-clean strategy).
- `emploke/coordinator` agent — loads this skill and one strategy skill
  on every wake-up.
