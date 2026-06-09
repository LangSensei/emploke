---
name: dev-review-loop
scope: emploke
description: "Strategy skill for emploke/coordinator — the dev → review+designer iterate-to-clean orchestration: case bank, brief templates, placeholder resolution, stop condition, failure-mode coverage"
version: 1.0.0
---

# Emploke Development-Loop Strategy Skill

Strategy: dispatch a single `emploke/dev` worker; on success, fan out to parallel `emploke/review` + `emploke/frontend-designer` reviewers; finish succeeded if both verdicts come back clean (APPROVE with at most minor findings), else dispatch the next `emploke/dev` iteration with prior verdicts available, and loop. Loaded by the `emploke/coordinator` agent alongside the generic `emploke/coordinator` skill at every coord wake-up.

---

## Case bank

Match own direct parents against these cases — exactly one matches per wake-up (the case bank is total over expected shapes; see "Failure-mode coverage"). Unexpected shapes (3 parents, an unknown agent FQN, etc.) are bugs in workflow construction; terminate with `workflow finish --outcome failed --message "coord saw unexpected DAG shape under emploke/dev-review-loop: <describe>"`.

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

Use the §B "Batch-mutate the DAG atomically" `add-subgraph` payload shape from the generic skill; substitute `<self-node-id>` with the actual id from the DAG snapshot.

---

## Brief templates

Coord at dispatch time substitutes `${PLACEHOLDER}` slots per the resolution table below; do not paraphrase template prose — workers receive these as their primary contract.

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

Plain string replacement; placeholders with no value (e.g. `${WORKFLOW_DETAILS}` when the creator passed nothing) substitute the empty string rather than leaving the literal `${...}` in the dispatched brief.

| Placeholder | Source | Notes |
| --- | --- | --- |
| `${WORKFLOW_ID}` | `workflow.id` from `emploke workflow show` | string |
| `${WORKFLOW_BRIEF}` | `workflow.brief` | verbatim, no rewriting |
| `${WORKFLOW_DETAILS}` | `workflow.details` (may be `null` → emit empty string) | verbatim |
| `${ITERATION_NUMBER}` | count of `emploke/dev` worker nodes already in the DAG, +1 | integer; `template-dev-iter-2-plus` only |
| `${PRIOR_REVIEW_TASK_ID}` | `taskId` of the most recent `agent=emploke/review` worker parent of the prior coord | string; `template-dev-iter-2-plus` only |
| `${PRIOR_DESIGNER_TASK_ID}` | `taskId` of the most recent `agent=emploke/frontend-designer` worker parent of the prior coord | string; `template-dev-iter-2-plus` only |
| `${BRANCH_NAME}` | branch the prior dev node pushed (derive from prior dev task's terminal result or its `<task-workdir>/branch.txt`) | string; `template-dev-iter-2-plus` only |

`${PRIOR_*_TASK_ID}` lookups use the "Find prior-iter siblings" snippet from the generic skill §B (same agent FQN, lower phase).

---

## Stop condition

Trigger `finishWorkflow(succeeded, ...)` in the "two parents, both reviewers" case when both verdicts parse cleanly per §C and the union of findings filtered to `severity in ('blocker', 'major')` is empty. The success `summary` records `iterations` (count of `emploke/dev` nodes in the final DAG) and `minor_findings_remaining` (visibility — the work ships with them outstanding). No iteration cap in v1; an iteration cap is deferred per `coord-design.md` §7 and will land as a sibling case in the case bank when added.

---

## Failure-mode coverage

Every `(parent role, parent terminal status)` cell on every expected parent role matches exactly one case in the case bank — verify here when editing.

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
