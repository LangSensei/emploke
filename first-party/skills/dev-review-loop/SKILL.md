---
name: dev-review-loop
scope: emploke
description: "Strategy skill for emploke/coordinator — the dev → review+designer iterate-to-clean orchestration: case bank, brief templates, placeholder resolution, stop condition, failure-mode coverage"
version: 1.0.0
---

# Emploke Development-Loop Strategy Skill

A **strategy skill** for the `emploke/coordinator` agent. Encodes the
`dev → review + frontend-designer → iterate until clean` orchestration
strategy as a case bank + brief templates + placeholder table + stop
condition + failure-mode coverage matrix.

This skill is **content-only** (no `dependencies:`, no `prereqs:`) per
the meta-pattern in the `emploke/coordinator` skill §E. It is loaded by
the coord agent alongside the generic `emploke/coordinator` skill at
every coord wake-up. The generic skill provides §A operating model, §B
DAG introspection patterns, §C verdict.json schema, and §D brief
plumbing meta-pattern; this skill provides everything strategy-specific.

What this strategy does, in one sentence: dispatch a single `emploke/dev`
worker; once it succeeds, fan out to parallel `emploke/review` +
`emploke/frontend-designer` reviewers; if both verdicts come back clean
(APPROVE with only minor findings), finish the workflow succeeded;
otherwise dispatch the next `emploke/dev` iteration with the prior-iter
verdicts available to it for context, and loop.

---

## Case bank

Match own direct parents against these cases. Exactly one case matches
per coord wake-up — the case bank is total over the strategy's expected
parent shapes (see "Failure-mode coverage" below). If none match,
terminate the workflow with `workflow finish --outcome failed --message
"coord saw unexpected DAG shape under emploke/dev-review-loop: <describe>"`.

```
CASE "no parents" (initial coord node):
  addSubgraph:
    dev (worker, agent=emploke/dev, brief=<template-dev-iter-1>)
       parents = [self]
    next-coord (coordinator, agent=emploke/coordinator)
       parents = [dev]
  exit

CASE "one parent, worker, agent=emploke/dev, status=succeeded":
  addSubgraph:
    review   (worker, agent=emploke/review,            brief=<template-review>)
       parents = [self]
    designer (worker, agent=emploke/frontend-designer, brief=<template-designer>)
       parents = [self]
    next-coord (coordinator, agent=emploke/coordinator)
       parents = [review, designer]
  exit

CASE "one parent, worker, agent=emploke/dev, status in (failed, cancelled)":
  finishWorkflow(failed, "dev iteration ended in {status}")
  exit

CASE "two parents, both worker, agents in {emploke/review, emploke/frontend-designer}":
  for each parent:
    fetch task:    emploke task show --tid <parent.taskId> --json
    fetch verdict: read <task-workdir>/verdict.json (parse per §C of generic skill)
  blockers_and_majors = [
    f for v in verdicts for f in v.findings if f.severity in ('blocker', 'major')
  ]
  if blockers_and_majors is empty:
    finishWorkflow(succeeded, summary={
      "iterations": <count of dev nodes in DAG>,
      "minor_findings_remaining": <count if any>
    })
  else:
    addSubgraph:
      dev (worker, agent=emploke/dev, brief=<template-dev-iter-2-plus>)
         parents = [self]
      next-coord (coordinator)
         parents = [dev]
  exit

CASE "two parents, both worker, any status in (failed, cancelled)":
  finishWorkflow(failed, "reviewer iteration ended in {status}; coord cannot decide without verdict")
  exit
```

### Tempid wiring for `add-subgraph` payloads

Use the generic skill §B "Batch-mutate the DAG atomically" pattern.
Example: the "one parent, dev=succeeded" case emits this payload shape:

```jsonc
{
  "nodes": [
    { "tempId": "review",   "kind": "worker", "parents": ["<self-node-id>"],
      "spec": { "agent": "emploke/review",            "brief": "<template-review, substituted>",   "details": null } },
    { "tempId": "designer", "kind": "worker", "parents": ["<self-node-id>"],
      "spec": { "agent": "emploke/frontend-designer", "brief": "<template-designer, substituted>", "details": null } },
    { "tempId": "coord",    "kind": "coordinator", "parents": [],
      "spec": { "agent": "emploke/coordinator" } }
  ],
  "edges": [
    { "from": "review",   "to": "coord" },
    { "from": "designer", "to": "coord" }
  ]
}
```

The substrate resolves the `tempId`s within the batch transaction and
returns the assigned node ids in `inserted[].nodeId`.

---

## Brief templates

Verbatim text blocks the coord agent writes into each dispatched
worker's task brief. Templates use `${PLACEHOLDER}` substitution per the
generic skill §D meta-pattern: workflow id + verbatim brief +
prior-iter fetch instructions + output protocol. **Do not paraphrase
these templates** when substituting — workers receive them as their
primary contract.

### Template: template-dev-iter-1 (the initial dev call)

```
Implement the feature per the workflow brief.

# Workflow context
- Workflow id: ${WORKFLOW_ID}
- Workflow brief (verbatim from creator):
  ${WORKFLOW_BRIEF}
- Workflow details (verbatim from creator):
  ${WORKFLOW_DETAILS}

# Output expectations
Follow your normal dev workflow (branch, PR, etc.). The coord will pick
up your PR via the workflow DAG; no special output protocol on your end.
```

### Template: template-dev-iter-2-plus (after a review round)

```
Re-implement the feature for iteration ${ITERATION_NUMBER}.

# Workflow context
- Workflow id: ${WORKFLOW_ID}
- Workflow brief (verbatim):
  ${WORKFLOW_BRIEF}
- Workflow details (verbatim):
  ${WORKFLOW_DETAILS}

# Prior iteration outputs (you must fetch these yourself)
- Prior review verdict + narrative:
    emploke task show --tid ${PRIOR_REVIEW_TASK_ID} --json
    then read <task-workdir>/verdict.json and <task-workdir>/review.md
- Prior designer verdict + narrative:
    emploke task show --tid ${PRIOR_DESIGNER_TASK_ID} --json
    then read <task-workdir>/verdict.json and <task-workdir>/review.md

# What to do
Address every finding marked severity=blocker or major. Apply your own
judgment on severity=minor findings — fix what you'd fix as a
professional.

Keep working on branch ${BRANCH_NAME} (already-pushed prior iteration
commits are visible; rebase / amend as you see fit).
```

### Template: template-review (same every iteration)

```
Review the latest dev iteration in this workflow.

# Workflow context
- Workflow id: ${WORKFLOW_ID}
- Workflow brief (verbatim):
  ${WORKFLOW_BRIEF}

# What to review
The dev node immediately preceding you in the workflow DAG. Find it via:
  emploke workflow dag --wfid ${WORKFLOW_ID} --json
The dev node is your direct parent. Read dev's task via its taskId, see
what changed, apply your normal review standards.

If this is review iteration 2 or later, fetch the prior review node
(same agent as you, lower phase in the DAG) — read its verdict.json
to confirm previously-flagged findings are now addressed.

# Required output protocol
Write to <task-workdir>/verdict.json:
{
  "verdict":  "APPROVE" | "REQUEST_CHANGES",
  "findings": [
    {
      "id":       "F1",                                       // unique within this verdict
      "severity": "blocker" | "major" | "minor",
      "summary":  "<≤200 chars, single line>",
      "detail":   "<free-form, any length>"
    }
  ]
}

Validation rules:
- verdict == "APPROVE"           ⇒ findings MAY be [] OR contain only "minor" items
- verdict == "REQUEST_CHANGES"   ⇒ findings MUST contain ≥1 "blocker" or "major"
- findings[].id must be unique within this verdict

Coord decision rule (so you understand the impact):
- All verdicts APPROVE with only minor findings → workflow finishes succeeded
- Any blocker/major → next dev iteration dispatched, current findings 
  propagated to next dev brief (it will read your verdict.json itself)

Optionally write <task-workdir>/review.md for free-form narrative. The
next dev iteration will read it for context if produced.
```

### Template: template-designer (same every iteration)

```
Review the latest dev iteration's UI / UX in this workflow.

# Workflow context
- Workflow id: ${WORKFLOW_ID}
- Workflow brief (verbatim):
  ${WORKFLOW_BRIEF}

# What to review
The dev node immediately preceding you in the workflow DAG. Find it via:
  emploke workflow dag --wfid ${WORKFLOW_ID} --json
Apply your normal frontend / design review standards.

If this is designer iteration 2 or later, fetch the prior designer node
(same agent as you, lower phase) and confirm previously-flagged findings 
are resolved.

# Required output protocol
Identical to review's protocol (verdict.json + optional review.md).
See template-review-brief above for the schema and validation rules.
```

---

## Placeholder resolution table

For each `${...}` slot used in any template above, the source coord
resolves it from at dispatch time. Substitution is plain string
replacement. If a placeholder has no value (e.g. `${WORKFLOW_DETAILS}`
when the creator passed nothing), substitute an empty string rather
than leaving the literal `${…}` in the brief.

| Placeholder | Source | Notes |
| --- | --- | --- |
| `${WORKFLOW_ID}` | `workflow.id` from `emploke workflow show` | string |
| `${WORKFLOW_BRIEF}` | `workflow.brief` | verbatim, no rewriting |
| `${WORKFLOW_DETAILS}` | `workflow.details` (may be `null` → emit empty string) | verbatim |
| `${ITERATION_NUMBER}` | count of `emploke/dev` worker nodes already in the DAG, +1 | integer; `template-dev-iter-2-plus` only |
| `${PRIOR_REVIEW_TASK_ID}` | `taskId` of the most recent `agent=emploke/review` worker parent of the prior coord | string; `template-dev-iter-2-plus` only |
| `${PRIOR_DESIGNER_TASK_ID}` | `taskId` of the most recent `agent=emploke/frontend-designer` worker parent of the prior coord | string; `template-dev-iter-2-plus` only |
| `${BRANCH_NAME}` | branch the prior dev node pushed (derive from prior dev task's terminal result or its `<task-workdir>/branch.txt`) | string; `template-dev-iter-2-plus` only |

The `${PRIOR_*_TASK_ID}` lookups use the "Find prior-iter siblings"
snippet from the generic skill §B (same agent FQN, lower phase).

---

## Stop condition

`finishWorkflow(succeeded, ...)` is triggered when:

- Coord is in the "two parents, both reviewers" case, AND
- Both verdicts parsed cleanly per §C of the generic skill, AND
- `blockers_and_majors` (the union of findings across both verdicts
  filtered to `severity in ('blocker', 'major')`) is empty.

Equivalently: every reviewer verdict is `APPROVE`, with at most `minor`
findings remaining. The `summary` payload of the finish call records
`iterations` (count of `emploke/dev` nodes in the final DAG) and
`minor_findings_remaining` (count, for visibility — the work is shipped
with them outstanding).

There is no iteration cap in v1: as long as reviewers keep returning
`REQUEST_CHANGES` with blockers/majors and dev keeps succeeding,
the loop continues. (An iteration cap is a deferred concern per
`coord-design.md` §7; when added it will be a sibling case in the case
bank, not a hidden timer.)

---

## Failure-mode coverage

Every `(parent role, parent terminal status)` combination the strategy
expects MUST match exactly one case in the case bank. Verifying that
matrix here so a future author editing the case bank can re-check
coverage without re-deriving it:

| Coord wake-up shape | Parent role | Parent status | Matched case | Action |
| --- | --- | --- | --- | --- |
| 0 parents (initial coord node) | — | — | "no parents" | addSubgraph dev + next-coord |
| 1 parent | `emploke/dev` worker | `succeeded` | "one parent, dev, succeeded" | addSubgraph review + designer + next-coord |
| 1 parent | `emploke/dev` worker | `failed` | "one parent, dev, failed/cancelled" | finish(failed, "dev iteration ended in failed") |
| 1 parent | `emploke/dev` worker | `cancelled` | "one parent, dev, failed/cancelled" | finish(failed, "dev iteration ended in cancelled") |
| 2 parents | both reviewers (review + designer) | both `succeeded` AND `verdict.json` parseable | "two parents, both reviewers" | finish(succeeded) OR addSubgraph next dev iter, per blockers/majors count |
| 2 parents | reviewer | `failed` | "two parents, any failed/cancelled" | finish(failed, "reviewer iteration ended in failed") |
| 2 parents | reviewer | `cancelled` | "two parents, any failed/cancelled" | finish(failed, "reviewer iteration ended in cancelled") |
| 2 parents | reviewer | `succeeded` but `verdict.json` missing / unparseable | "two parents, both reviewers" → §C parse failure | finish(failed, "reviewer <agent> did not produce valid verdict.json") |

No fall-through cells remain. Every terminal status on every expected
parent role is caught either by the case bank or by §C's verdict.json
parse rules (which themselves terminate the workflow with a diagnosable
failure message).

Unexpected shapes (e.g. 3 parents, or a parent whose agent is none of
the three the strategy uses) are not covered by the case bank by
design — those are bugs in the workflow's construction, and the coord
should `workflow finish --outcome failed --message "coord saw
unexpected DAG shape under emploke/dev-review-loop: <describe>"` per
the case-bank preamble.

---

## See also

- `emploke/coordinator` skill — generic framework (operating model,
  DAG patterns, verdict schema, brief plumbing pattern, strategy
  authoring guide). This strategy skill plugs into §A of that skill.
- `emploke/cli` skill — `emploke workflow …` subcommand reference.
- `emploke/coordinator` agent — the agent that loads both the generic
  skill and this strategy skill at every wake-up.
