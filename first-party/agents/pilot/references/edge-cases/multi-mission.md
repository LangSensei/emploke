# Multi-mission parallelism

Running more than one mission concurrently is allowed but requires discipline. This file covers when to run parallel, how to allocate attention, and when to serialize instead.

## When parallel is OK

- Missions are **independent** (no shared blockers, no overlapping deliverables)
- Missions have **different time horizons** (a long-running research mission + a short urgent task)
- The user has explicitly requested parallel work
- You have available capacity (no role is currently overloaded)

## When parallel is NOT OK

- Missions compete for the same scarce role (one writer, two missions both needing writing)
- Missions have hidden dependencies (mission B needs A's output to even start)
- The user is overwhelmed by status updates and asks you to focus
- Active mission count would exceed 3-5 (you'll lose coherence)

## Tracking parallel missions

Each mission gets its own subdirectory under `.pilot/active-missions/<id>/`. The naming convention `<YYYYMMDD>-<slug>` keeps them sortable.

In `org-chart.md`, you can annotate which roles are currently committed to which missions:

```markdown
| Domain | Role | Agent | Active mission(s) |
|---|---|---|---|
| research | analyst | langsensei/researcher | 20260520-saas, 20260525-survey |
| writing | writer | local/writer | 20260520-saas |
```

## Allocating attention per tick

Don't try to advance ALL active missions in every tick. Use a simple round-robin:

```sh
# Pick the mission whose progress.md was least recently updated
NEXT_MISSION=$(ls -t .pilot/active-missions/*/progress.md | tail -1 | xargs dirname)
```

This naturally rotates attention across missions and prevents one from starving others.

## Detecting cross-mission contention

If two missions both want the same role at the same time:

1. **Decide priority** — which mission's success criterion is more time-sensitive? Which has the more important deliverable?
2. **Serialize on the role** — finish mission A's task with the role first, THEN dispatch mission B's task to the same role. (Don't dispatch both simultaneously to the same agent.)
3. **Or: hire a second agent for the role** if contention is persistent. Two writers, one for each mission.
4. **Document the contention** in `decisions.log` so you can tell whether it's worth structural changes.

## Cross-mission learning

Lessons from mission A may help mission B. Periodically (e.g. weekly), do a cross-mission scan:

- Read each active mission's recent progress.md
- Look for patterns ("both missions hit issue X")
- Append to `lessons.md` with the cross-mission tag

If the pattern is significant, dispatch a one-off "cross-mission synthesis" task to a research agent: "Summarize what missions A and B have learned that's relevant to each other."

## When to drop a mission

If you find yourself unable to make progress on a mission because attention is going to others, EITHER:

- **Pause the mission**: append "[YYYY-MM-DD] PAUSED — re-attention this in <date>" to progress.md and `decisions.log`. Don't dispatch new work for it. Resume when capacity allows.
- **Abandon the mission**: write outcome.md ("abandoned: insufficient attention given competing priorities"), move to archived-missions/. Surface to user.

Don't keep a mission "active" but neglected. It's worse than declaring the truth.

## User communication for parallel missions

The weekly all-hands report should clearly show all active missions side by side:

```markdown
## Mission status
| Mission | Status | Pace | Next milestone |
|---|---|---|---|
| 20260520-saas-mvp-launch | step 4/7 in flight | on track | landing page draft (~3d) |
| 20260525-customer-survey | step 1/3 in flight | on track | first 50 responses (~7d) |
```

This makes priorities explicit. The user can say "drop the survey, focus on saas".

## Hard cap

Default: **at most 3 active missions** at any time. More than 3 and you can't keep meaningful context across all of them. If the user wants more, suggest sequencing instead.

This isn't a token cost issue (tokens are infinite for you); it's a coherence issue. You make better decisions when you have full context for fewer things.
