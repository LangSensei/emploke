# Post-mortem template

Write one of these in `.pilot/post-mortems/<mission-id>.md` whenever a mission fails or has a notable setback. Brief but structured.

## Template

```markdown
# Post-mortem: <mission-id>

## Outcome
<one sentence: failed / completed-with-degradation / succeeded-with-near-misses>

## What we tried to do
<one paragraph from goal.md, refreshed with the actual scope at the time>

## What happened
<chronological summary, 3-10 bullet points, drawn from progress.md>

## Why it went wrong (or nearly went wrong)
<2-5 root causes; for each, separate "what" from "why">

Root cause 1: <what>
  Why: <why this happened — go one level deeper than the surface symptom>

Root cause 2: <what>
  Why: <why>

...

## What we'd do differently
<bullets — concrete, actionable changes>

## Lessons (extracted to .pilot/lessons.md)
<one-line statements suitable for the lessons file; copy these verbatim into lessons.md too>

## Agents involved
- <fqn>: <how they performed; reference hires.md entry>
- ...

## Files / artifacts
- <pointer to relevant logs, outputs, decisions>
```

## When to write

- Mission failed (couldn't complete the goal)
- Mission completed but with notable setbacks (one or more steps required intervention)
- Single task failure that's representative of a broader pattern (don't write for every routine failure)

## When NOT to write

- Routine task failure that you handled with a one-time retry. The retry's outcome goes in `progress.md`; no post-mortem needed.
- Mission abandoned for external reasons (user cancelled, scope changed). Document in `outcome.md` instead.

## Quality bar

Good post-mortem:
- Identifies multiple root causes (singular root cause is rare)
- Each "why" goes one level deeper than the surface
- "What we'd do differently" is concrete enough that you'd actually do it
- Lessons are extracted to `lessons.md` (otherwise the post-mortem is solo-knowledge that dies)

Bad post-mortem:
- Blames "the agent was bad" without saying why or what to do about it
- Repeats the symptom as the cause ("the task failed because the task failed")
- Lessons section is "be more careful next time" (no actionable shape)

## Anti-patterns

- **Don't blame the agent.** They follow instructions. If the instructions were ambiguous, that's your fault.
- **Don't blame the user.** Even if the goal was unclear, your job was to clarify before starting. Surface that as a lesson about onboarding rigor.
- **Don't apologize.** Post-mortems are diagnostic, not penitential.
- **Don't propose fixes the company can't actually implement.** "We need a better LLM" is true but not actionable.

## After writing

1. Append a one-line summary to `decisions.log`:
   ```
   YYYY-MM-DDTHH:MM:SSZ | POSTMORTEM | <mission-id> | <one-line takeaway>
   ```
2. Copy the lessons section into `.pilot/lessons.md` under the current month heading.
3. If the post-mortem implies a hires.md update (agent was at fault, role was misdesigned), make that update too.
4. If the post-mortem implies a strategy.md change, surface it to the user — you don't change strategy unilaterally.
