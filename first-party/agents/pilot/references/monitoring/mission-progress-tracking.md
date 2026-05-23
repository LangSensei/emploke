# Mission progress tracking

Each mission has its own progress trail. You roll up multiple tasks into a single coherent narrative.

## Per-mission state files

Inside `.pilot/active-missions/<mission-id>/`:

- **`goal.md`** — the mission's "north star" (immutable after mission start; if you need to change it, that's a strategic pivot)
- **`plan.md`** — your decomposition into steps, with checkbox-style progress markers
- **`tasks.json`** — `{step_id: emploke_task_id}` mapping
- **`progress.md`** — append-only narrative: every meaningful event in the mission
- **`risks.md`** — identified risks + mitigation status (update as risks emerge or resolve)

## `plan.md` format

```markdown
# Plan

## Step 1: <short name>
- [x] <sub-step> (task <tid>, completed <date>)
- [x] <sub-step> (task <tid>, completed <date>)

## Step 2: <short name>
- [x] <sub-step> (task <tid>, completed <date>)
- [ ] <sub-step> ← in flight, task <tid>
- [ ] <sub-step>

## Step 3: <short name>
- [ ] <sub-step>
- [ ] <sub-step>
```

The `← in flight` marker tells you on resume / next tick where work is currently running. Check off boxes as task outcomes arrive.

## `progress.md` format

Append-only chronicle. Each entry is timestamped + one paragraph.

```markdown
# Progress

## 2026-05-13T10:00:00Z
Founded mission. Decomposed into 5 steps. Hired writer agent.

## 2026-05-13T10:30:00Z
Step 1 (research) dispatched to local/research-agent (task 20260513-abc123).

## 2026-05-13T11:45:00Z
Task 20260513-abc123 completed. Output: 12 sources synthesized into 800-word brief. Quality: good. Advancing to step 2.

## 2026-05-13T11:50:00Z
Step 2 (drafting) dispatched to local/writer (task 20260513-def456).

## 2026-05-13T13:00:00Z
Task 20260513-def456 completed. Draft is 2200 words; goal called for ~1500. Will dispatch step 2.5 (compression pass) before moving to step 3.
```

When in doubt about whether to log something, log it. Future-you reading this on resume needs the context.

## Reading mission state on resume

When you resume after a session restart:

```sh
for m in .pilot/active-missions/*/; do
  MID=$(basename "$m")
  echo "=== Mission $MID ==="
  jq -c '.' "$m/tasks.json"          # what's dispatched
  tail -20 "$m/progress.md"          # what happened recently
  grep '\[ \]' "$m/plan.md" | head -3 # what's next
done
```

Decide for each mission: **continue / re-plan / pause / abandon**. Append to `progress.md`:

```markdown
## YYYY-MM-DDTHH:MM:SSZ — RESUMED
On resume, reviewed state. Decision: <continue|re-plan|pause|abandon>.
Reasoning: <one paragraph>.
```

## Mission-level health metrics (optional but useful)

Periodically (e.g. every 24h or every 10 ticks), compute:

- **Velocity**: tasks completed in the last 24h
- **Failure rate**: failures / total in the last 7 days
- **Stuck rate**: stuck-task interventions / total dispatches
- **Time-to-step-completion**: avg wall time from dispatch to completion per step

Append to `progress.md`. If any metric is concerning (e.g. failure rate climbing, velocity dropping), surface in next user-facing report and consider a strategy review.

## When to surface mission status to the user

In the session terminal:

- Step completed (one-line: "Mission X step Y complete.")
- Step blocked / failed (full triage)
- Mission complete (deliverable + post-mortem summary)
- Mission abandoned (reason + post-mortem pointer)

In `.pilot/reports/`:

- Weekly all-hands (rituals/weekly-allhands.md)
- On-demand when the user asks "how are we doing"

Don't be noisy. Don't surface every task completion if the mission has many. Aggregate.
