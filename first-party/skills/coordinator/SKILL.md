---
name: coordinator
scope: emploke
description: "Workflow coordinator playbook — operating model, dev-review-loop strategy, brief templates, and verdict.json schema for the emploke/coordinator agent"
version: 1.0.0
---

# Emploke Coordinator Skill

You are inside a workflow coordinator agent (`emploke/coordinator`). This
skill is loaded fresh at every coord wake-up. Same agent + same skill =
identical behaviour at every coord node in the DAG; position-in-loop is
derived purely from DAG introspection — there is no hidden per-coord
state to carry between wake-ups.

This skill bundles four sections that together cover the entire coord
contract:

- §A — Operating model (the wake-up loop)
- §B — Strategies (v1: one strategy, `dev-review-loop`, with a case bank)
- §C — Brief templates (verbatim text coord writes into worker briefs)
- §D — `verdict.json` schema for coord's own parsing

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
4. Identify own direct parents:    edges where to == own node id
5. For each parent node:           read its kind + status + (if worker) taskId
6. Look up matching case in §B (strategies)
7. Execute the matching case (addSubgraph, finishWorkflow, etc.)
8. Log decision + reasoning to <task-workdir>/coord-decision.md
9. Exit (coord run terminates; substrate detects task terminal;
   next coord wake-up only happens when its own future parents complete)
```

Discipline:

- **One wake-up = one decision = one mutation.** Either `add-subgraph`
  (expand the DAG with a new dev or review fan-out) or `finish` (terminal).
  Coord never sits in a loop waiting for parents — that's the substrate's
  job. If parents aren't terminal yet, the substrate would not have
  dispatched this coord wake-up in the first place.
- **All identifiers come from the DAG snapshot.** Don't cache parent ids,
  task ids, or branch names between wake-ups; re-read every time. The
  DAG IS the state.
- **Compose worker briefs from §C verbatim.** Do not paraphrase the
  template bodies — workers receive them as their primary contract for
  what to do and (for reviewers) what output protocol to follow.

---

## §B — Strategies

For v1, ONE strategy: **dev-review-loop**. State machine, applied by
classifying own direct parents and matching one of five cases:

```
On wake-up, classify parents and act:

CASE "no parents" (I am the initial coord node):
  addSubgraph:
    dev (worker, agent=emploke/dev, brief=<dev brief template, see §C>)
       parents = [self]
    next-coord (coordinator, agent=emploke/coordinator)
       parents = [dev]
  exit

CASE "one parent, worker, agent=emploke/dev, status=succeeded":
  addSubgraph:
    review   (worker, agent=emploke/review,            brief=<review brief template, see §C>)
       parents = [self]
    designer (worker, agent=emploke/frontend-designer, brief=<designer brief template, see §C>)
       parents = [self]
    next-coord (coordinator, agent=emploke/coordinator)
       parents = [review, designer]
  exit

CASE "one parent, worker, agent=emploke/dev, status in (failed, cancelled)":
  finishWorkflow(failed, "dev iteration ended in {status}")
  exit

CASE "two parents, both worker, agents in {emploke/review, emploke/frontend-designer}":
  for each parent:
    fetch task:   emploke task show --tid <parent.taskId> --json
    fetch verdict: read <task-workdir>/verdict.json
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
      dev (worker, agent=emploke/dev, brief=<dev iter-2+ brief template, see §C>)
         parents = [self]
      next-coord (coordinator)
         parents = [dev]
  exit

CASE "two parents, both worker, any status in (failed, cancelled)":
  finishWorkflow(failed, "reviewer iteration ended in {status}; coord cannot decide without verdict")
  exit

(Future strategies — research-synthesis, data-pipeline, etc. — are added
as additional sibling sections under §B. Single skill grows linearly
with strategy count; if it becomes unwieldy, split each strategy into
its own skill and have coord agent declare them all as deps.)
```

**Strategy selection** (when §B contains >1 strategy): coord reads
`workflow.brief` and asks itself which case bank matches. For v1 with
only `dev-review-loop`, no selection step is needed — every coord
wake-up runs the same case classifier.

### Tempid wiring for `add-subgraph` payloads

Use the `add-subgraph` body's tempIds so the new dev / review / designer +
next-coord land in the DAG atomically. For example, the "one parent,
dev=succeeded" case sends a payload like:

```jsonc
{
  "nodes": [
    { "tempId": "review",   "kind": "worker", "parents": ["<self-node-id>"],
      "spec": { "agent": "emploke/review",            "brief": "<§C review template, substituted>",   "details": null } },
    { "tempId": "designer", "kind": "worker", "parents": ["<self-node-id>"],
      "spec": { "agent": "emploke/frontend-designer", "brief": "<§C designer template, substituted>", "details": null } },
    { "tempId": "coord",    "kind": "coordinator", "parents": [],
      "spec": { "agent": "emploke/coordinator" } }
  ],
  "edges": [
    { "from": "review",   "to": "coord" },
    { "from": "designer", "to": "coord" }
  ]
}
```

The substrate resolves the tempIds within the batch transaction and
returns the assigned node ids in `inserted[].nodeId`.

---

## §C — Brief templates

Verbatim text blocks coord writes into each dispatched worker's task
brief. Templates use `${WORKFLOW_ID}`, `${PRIOR_REVIEW_TASK_ID}`, etc.
as substitution placeholders — coord fills them with actual values at
dispatch time. **Do not paraphrase these templates** when substituting:
workers receive them as their primary contract.

### Template: dev iteration 1 (the initial dev call)

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

### Template: dev iteration 2+ (after a review round)

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

### Template: review (same every iteration)

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

### Template: designer (same every iteration)

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

### Placeholder resolution table

For each template, the placeholders coord fills at dispatch time:

| Placeholder | Source | Notes |
| --- | --- | --- |
| `${WORKFLOW_ID}` | `workflow.id` from `emploke workflow show` | string |
| `${WORKFLOW_BRIEF}` | `workflow.brief` | verbatim, no rewriting |
| `${WORKFLOW_DETAILS}` | `workflow.details` (may be `null` → emit empty string) | verbatim |
| `${ITERATION_NUMBER}` | count of dev worker nodes already in the DAG, +1 | integer, dev iter-2+ template only |
| `${PRIOR_REVIEW_TASK_ID}` | `taskId` of the most recent `agent=emploke/review` worker parent of the prior coord | string |
| `${PRIOR_DESIGNER_TASK_ID}` | `taskId` of the most recent `agent=emploke/frontend-designer` worker parent of the prior coord | string |
| `${BRANCH_NAME}` | branch the prior dev node pushed (derive from prior dev task's terminal result or its `<task-workdir>/branch.txt`) | string |

Substitution is plain string replacement. If a placeholder has no value
(e.g. `${WORKFLOW_DETAILS}` when the creator passed nothing), substitute
an empty string rather than leaving the literal `${…}` in the brief.

---

## §D — Verdict.json schema (for coord's own parsing)

The schema is documented in full at §C above (inside the review brief
template) so that worker agents receive the schema verbatim in their
brief. This subsection restates the rules for coord's own
verdict-parsing logic:

```
verdict.json schema:
  {
    "verdict":  "APPROVE" | "REQUEST_CHANGES",
    "findings": [
      { "id": string, "severity": "blocker"|"major"|"minor", "summary": string, "detail": string }
    ]
  }

Parse rules for coord:
- Open <task-workdir>/verdict.json
- JSON.parse — on parse failure: finishWorkflow(failed,
  "reviewer {agent} did not produce valid verdict.json")
- Validate against schema — on shape failure: same
- Treat missing findings array as []
- A verdict missing the "severity" field on any finding → treat as "major"
  (conservative: don't silently skip)
```

In code-shape pseudocode (the actual implementation is at the discretion
of the agent runtime; this is the contract):

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

---

## Decision log

Every wake-up writes a `coord-decision.md` to the coord task's workdir
documenting: which case matched, the parent ids + statuses inspected,
the verdicts parsed (if any), and the action taken (`add-subgraph` with
which children, or `finish` with which outcome and reason). This is the
audit trail for any post-mortem on the workflow.

Template:

```
# Coord decision — node ${OWN_NODE_ID} (wfid ${WORKFLOW_ID})

## Parents observed
- ${PARENT_ID}: kind=${kind} status=${status} agent=${agent} taskId=${taskId}
  …

## Verdicts read
- ${PARENT_ID} (${agent}): verdict=${verdict}, findings=${counts by severity}
  …

## Case matched
${case label from §B}

## Action taken
- add-subgraph: ${new node summary}
  OR
- finish: outcome=${outcome}, reason="${reason}"

## Reasoning
${one paragraph}
```

---

## What this skill is NOT

- **Not a CLI reference.** The `emploke/cli` skill (loaded alongside)
  carries the per-subcommand surface for `emploke workflow …`. Consult
  it for flag names, body schemas, and exit codes.
- **Not a worker brief authoring guide.** Workers receive briefs verbatim
  from §C templates; coord substitutes placeholders but does not
  rewrite or interpret the template body. Quality of worker output is
  the worker agent's responsibility, not coord's.
- **Not a substitute for the workflow substrate.** Coord makes one
  decision per wake-up and exits; the substrate handles dispatch,
  parent-readiness, and re-waking coord nodes when their parents land
  terminal. Don't try to "loop" inside a single coord wake-up.

---

## See also

- `emploke/cli` skill — flags, routes, and bodies for every `emploke
  workflow …` subcommand referenced here, plus the `--json` /
  workspace-scoping discipline this skill's pseudocode assumes.
- `emploke/coordinator` agent — the only agent that loads this skill
  (paired 1:1 with this content).
