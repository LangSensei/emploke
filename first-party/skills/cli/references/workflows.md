# Common workflows

Each playbook is goal-oriented: name the goal, list the steps with branches. Copy and adapt.

> All examples assume `EMPLOKE_WORKSPACE=<id>` is already set. If it isn't, every command would prepend `--workspace <id>`.

---

## Install an agent and make sure it's ready to dispatch

Goal: a fresh agent (e.g. `langsensei/writer`) installed and dispatchable. Handles every blocked-state branch.

```sh
ORIGIN="https://github.com/LangSensei/emploke-marketplace/tree/main/agents/writer"

# 1. Preview what the install will do (network fetch, read prereqs, see deps).
emploke catalog agent resolve "$ORIGIN" > /tmp/plan.json
PREREQS=$(jq -r '.entry.prereqs // ""' /tmp/plan.json)

# 2. If there are prereqs, surface them to the user BEFORE installing.
#    Don't auto-ack — prereqs are the user's contract to read.
if [ -n "$PREREQS" ]; then
  echo "This agent's prereqs:"
  echo "$PREREQS"
  echo "(You'll need to acknowledge these after install.)"
fi

# 3. Install. Returns the installed entry; we read its FQN.
INSTALL=$(emploke catalog agent install "$ORIGIN" --json)
FQN=$(echo "$INSTALL" | jq -r '.installed[] | select(.kind=="agent") | .fqn')

# 4. Verify status. If blocked, branch on cause.
STATUS=$(emploke catalog agent show "$FQN" --json)
S=$(echo "$STATUS" | jq -r '.status')

case "$S" in
  ready)
    echo "agent $FQN ready"
    ;;
  blocked)
    REASON=$(echo "$STATUS" | jq -c '.blockedReason')
    if echo "$REASON" | jq -e '.needsPrereqsAck' > /dev/null; then
      # Confirm with user, then ack.
      emploke catalog agent ack-prereqs "$FQN"
    fi
    if echo "$REASON" | jq -e '.disabledByUser' > /dev/null; then
      emploke catalog agent enable "$FQN"
    fi
    if echo "$REASON" | jq -e '.missingDeps' > /dev/null; then
      # Recursive install — loop over each missingDep.fqn / origin.
      # In practice the resolve step in (1) should have included them
      # in the closure; if missingDeps fires here, the upstream
      # marketplace published an inconsistent entry. Surface to user.
      echo "ERROR: missing dependencies — upstream catalog inconsistent"
      echo "$REASON" | jq '.missingDeps'
      exit 1
    fi
    # Re-verify after fixes.
    emploke catalog agent show "$FQN" --json | jq '.status'
    ;;
esac
```

---

## Dispatch a task and wait for completion

```sh
AGENT="langsensei/writer"
BRIEF="Draft a blog post about X."

# Try dispatch. If EntryNotReadyError, the formatError stderr tells us
# exactly which fix command to run.
DISPATCH=$(emploke task dispatch --agent "$AGENT" --brief "$BRIEF" --json 2>/tmp/err)
RC=$?
if [ $RC -ne 0 ]; then
  CODE=$(grep -oP 'HTTP \d+, \K[A-Za-z]+' /tmp/err || echo "")
  case "$CODE" in
    EntryNotReadyError)
      # Re-read the stderr — it includes the exact fix command.
      grep '^  fix:' /tmp/err | head -1
      echo "Run the fix above, then re-dispatch."
      exit 1
      ;;
    AgentNotFoundError)
      echo "Agent $AGENT is not installed. Install it first via the playbook above."
      exit 1
      ;;
    *)
      cat /tmp/err
      exit $RC
      ;;
  esac
fi

TID=$(echo "$DISPATCH" | jq -r '.id')
echo "Dispatched task $TID"

# Tail until done.
emploke task activity "$TID" --follow | jq -c
# (This blocks until the task terminates; SSE event: end exits 0.)
```

---

## Monitor a long-running task

Three modes, pick the one that matches what you need:

### One-shot snapshot (no streaming)

```sh
emploke task activity <tid> --json | jq
```

Returns `{activity, result, totalItems, truncated?}`. The `activity` array is **tail-first** — without `--limit` you get the entire log; with `--limit N` you get the latest N items, ASC-sorted by `seq`. Use this when you want "what has happened so far" without subscribing. Items themselves are the cursor — derive `hasOlder` from `activity[0].seq > 0` and `hasNewer` from `activity[-1].seq < totalItems - 1`.

For older history (paging backward), pass `--before <seq>` to fetch the page immediately preceding `<seq>`. `--before` and `--after` are mutually exclusive.

### Live tail from now

```sh
emploke task activity <tid> --follow | jq -c
```

Streams `event: activity` frames as NDJSON. Each line is one `ActivityItem` with a `seq`. Exits when task terminates (`event: end`) or stream errors.

### Resume after disconnect

When `--follow` exits **cleanly** (server sent `event: end`, or the stream closed) or with a **mid-stream error** (`event: error`), stderr's last line is:

```
last seq: 1234
```

Pass that on the next invocation:

```sh
emploke task activity <tid> --follow --after 1234 | jq -c
```

This translates to `Last-Event-ID: 1234` and the server replays from `seq=1235` onward — no duplicates, no gaps.

**Ctrl+C is the exception.** The process dies between frames and stderr is never flushed, so there is no `last seq:` line. Recover the seq from stdout instead — each printed NDJSON item carries its own `seq`:

```sh
# After Ctrl+C, derive the resume seq from the LAST line of stdout.
N=$(printf '%s\n' "$LAST_STDOUT_LINE" | jq -r .seq)
emploke task activity <tid> --follow --after "$N" | jq -c
```

If you piped stdout to a file, just read the tail:

```sh
N=$(tail -1 stream.ndjson | jq -r .seq)
emploke task activity <tid> --follow --after "$N" | jq -c
```

### History-then-tail (combine snapshot + live)

```sh
N=$(emploke task activity <tid> --json | jq -r '.activity[-1].seq')
emploke task activity <tid> --follow --after "$N" | jq -c
```

Use when you join an in-progress task and want both the existing log and live updates. The snapshot's last item is the latest seq the server has emitted so far; passing it as `--after` to the follow stream picks up exactly where the snapshot ended.

---

## Sync (re-resolve) an installed entry against its upstream origin

```sh
FQN="langsensei/writer"

# Preview: returns a ResolveManifest with a `planToken` (5-min TTL).
PLAN=$(emploke catalog agent sync-resolve "$FQN" --json)
TOKEN=$(echo "$PLAN" | jq -r '.planToken')

# Show user what will change (added / removed / modified entries).
echo "$PLAN" | jq '{actions, version_changes}'

# Apply (single-use token, must be done within 5 minutes).
emploke catalog agent sync "$FQN" --plan-token "$TOKEN"
```

The same shape works for `catalog skill ...` and `catalog mcp ...`.

---

## Clean up failed / stale tasks

```sh
# List everything that failed or got cancelled.
emploke task list --status failure,cancelled --json | jq

# Archive (default): removes the metadata row, keeps workdir + runtime state on disk.
# Good for "I'm done looking at it but want the logs around".
emploke task list --status failure --json \
  | jq -r '.[].id' \
  | while read TID; do emploke task rm "$TID"; done

# Hard delete (purge): also rm the workdir and runtime's per-task state.
# Use only when you're sure you don't want stderr.log etc.
emploke task rm <tid> --purge
```

---

## Set up a fresh workspace with a standard agent set

```sh
WS=$(emploke workspace add --name "my-project" --workdir "$HOME/projects/x" --json | jq -r '.id')
export EMPLOKE_WORKSPACE="$WS"

# Install whatever agents are standard for your team.
for ORIGIN in \
    "https://github.com/LangSensei/emploke-marketplace/tree/main/agents/writer" \
    "https://github.com/LangSensei/emploke-marketplace/tree/main/agents/coder" \
  ; do
  emploke catalog agent install "$ORIGIN"
done

# Verify nothing's blocked.
emploke catalog overview --json | jq '.counts'
```

If `counts.blocked > 0`, run `emploke catalog agent list --json | jq '[.[] | select(.status=="blocked")]'` and apply the install-and-verify playbook above for each blocked entry.

---

## Create a local agent on the fly

When you need a specialist that doesn't exist in the marketplace yet, write the agent definition locally and install via `file://` origin.

```sh
# 1. Pick a name and a directory under the workspace.
NAME="report-writer"
DIR="$EMPLOKE_WORKSPACE_DIR/local-agents/$NAME"
mkdir -p "$DIR"

# 2. Write the AGENTS.md file (frontmatter + body).
cat > "$DIR/AGENTS.md" <<'EOF'
---
name: report-writer
scope: local
description: "Drafts a weekly status report from given activity inputs"
version: 1.0.0
---
# Report Writer

You receive a list of activities (one per line, free text) and produce a
markdown weekly status report:

  ## This week
  - <bullet per major item>

  ## Notable
  - <surprises, blockers, wins>

  ## Next week
  - <planned items>

Keep it under 300 words. Use plain language. Never invent data — if an
activity isn't actionable as a report item, drop it.
EOF

# 3. Install via file:// origin (absolute path).
emploke catalog agent install "file://$DIR" --json

# 4. Verify status. Local agents are mutable (origin starts with file:),
#    so you can edit AGENTS.md and re-install to iterate.
emploke catalog agent show "local/$NAME" --json | jq '.status'

# 5. Dispatch. `--brief` is the required short summary; `--details` (or
#    `--details-file`) carries the longer-form input the agent reads.
emploke task dispatch \
  --agent "local/$NAME" \
  --brief "Generate this week's status report from the activities listed in details." \
  --details "Activities:
  - shipped feature X
  - debugged Y for half a day
  - met with Z about roadmap" \
  --json
```

To iterate on a local agent: edit the file, re-install (the install is idempotent for `file://` origins and bumps the version pointer), dispatch again to test.
