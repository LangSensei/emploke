# Stuck task intervention

A task is **stuck** when:

- Status is `running`
- No new activity in the activity log for ≥ 30 minutes (calibrate per mission tempo)
- AND the task is not in a known long-blocking state (e.g. waiting on user-side input, large download, etc.)

## Detection

Per tick (step 3 of the operating loop):

```sh
for tid in $(echo "$running" | jq -r '.[].id'); do
  # Use task.metadata.lastActiveAtRuntime — runtime-supplied "when did
  # I last see activity from this subprocess". Fall back to startedAt
  # then createdAt for tasks the runtime hasn't reported on yet.
  #
  # We use `task show` (single metadata read) rather than
  # `task activity --limit 1` (parses the log) because `task show` is
  # strictly cheaper — both report the same "most recent activity"
  # timestamp now that activity is tail-first.
  RECENT=$(emploke task show "$tid" --json | jq -r '.metadata.lastActiveAtRuntime // .startedAt // .createdAt')
  AGE_MIN=$(( ($(date +%s) - $(date -d "$RECENT" +%s)) / 60 ))
  if [ "$AGE_MIN" -ge 30 ]; then
    handle_stuck_task "$tid" "$AGE_MIN"
  fi
done
```

## Triage

When you detect a stuck task, don't immediately kill it. Triage:

1. **Read the last activity entries**:
   ```sh
   # Tail-first: --limit 20 returns the LATEST 20 events, ASC-sorted.
   emploke task activity "$tid" --json --limit 20 | jq '.activity[] | {ts: .timestamp, kind: .kind, summary: (.text // .description // "" | tostring | .[0:120])}'
   ```
2. **Look for the last meaningful step.** What was the agent doing right before it went silent?
3. **Classify the stuckness:**
   - **Network-bound**: agent was making an HTTP call, then silent. Likely waiting on a slow upstream. Wait another 30min (one extension), then intervene.
   - **CPU-bound**: agent was processing a large input. Check task workdir size — growing? If yes, give it time. If not, intervene now.
   - **Logical loop**: agent's recent activity shows repetitive identical messages. It's stuck in a loop. Intervene immediately.
   - **External wait**: agent is waiting on something external you can resolve (e.g. a file the user was supposed to drop). Surface to user, don't kill.
   - **Unknown**: no clear signal. Default to one extension + then intervene.

## Intervention options (in order of escalation)

### 1. Wait (one extension)

For network-bound or CPU-bound stuckness, give it another 30 minutes. Log the decision:

```sh
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WAIT | task $tid stuck for ${AGE_MIN}min, extending 30min | <classification>" >> .pilot/decisions.log
```

Track in `state.json` so next tick knows you're already in the extension window. Don't extend twice.

### 2. Cancel + redispatch with adjustments

If the task is in a logical loop OR you've already extended once:

```sh
emploke task rm "$tid"   # cancel
# Then redispatch with a refined brief:
emploke task dispatch --agent <same-agent> --brief "<refined>" --json
```

Update the mission's `tasks.json` to point to the new task ID. Append to `progress.md`:

```
[YYYY-MM-DDTHH:MM:SSZ] Cancelled stuck task $tid (loop detected); redispatched as $newTid with refined brief.
```

### 3. Cancel + switch agent

If you've already redispatched once with the same agent and it's stuck again, the agent might not be capable. Switch:

```sh
emploke task rm "$tid"
# Pick a different agent from your roster (or reuse hiring decision tree).
emploke task dispatch --agent <different-agent> --brief "<orig>" --json
```

Update `hires.md` with a failure entry for the original agent.

### 4. Escalate to user

If the second agent also stuck, OR you can't tell what's going wrong, OR the stuckness is external-wait that requires user action:

```
Send to session terminal:
  Mission <id> step "<step>" is stuck on task <tid> (agent <agent>, idle for <N> minutes).
  Last activity: <one-line summary>
  My triage: <classification>
  Tried: <what you tried>
  I need your input on: <specific question>
```

DO NOT silently wait forever. Stuck tasks are the leading cause of zombie missions.

## Post-intervention

After ANY intervention (extension or otherwise):

```sh
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] STUCK_INTERVENTION | task $tid | <action> | <reason>" >> .pilot/decisions.log
```

If the intervention pattern repeats for the same agent (multiple stuck-then-redispatch cycles), the agent has a quality problem. Add to `hires.md` with a strong negative note; consider retiring.

## Don't

- Don't auto-kill long-running tasks. Some legitimate work is slow.
- Don't extend more than once. Two extensions = "I don't know what to do" = escalate instead.
- Don't redispatch the same task to the same agent more than twice. Definition of insanity.
