# Communicating with subagents (via task brief)

Your only channel to subagents is the `--brief` (and optional `--details` / `--details-file`) you pass to `emploke task dispatch`. The agent receives this as their input. They cannot see your reasoning, your other tasks, or the workspace state — only the brief text (plus details, if you supplied any).

## Anatomy of a good task brief

```
Goal: <one sentence describing the desired outcome>

Context:
<just enough background for the agent to do the work — no more>

Inputs:
<concrete data the agent needs (paste it inline OR reference files in the workspace)>

Output format:
<exactly what shape you want back — be strict>

Constraints:
- <hard rule 1>
- <hard rule 2>

Success criteria (how I'll evaluate this):
- <criterion 1>
- <criterion 2>
```

## Examples

### Bad: vague

```
"Write a report about the Q2 results."
```

The agent will produce something, but you can't evaluate it because you didn't tell them what "report" means.

### Good: specific

```
Goal: produce a Q2 financial summary report for the user.

Context:
This is for a non-technical executive audience. They want to know
how the quarter went vs targets, not the raw numbers.

Inputs (paste into your output's "data" section):
<paste the Q2 numbers here as a table>

Output format:
Markdown with these sections:
  ## Executive summary (1 paragraph, 80-120 words)
  ## Vs target
  ## What worked
  ## What underperformed
  ## Recommendation for Q3 focus

Constraints:
- NEVER include raw numerical noise (round to 2 sig figs)
- NEVER speculate beyond what the data shows
- ALWAYS attribute claims to a specific data point

Success criteria:
- Length: 400-600 words total
- All 5 sections present
- Every claim is traceable to the input data
```

## Style discipline

- **Explicit > implicit.** Don't assume the agent knows your conventions. If you want bullet lists, say "bulleted list, one per line".
- **Format spec near top.** The agent reads top-down; output format influences everything.
- **Constraints stated as NEVER / ALWAYS, not as suggestions.** "Try to avoid X" is weaker than "NEVER X". Pick the strength that matches the actual rule.
- **No filler.** "Please" and "thanks" don't change behavior. Skip them.
- **Reference don't reproduce** when inputs are large. "Read the file <path>" is fine if the agent has shell access (most do). Paste inline only for small inputs.

## When to refer to workspace artifacts

If the agent needs to read a file in the workspace:

```
Inputs:
Read the file <workspace>/data/q2-numbers.csv. Treat it as the
authoritative input.
```

The agent's runtime has access to the workspace's filesystem (via shell). This is more efficient than pasting CSVs into the brief or details.

## Output expectations

State precisely what you want back. Common shapes:

- **JSON** for structured data: `Output as JSON: { field1, field2, ... }. No markdown.`
- **Markdown report** for narratives: `Output as markdown with sections: A / B / C.`
- **NDJSON** for lists: `Output as NDJSON, one record per line.`
- **Diff/patch** for code changes: `Output as a unified diff suitable for git apply.`

If you don't specify, you'll get a free-form response that's harder to consume.

## After dispatch

Read the agent's output via `emploke task activity <tid> --json | jq '.result'`. Evaluate against your success criteria. If the output diverges:

1. Was it a brief-quality issue (your brief was ambiguous)? Refine and re-dispatch.
2. Was it an agent-capability issue (brief was clear, agent couldn't follow)? Switch agents or update the agent's body.

## Don't

- **Don't tell the agent who they are.** "You are a financial analyst" doesn't help. The role is set by their AGENTS.md.
- **Don't dispatch open-ended exploration when you mean a specific task.** "Look into X" gets you nothing usable. State the question and the desired output.
- **Don't include other tasks' context.** Each dispatch is independent. The agent doesn't know about your other tasks unless you tell them.
- **Don't reveal the .pilot/ machinery.** Subagents don't need to know they're working for a pilot; they just need to do the work.
