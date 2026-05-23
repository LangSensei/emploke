# Session restart recovery

Your session is a long-lived process, but it can crash, be killed, or be cleanly stopped + restarted. When it comes back up, you need to recover state and resume work without double-processing or losing track.

## What survives a restart

- `.pilot/` directory and everything in it
- `<workspace>/local-agents/` (your created agents)
- The emploke server's task state (running tasks keep running, completed tasks stay queryable)

## What does NOT survive

- Your in-memory state for the current tick (whatever you were halfway through computing)
- Any open file handles, network connections, etc.
- The user's active terminal connection (they'll need to re-attach)

## Recovery flow

When you start up and detect `.pilot/` exists:

```sh
# 1. Read state.json to know when you last ticked.
LAST_TICK=$(jq -r .last_tick .pilot/state.json 2>/dev/null || echo "1970-01-01T00:00:00Z")

# 2. Read identity, strategy, recent letters, decisions.log tail.
cat .pilot/identity.md
cat .pilot/strategy.md
ls -t .pilot/letters/ | head -1 | xargs -I{} cat .pilot/letters/{}
tail -20 .pilot/decisions.log

# 3. Reconcile in-flight tasks vs your tracked state.
emploke task list --status running --json > /tmp/server-running.json
# Compare against .pilot/active-missions/*/tasks.json
# Look for:
#   - Tasks the server has but your tasks.json doesn't (orphans — happened during your downtime)
#   - Tasks your tasks.json has but the server says are completed (catch-up needed)

# 4. Catch up on completions since LAST_TICK.
emploke task list --status success,failure,cancelled --created-since "$LAST_TICK" --json
# Process each per operating loop step 2.

# 5. Update state.json with new last_tick.

# 6. Append a session-resume entry to decisions.log:
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | RESUME | Recovered after $((NOW - LAST_TICK_EPOCH)) sec downtime; processed N catchup completions; M in-flight tasks reconciled." >> .pilot/decisions.log

# 7. Greet the user with the resume status (see communication/to-user.md).
```

## Edge cases

### Long downtime (hours / days)

If `LAST_TICK` is more than 24 hours ago:

- A LOT of tasks may have completed in your absence. Process them all in one catchup pass (don't try to space them out).
- Some may have failed; you need to write post-mortems for the missions that lost steps.
- `active-missions/` may be substantially out of date; do a thorough reconciliation pass.

### Orphan tasks

A task is on the server but not in any of your `tasks.json`:

Possible causes:
- You dispatched it but crashed before writing tasks.json (rare if you write tasks.json IMMEDIATELY after dispatch — you should).
- The user dispatched it directly (legitimate; they have CLI access too).
- Another pilot instance ran (this is bad — only one pilot per workspace; surface this to user).

For unknown orphans, ask the user before continuing: "I found N orphan tasks. Are these yours? Should I incorporate them into a mission, or let them complete and ignore?"

### Phantom tasks

A task is in your `tasks.json` but the server says it doesn't exist:

Possible causes:
- The task was hard-deleted (`task rm --purge`) by you previously and you forgot to update tasks.json.
- The server was reset between your sessions (lost task state).

Update `tasks.json` to remove the phantom; append to `progress.md` noting the cleanup.

### Stale `state.json`

If `state.json` says LAST_TICK is in the future (clock skew, manual file edit), reset it conservatively:

```sh
LAST_TICK=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
```

This means you'll catch up the past 24h of completions, which is over-inclusive but safe.

### Active mission with no progress in N days

If a mission has had no progress.md updates in 30+ days AND has no in-flight tasks, it's effectively orphaned. Two options:

- Resume by dispatching the next un-checked step in plan.md (if the strategy is still valid)
- Archive as abandoned (write outcome.md, move to archived-missions/)

Surface to user before deciding.

## Avoiding double-processing

The key: only mark completions as processed AFTER you've handled them. Update `state.json`'s LAST_TICK only at the end of step 2 in the operating loop, not at the start.

If you crash mid-processing, the next tick re-processes those completions — which is fine because processing is idempotent (you append to progress.md, append to hires.md — duplicates would be visible but not corrupting). The MISSION steps don't get re-dispatched because the next-step decision is based on plan.md state, which only gets updated when you actually advance.

## Pre-emptive resilience

Habits that make recovery easier:

- **Write `tasks.json` IMMEDIATELY after every dispatch**, before doing anything else.
- **Update `state.json` after every meaningful tick**, not just the last one of a session.
- **Write letters generously** — every notable session ends with a letter for future-you.
- **Don't keep important state in memory.** If you need it across ticks, write it to a file.
