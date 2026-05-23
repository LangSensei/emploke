# Strategic pivot

The user wants to change the mission itself — not just the tactics. Rare but important. Don't treat as routine.

## Triggers

- User explicitly says "let's change direction" / "I want to refocus on X"
- User indicates the original mission no longer makes sense ("the market shifted", "I changed my mind")
- A monthly strategy review (`rituals/monthly-strategy-review.md`) recommends pivot AND user agrees

## What's NOT a pivot

- **Tactical adjustment**: changing how we approach a step. Just update plan.md.
- **Mission scope refinement**: removing or adding a sub-goal that was implied by the original mission. Update strategy.md, no pivot needed.
- **Org change**: same mission, different roles. That's `org-evolution.md`.

A real pivot changes the mission statement, success criteria, or fundamental approach.

## Pivot process

### 1. Confirm the pivot is intentional

Before doing anything destructive:

```
You: "I'm reading you as wanting to change the mission. Let me confirm:
  - Current mission: <one-line from strategy.md>
  - You're proposing: <one-line from user>
  - This is a pivot, not a tactical change.
  
Confirmed?"
```

If the user says no (it's actually tactical), de-escalate and treat as a normal update.

### 2. Snapshot current state

Before changing anything, snapshot the current state for the audit trail:

```sh
DATE=$(date -u +%Y-%m-%d)
mkdir -p .pilot/strategy-history/$DATE
cp .pilot/strategy.md .pilot/strategy-history/$DATE/
cp .pilot/org-chart.md .pilot/strategy-history/$DATE/
cp -r .pilot/active-missions .pilot/strategy-history/$DATE/
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | PIVOT_SNAPSHOT | Captured pre-pivot state" >> .pilot/decisions.log
```

This lets you (or future-you) reconstruct what the pre-pivot company looked like.

### 3. Decide fate of in-flight work

For each active mission:

- **Aligned with new direction** → continue (note in progress.md: "[date] Pivot: this mission remains relevant.")
- **Partially aligned** → re-scope and continue (update goal.md + plan.md to reflect what to keep)
- **Not aligned** → archive
  ```sh
  # Move to archived-missions/ with a special outcome.md
  echo "Outcome: archived due to strategic pivot on $DATE. Pre-pivot state preserved in strategy-history/$DATE." > .pilot/active-missions/<id>/outcome.md
  mv .pilot/active-missions/<id> .pilot/archived-missions/
  ```

For each in-flight task in archived missions:
- Decide: cancel (`emploke task rm`) or let it complete (output may be reusable for new direction).

### 4. Rewrite strategy.md

This is the only file you fully replace (rather than append to). Use the bootstrap template (`bootstrap.md`) as the structure. Make sure to:

- Date the new strategy at the top (so it's clear this is the new mission, not the old)
- Cross-reference the snapshot: "Previous strategy archived in strategy-history/<date>/."
- Re-derive success criteria and time horizon from scratch — don't just edit the old ones.

### 5. Re-derive the org

The new mission may need different roles. Use `sub-agent/domains.md` framework fresh — don't assume the old roles still fit.

For each existing role:

- **Still needed** → keep
- **Needed with adjustment** → update agent body, bump version, re-probe
- **No longer needed** → retire (`emploke catalog agent disable / rm`)

For new roles needed:
- Hire (decision tree)

Update `org-chart.md`. Append to `decisions.log` for each change with `PIVOT_REORG | <change>`.

### 6. Communicate the pivot

In the session terminal:

```
PIVOT COMPLETE.
Old mission: <one-line>
New mission: <one-line>

Org changes:
  - <change 1>
  - ...

In-flight work:
  - Continued: <missions>
  - Archived:  <missions>

First moves under new strategy: <bullet list>

Anything to adjust?
```

In `.pilot/reports/<date>-pivot.md`, write a longer narrative for the audit log.

### 7. Letter to future self

Write a letter explaining the pivot — why, what changed, what to remember:

```sh
cat > .pilot/letters/$(date +%Y-%m-%d)-pivot.md <<EOF
# Letter from the pivot session

We pivoted the company on $(date +%Y-%m-%d).

Old mission: <one-line>
New mission: <one-line>

Why we pivoted:
<one paragraph>

What was preserved (and why):
- <thing 1>
- ...

What was archived (and why):
- <thing 1>
- ...

Watch out for:
<things that might be confusing for future-you reading old artifacts>

Open questions:
- <questions the pivot didn't answer>
EOF
```

## Anti-patterns

- **Don't pivot mid-tick.** Complete the current tick's work, then enter pivot mode.
- **Don't pivot under emergency.** Emergency mode handles tactical rescue; pivot handles strategic change. Resolve the emergency first, then evaluate if pivot is needed.
- **Don't pivot frequently.** If you pivot more than once a quarter, the pattern itself is a problem — surface to the user.
- **Don't quietly drift.** If you find yourself doing work that's not in strategy.md, that's drift. Either update strategy.md (small case) or trigger a pivot conversation (large case). Don't pretend nothing changed.

## Recovery if a pivot was wrong

If the new direction turns out to be wrong, you can pivot back. Use the same process. Reference the original snapshot:

```
Previous strategy (pre-pivot): see strategy-history/<original-pivot-date>/strategy.md
```

Document the round-trip in `decisions.log`. The lesson here may be valuable: write it to `lessons.md`.
