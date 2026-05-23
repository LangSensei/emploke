# Emergency mode

A mission is going off the rails. Multiple steps have failed, the deliverable is in jeopardy, or an external event (user feedback, environmental change) has invalidated the plan. Emergency mode is for triage + rescue.

## Triggers

- 2+ consecutive task failures on the same mission
- A mission's `risks.md` has a HIGH-severity risk that has materialized
- The user has signaled urgency ("we need to course-correct")
- Mission velocity has dropped to ~zero for multiple ticks

## Activating emergency mode

When triggered:

1. **Stop dispatching new work** for non-emergency missions. (You don't pause them, just don't push them forward.)
2. **Append `EMERGENCY` to `decisions.log`** with the trigger reason.
3. **Notify the user** in the session terminal:
   ```
   EMERGENCY MODE: mission <id>
   Trigger: <one-line reason>
   Pausing other mission work to focus here.
   ```
4. **Spend the next 1-3 ticks in deep triage** of the failing mission.

## Triage process

```
1. Re-read goal.md — is the original goal still right?
2. Read progress.md from the start — what was the cumulative trajectory?
3. Read all post-mortems related to this mission — what's the failure pattern?
4. Read recent task activity (failures + last successes) — what changed?
5. Identify root causes. Use 5-whys discipline.
6. Generate options:
   a. Continue with adjusted plan (small fix)
   b. Restart mission with revised approach (medium fix)
   c. Reduce scope and accept partial deliverable (compromise)
   d. Abandon mission entirely (declare failure)
7. Surface options to user with your recommendation. Get explicit choice.
```

Don't unilaterally pick option (a)-(c) for a mission you've declared emergency on. The user owns the decision.

## During emergency

- **Tick frequency increases** — check on the mission every few minutes (not every hour)
- **No idle reflection** — every tick processes mission work, not playbook distillation
- **No org evolution** — emergency is not the time to restructure the company
- **Other missions continue running but don't advance** — in-flight tasks complete normally; new dispatches are paused

## Exiting emergency mode

Exit when:

- The mission has been recovered (back to making forward progress) AND no new failures in the last 3 ticks
- OR the user has confirmed an option (b/c/d) and the mission has been re-planned / reduced / archived

On exit:

```
EMERGENCY RESOLVED: mission <id>
Resolution: <one-line outcome>
Resuming normal operations.
```

Append to `decisions.log` and resume normal tick cadence.

## Post-emergency

Always write a post-mortem (`post-mortems/<mission-id>.md`) for the emergency, even if the mission ultimately succeeded. Emergency mode itself is information about how the company handles stress.

Extract emergency-specific lessons:
- Did our risk identification (`risks.md`) catch this?
- Did our monitoring catch the slide before it became critical?
- Did our org have the right roles to respond?

Add to `lessons.md` under a separate section:

```markdown
## Emergency learnings (cumulative)
- 2026-05-30: research-agent failures cascaded because we had no peer to cross-check. Added "always have 2 candidates for critical roles" to lesson.
- ...
```

## What NOT to do in emergency mode

- **Don't panic-fire agents.** Underperformance is a separate question; resolve the emergency first.
- **Don't unilaterally pivot strategy.** Strategy changes need user approval, even (especially) under stress.
- **Don't blanket-cancel tasks.** Each cancellation is a decision; review individually.
- **Don't go silent.** The user needs visibility into what you're doing during a crisis. Send a status update in the terminal at least once per emergency tick.
