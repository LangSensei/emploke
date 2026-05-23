# Operating loop reference

Detailed expansion of the loop in `AGENTS.md`. Use as a per-tick checklist when you find yourself unsure what to do next.

## Tick cadence

You don't run on a real timer — you process a tick when:

- A user message arrives in the session terminal
- You finish a `wait()` interval (default: 60 seconds, adjust based on mission tempo)
- A task event fires (completion / failure / cancellation)

A "tick" = one full pass through steps 1-7 below.

## Step 1: Sync

```sh
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LAST_TICK=$(jq -r .last_tick .pilot/state.json 2>/dev/null || echo "1970-01-01T00:00:00Z")

emploke task list --status running --json > /tmp/running.json
emploke task list --status success,failure,cancelled --created-since "$LAST_TICK" --json > /tmp/completed.json

# Update LAST_TICK after we've processed completions (see step 2 end).
```

Audit watchdog liveness while you're already enumerating active
missions (a dead watchdog masquerades as a healthy long-running task
otherwise):

```
for each .pilot/active-missions/*/watchdog.log:
  if not alive (per dispatch-watchdog SKILL): respawn watchdog
```

## Step 2: Process completions

For each task in `/tmp/completed.json`:

```sh
TID=$(echo "$task" | jq -r .id)
STATUS=$(echo "$task" | jq -r .status)
AGENT=$(echo "$task" | jq -r .agent)

# Find the owning mission (you tracked this in step 5 of a prior tick).
MISSION=$(grep -l "\"$TID\"" .pilot/active-missions/*/tasks.json | head -1 | xargs dirname)

# Read the activity tail to see what happened.
ACTIVITY=$(emploke task activity "$TID" --json --limit 50)
RESULT=$(echo "$ACTIVITY" | jq -r '.result // ""')

case "$STATUS" in
  success)
    # Append to the mission's progress.md.
    echo "[$NOW] Task $TID ($AGENT) succeeded: $(echo "$RESULT" | head -c 200)" >> "$MISSION/progress.md"

    # Decide: does this complete a mission step? Advance the mission.
    # Refer to mission's plan.md to find the next step. If the mission
    # is now complete, archive it (see "Mission completion" below).
    ;;

  failure)
    # Write a one-line post-mortem stub.
    MISSION_ID=$(basename "$MISSION")
    echo "[$NOW] Task $TID ($AGENT) failed: $(echo "$RESULT" | head -c 300)" >> ".pilot/post-mortems/$MISSION_ID.md"

    # Apply failure handling per AGENTS.md.
    # Quick triage:
    #   - error type "EntryNotReadyError" → run the fix command, retry once
    #   - other typed code → consult references/error-codes.md in the `emploke/cli` skill, decide retry / replace agent / escalate
    #   - generic stderr only → likely instruction-quality issue; re-dispatch with clearer instructions
    ;;

  cancelled)
    echo "[$NOW] Task $TID ($AGENT) was cancelled (likely user / system intervention)" >> "$MISSION/progress.md"
    # Don't auto-redispatch a cancelled task — it was cancelled for a reason.
    # Surface to user if mission needs that work.
    ;;
esac

# Update hires.md with the outcome.
# See self-improvement/hires-evaluation.md for the format.
```

After processing all completions:

```sh
echo '{"last_tick":"'"$NOW"'"}' > .pilot/state.json
```

## Step 3: Detect stuck tasks (watchdog-less fallback only)

Tasks with an active watchdog are monitored via runtime notification —
the watchdog pushes terminal state to the session. You do NOT poll
them here. This step exists only for tasks WITHOUT a watchdog (rare;
e.g. legacy in-flight tasks from before watchdog adoption).

```
for task in running:
  if task has active watchdog: skip   # notification-driven
  recent  = task.metadata.lastActiveAtRuntime ?? task.startedAt ?? task.createdAt
  age_min = minutes_since(recent)
  if age_min >= 30: handle_stuck(task, age_min)   # see references/monitoring/stuck-task-intervention.md
```

`minutes_since` is host-shell dependent — implement it in your shell.

Read `task.metadata.lastActiveAtRuntime` from `task show --json` (single
metadata read) rather than `task activity --limit 1` (which parses the
activity log); both expose the same "most recent activity" timestamp and
`task show` is strictly cheaper.

## Step 4: Process inbox

```sh
for item in .pilot/inbox/*; do
  [ -f "$item" ] || continue
  # Item could be a markdown note, a JSON event, a file the user dropped.
  # Decide based on content.
  process_inbox_item "$item"
  mkdir -p ".pilot/inbox/processed/$(date +%Y-%m-%d)"
  mv "$item" ".pilot/inbox/processed/$(date +%Y-%m-%d)/"
done
```

If items are user messages, **incorporate into your context for this tick** before deciding next moves.

## Step 5: Advance active missions

For each `.pilot/active-missions/<mid>/`:

```sh
PLAN="$mission/plan.md"
NEXT=$(grep '^- \[ \]' "$PLAN" | head -1)  # next un-checked step

if [ -n "$NEXT" ]; then
  # Decide: ready to dispatch? (Are its prerequisites done?)
  # If yes, dispatch:
  TID=$(emploke task dispatch \
        --agent <chosen-agent-from-org-chart> \
        --brief "$(craft_brief_for "$NEXT")" \
        --json | jq -r .id)
  # Track the mapping.
  jq --arg step "$NEXT" --arg tid "$TID" '.[$step] = $tid' \
     "$mission/tasks.json" > "$mission/tasks.json.new"
  mv "$mission/tasks.json.new" "$mission/tasks.json"
  echo "[$NOW] Dispatched $TID for step: $NEXT" >> "$mission/progress.md"
fi
```

## Step 6: Idle reflection

Trigger only if steps 2-5 produced no actual work this tick. Cycle through (over multiple idle ticks, not all at once):

- Hires evaluation (`self-improvement/hires-evaluation.md`)
- Lessons extraction (`self-improvement/lessons-extraction.md`)
- Playbook distillation (`self-improvement/playbook-distillation.md`)
- Marketplace scan (light: every N idle ticks, not every one)
- Strategy review (very light: re-read strategy.md, ask "still aimed right?")

## Step 7: Wait

```sh
# Wait for the soonest of:
#   - tick interval (e.g. 60s)
#   - user input on stdin
#   - signal that a task event fired (you can check by polling, see step 1)
#
# Implementation: a simple `sleep 60` + checking stdin readiness
# is sufficient. More sophisticated agents can use a select-style
# wait, but it's not required.
```

## Mission completion

When you advance a mission's plan past its last step:

1. Run a final verification — does the deliverable meet `goal.md`'s success criteria?
2. Write `outcome.md` in the mission directory: what was delivered, what worked, what didn't.
3. Move the directory to `.pilot/archived-missions/<id>/`.
4. Update `strategy.md` if completion changes the mission landscape.
5. If lessons emerged: append to `.pilot/lessons.md` with a one-line summary.
6. Append to `.pilot/decisions.log`: `MISSION_COMPLETE | <id> | <one-line summary>`.

## Mission abandonment

When a mission can't be completed (irrecoverable failure / user cancels):

1. Write `outcome.md`: state "abandoned", document why.
2. Move to `.pilot/archived-missions/<id>/`.
3. Post-mortem MUST exist (it's in `.pilot/post-mortems/<id>.md`).
4. Extract lessons (`self-improvement/lessons-extraction.md`).

## When to surface to the user

Don't be silent for too long. Send a session-terminal status update when:

- A mission completes successfully (with deliverable)
- A mission abandons (with reason + post-mortem pointer)
- A high-confidence escalation is needed
- It's the start of a new "shift" (e.g. weekly all-hands trigger)
- The user asks

Don't be noisy. Don't send a status update for every task completion if the mission has 50 tasks — batch them in a daily/mission summary.
