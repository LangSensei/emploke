---
name: dispatch-watchdog
scope: emploke
description: "Spawns a properly-detached cross-platform watchdog over a running emploke task — polls status, exits on terminal state, and reliably surfaces runtime completion notifications to the orchestrator session"
version: 1.1.0
---

# Dispatch Watchdog Skill

## Domain

A single primitive for any orchestrator agent that dispatches
long-running `emploke` tasks: given a task id, spawn a watchdog that
polls `emploke task show` on a configurable cadence and exits when
the task reaches a terminal status (`succeeded`, `failed`,
`cancelled`). The watchdog must be spawned in a way that the emploke
runtime can observe its completion and deliver a notification back to
the orchestrator's session — not all spawn patterns achieve this.

## Boundary

**In scope:**
- Spawning a detached PowerShell or bash watchdog process from the
  orchestrator's shell.
- A polling loop that reads task status via the emploke CLI and exits
  cleanly on terminal state.
- A persisted watchdog log (one line per poll) for after-the-fact
  inspection.
- Cross-platform variants (PowerShell on Windows; bash on
  macOS/Linux).

**Out of scope:**
- Interpreting task output or success/failure semantics — that is the
  caller's job after notification.
- Cancelling stuck tasks — see the caller's stuck-task playbook.
- Replacing the orchestrator's own monitoring tick loop; this is for
  *single* long-running tasks where polling-in-foreground would block
  other work.

## Why this skill exists

The emploke runtime delivers a notification to the orchestrator's
session when a watchdog process associated with the session reaches a
terminal state — **but only if the watchdog was spawned through the
correct primitive**. Four spawn patterns commonly tried in practice,
and the empirical outcome of each:

| # | Pattern | Outcome |
|---|---|---|
| 1 | `task` tool with a subagent (e.g. Haiku) | Subagent often *describes* the work instead of executing the loop; unreliable. |
| 2 | `Start-Process pwsh -ArgumentList …` | Process spawns but bypasses runtime wiring; **no completion notification**. |
| 3 | `powershell mode:async` (no `detach`) | Tied to the session shell; session shutdown kills the watchdog before it can complete. |
| 4 | `powershell mode:async, detach:true` | ✅ Reliably produces completion notifications and survives session lifecycle. |

This skill canonicalises **pattern 4** and its bash equivalent so no
orchestrator has to rediscover them.

## Primitive

### PowerShell (Windows)

Write the watchdog body to a script file inside the mission folder
(so it survives across shells), then invoke it once via the
mode:async + detach:true primitive:

```pwsh
# Step 1 — write the watchdog script. Adjust $tid, $interval, $log path.
$missionDir = "$env:EMPLOKE_WORKSPACE_DIR\.pilot\active-missions\<mission-id>"
$tid        = "<task-id>"
$interval   = 60   # seconds between polls
$logPath    = Join-Path $missionDir "watchdog.log"

$body = @"
`$ErrorActionPreference = 'Continue'
"`$(Get-Date -Format o) watchdog started for $tid" | Add-Content '$logPath'
while (`$true) {
    `$raw = & emploke task show '$tid' --json 2>`$null
    # Regex-extract status to avoid host-shell JSON parser quirks.
    if (`$raw -match '"status"\s*:\s*"([^"]+)"') {
        `$status = `$Matches[1]
        "`$(Get-Date -Format o) status=`$status" | Add-Content '$logPath'
        if (`$status -in 'succeeded','failed','cancelled') { break }
    }
    Start-Sleep -Seconds $interval
}
"@
Set-Content -Path (Join-Path $missionDir 'watchdog.ps1') -Value $body -Encoding UTF8
```

```pwsh
# Step 2 — spawn it with mode:async + detach:true (pattern 4).
# In emploke / Copilot CLI tool form:
#   powershell:
#     command:     pwsh -NoProfile -File "<missionDir>\watchdog.ps1"
#     mode:        async
#     detach:      true
#     initial_wait: 10
```

The orchestrator returns immediately to other work; runtime notifies
the session when the watchdog exits.

### Bash (macOS / Linux)

```bash
# Step 1 — write the watchdog script.
mission_dir="${EMPLOKE_WORKSPACE_DIR}/.pilot/active-missions/<mission-id>"
tid="<task-id>"
interval=60
log_path="${mission_dir}/watchdog.log"

cat > "${mission_dir}/watchdog.sh" <<EOF
#!/usr/bin/env bash
set +e
printf '%s watchdog started for %s\n' "\$(date -Iseconds)" "${tid}" >> "${log_path}"
while :; do
  raw=\$(emploke task show "${tid}" --json 2>/dev/null)
  status=\$(printf '%s' "\$raw" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
  printf '%s status=%s\n' "\$(date -Iseconds)" "\$status" >> "${log_path}"
  case "\$status" in
    succeeded|failed|cancelled) exit 0 ;;
  esac
  sleep ${interval}
done
EOF
chmod +x "${mission_dir}/watchdog.sh"
```

```text
# Step 2 — spawn with mode:async + detach:true.
# In emploke / Copilot CLI tool form:
#   bash / shell:
#     command:     "${mission_dir}/watchdog.sh"
#     mode:        async
#     detach:      true
#     initial_wait: 10
```

(On Unix-like systems the runtime wraps detached commands with
`setsid` automatically; the notification path is the same as
Windows.)

## Watchdog log format

First line is the start marker (see Caller contract item 4). One line
per poll thereafter, monotonic-timestamp-prefixed, for debugging stuck
or runaway watchdogs:

```
2026-05-22T08:30:00+00:00 watchdog started for tsk_abc123
2026-05-22T08:31:00+00:00 status=running
2026-05-22T08:32:00+00:00 status=running
2026-05-22T08:33:00+00:00 status=succeeded
```

## Anti-patterns (do not use)

- **Do not** use the `task` tool with a Haiku/Sonnet subagent for the
  poll loop. Agents describe; they don't reliably loop.
- **Do not** use `Start-Process` to background the watchdog. The
  process is invisible to the runtime.
- **Do not** use `mode:async` without `detach:true`. Session
  shutdown will kill it.
- **Do not** poll faster than every ~15s without good reason — every
  poll is a CLI invocation that spawns a Node process.

## Caller contract

The caller (orchestrator) MUST:
1. Persist the task id (`task-id.txt` in the mission folder is the
   convention).
2. Invoke the watchdog once per task. Do not re-spawn if one is
   already alive. **Liveness = `watchdog.log` mtime within 2× the
   configured poll interval.** Older = dead; respawn.
3. On notification, read `watchdog.log`'s last line for the final
   status and proceed.
4. **Verify start within 5s of spawning.** Read the first line of
   `watchdog.log`; it MUST contain `watchdog started for <tid>`. If
   the marker is absent, the watchdog is dead (bad args, missing tid,
   exec failure) — fix the invocation and respawn. Do not proceed
   assuming monitoring is active.

## CHANGELOG

See `CHANGELOG.md` next to this file.
