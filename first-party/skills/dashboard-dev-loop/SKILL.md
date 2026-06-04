---
name: dashboard-dev-loop
scope: emploke
description: "Start a mock-backed dashboard dev server, drive it via Playwright MCP, iterate edits + screenshots, and tear down cleanly"
version: 1.0.1
---

# Dashboard Dev Loop Skill

## Domain

A scoped primitive for any agent that wants to iterate on `packages/dashboard` UI under MSW mocks: start `pnpm -F @emploke/dashboard dev:mock:e2e` (port 5180, `strictPort: true`), drive the resulting page via `io.playwright/mcp`, capture screenshots into a deterministic location, allow the calling agent to edit dashboard source between iterations (vite HMR picks up the change automatically), and tear the dev server down on exit — success, failure, or signal.

This skill is the start-screenshot-edit-restart primitive. It is intentionally narrow: process lifecycle + readiness gate + screenshot path convention + teardown discipline. Anything fancier (visual diffing, regression baselines, video, trace recording) is explicitly out of scope.

## Boundary

**In scope:**
- Lifecycle of one `pnpm -F @emploke/dashboard dev:mock:e2e` process per task (start → readiness check → teardown).
- Convention for the dev-server log file (`<workspace>/.designer/dev-server.log`).
- Convention for the screenshot output path (`<workspace>/.designer/<ISO8601>-<label>.png`).
- Deterministic HTTP-readiness gate against `http://localhost:5180/index.html` before any Playwright navigation.
- The "edit → re-screenshot" loop pattern: the calling agent edits a `packages/dashboard/src/**/*.{tsx,ts,css}` file, vite HMR reloads, the agent re-screenshots.
- Teardown on normal exit AND signal interruption (orphaned vite processes are the canonical failure mode — see "Anti-patterns").
- Cross-platform variants — PowerShell on Windows, bash on macOS / Linux.

**Out of scope:**
- Hand-authoring fixture data — fixtures live at `packages/dashboard/src/mocks/fixtures/**` and belong to the dashboard package; this skill only consumes them.
- Comparing screenshots — no diffing, no visual-regression baseline management. The agent (or its human reviewer) inspects screenshots; the skill just captures.
- Recording video, traces, or accessibility audits.
- Any non-mock dev-server lifecycle. `dev:mock:e2e` on port 5180 is the **only** server this skill drives. The real-backend `pnpm dev` script is forbidden (see "Anti-patterns").
- Mutation flows (POST / PATCH / DELETE through the dashboard against mocks) — only the `/schedules` slice is mocked today; coverage for the rest of the surface is deferred to a follow-up skill, tracked in issue #213.

## Why this skill exists

The naive pattern — agent runs `pnpm -F @emploke/dashboard dev:mock:e2e` in the foreground, opens a Playwright page by hand, manually kills the process — has three recurring failure modes that compound across runs:

1. **Orphaned vite processes after agent crash or timeout.** The next iteration's `--strictPort 5180` then refuses to bind, surfacing as a 30-second-deep `EADDRINUSE` failure in the *next* task — far from the actual cause. The agent that orphaned the process is already gone; the agent that hits the orphan has no idea what to do.
2. **Race between vite ready and first navigation.** Playwright opens the page before vite has finished binding the port, hits `ECONNREFUSED`, then retries with browser-level noise instead of waiting on a deterministic readiness signal. The retry sometimes works, sometimes lands on a half-rendered page; the agent's screenshot is then unreviewable.
3. **Screenshot path conventions drift across runs.** Each agent invents its own output directory; the pilot greps for `*.png` in places they aren't and concludes the run had no artifacts. Reviewers can never reproduce the agent's view.

This skill canonicalises a single answer to all three.

## Primitive

> The skill exposes process-management primitives in PowerShell and bash, plus a screenshot-path helper. The actual screenshot capture is delegated to the `io.playwright/mcp` tool `browser_take_screenshot` — the helper returns the *filename* the MCP call must use, so every agent in every catalog writes to the same canonical location.

### PowerShell (Windows)

Paste once into the agent's PowerShell session before any dashboard automation. Functions resolve `<workspace>` from `$env:EMPLOKE_WORKSPACE_DIR` (set inside any emploke task / session), with a `(Get-Location).Path` fallback for manual invocation.

```pwsh
# --- workspace + designer-dir resolver --------------------------------------
function Get-DesignerDir {
    $workspace = if ($env:EMPLOKE_WORKSPACE_DIR) {
        $env:EMPLOKE_WORKSPACE_DIR
    } else {
        (Get-Location).Path
    }
    $dir = Join-Path $workspace '.designer'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

# --- start the mock dashboard ------------------------------------------------
function Start-DashboardMock {
    [CmdletBinding()]
    param(
        # Path to the emploke worktree root (where pnpm-workspace.yaml lives).
        [Parameter(Mandatory)][string] $RepoRoot,
        [int] $TimeoutSec = 30,
        [int] $Port = 5180
    )

    $designerDir = Get-DesignerDir
    $logPath     = Join-Path $designerDir 'dev-server.log'
    $errPath     = Join-Path $designerDir 'dev-server.err'

    # Truncate previous logs so the readiness-failure tail is for this run.
    Set-Content -LiteralPath $logPath -Value '' -Encoding UTF8
    Set-Content -LiteralPath $errPath -Value '' -Encoding UTF8

    $proc = Start-Process -FilePath 'pnpm' `
        -ArgumentList @('-F', '@emploke/dashboard', 'dev:mock:e2e') `
        -WorkingDirectory $RepoRoot `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError  $errPath `
        -NoNewWindow -PassThru

    $script:DashboardMockPid = $proc.Id

    # Poll the HTTP endpoint until it returns 200 with the React mount-point div.
    # Polling beats sleep because vite cold-start times vary (cache state, CI runner load).
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $tail = (Get-Content -LiteralPath $logPath -Tail 20 -ErrorAction SilentlyContinue) +
                    (Get-Content -LiteralPath $errPath -Tail 20 -ErrorAction SilentlyContinue)
            throw "Dashboard mock dev server exited before becoming ready (exit code $($proc.ExitCode)). Log tail:`n$($tail -join [Environment]::NewLine)"
        }
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:$Port/index.html" `
                -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200 -and $resp.Content -match 'id="root"') {
                return $proc.Id
            }
        } catch {
            # not bound yet, keep polling
        }
        Start-Sleep -Milliseconds 500
    }

    # Timed out — kill what we started, surface a tail of the log.
    Stop-DashboardMock -ProcessId $proc.Id
    $tail = Get-Content -LiteralPath $logPath -Tail 20 -ErrorAction SilentlyContinue
    throw "Dashboard mock dev server did not become ready on http://localhost:$Port within ${TimeoutSec}s. Log tail:`n$($tail -join [Environment]::NewLine)"
}

# --- stop the mock dashboard (kills the process tree) ------------------------
function Stop-DashboardMock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int] $ProcessId
    )

    # pnpm spawns node/vite as a child; both must die or :5180 stays bound.
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch {}

    if ($script:DashboardMockPid -eq $ProcessId) {
        $script:DashboardMockPid = $null
    }
}

# --- screenshot path helper --------------------------------------------------
# Returns the absolute filename the agent must pass to the
# io.playwright/mcp tool `browser_take_screenshot` (`filename` arg).
function Get-DashboardScreenshotPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Label
    )
    # Sanitise label: kebab-case ascii, no path separators or shell-meta chars.
    $safe = ($Label -replace '[^a-zA-Z0-9\-_]+', '-').Trim('-').ToLowerInvariant()
    if ([string]::IsNullOrEmpty($safe)) { $safe = 'screenshot' }

    $designerDir = Get-DesignerDir
    # Filesystem-safe ISO-8601 (no colons): 20260527T144209Z
    $ts = (Get-Date -AsUTC).ToString('yyyyMMddTHHmmssZ')
    return (Join-Path $designerDir "$ts-$safe.png")
}

# --- exit-time cleanup (engine event survives the calling script's scope) ----
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    if ($script:DashboardMockPid) {
        try { Stop-DashboardMock -ProcessId $script:DashboardMockPid } catch {}
    }
} | Out-Null
```

### Bash (macOS / Linux)

Paste once into the agent's shell session. Same workspace-resolution contract as the PowerShell variant.

```bash
# --- workspace + designer-dir resolver --------------------------------------
designer_dir() {
    local workspace="${EMPLOKE_WORKSPACE_DIR:-$(pwd)}"
    local dir="${workspace}/.designer"
    mkdir -p "${dir}"
    printf '%s' "${dir}"
}

# --- start the mock dashboard -----------------------------------------------
# Usage: start_dashboard_mock <repo-root> [timeout-seconds] [port]
# Echoes the PID on success; non-zero exit + stderr tail on failure.
start_dashboard_mock() {
    local repo_root="$1"
    local timeout="${2:-30}"
    local port="${3:-5180}"

    [ -n "${repo_root}" ]   || { echo "start_dashboard_mock: repo_root required" >&2; return 2; }
    [ -d "${repo_root}" ]   || { echo "start_dashboard_mock: repo_root not a directory: ${repo_root}" >&2; return 2; }

    local dir log
    dir="$(designer_dir)"
    log="${dir}/dev-server.log"
    : > "${log}"  # truncate

    # Background pnpm normally. We deliberately do NOT use `setsid` here
    # because it ships in `util-linux` on Linux but is not present on
    # macOS by default. Teardown walks the descendant tree explicitly
    # in stop_dashboard_mock — see comments there.
    pnpm -C "${repo_root}" -F @emploke/dashboard dev:mock:e2e \
        >> "${log}" 2>&1 < /dev/null &
    local pid=$!
    export DASHBOARD_MOCK_PID="${pid}"

    local deadline=$(( $(date +%s) + timeout ))
    while (( $(date +%s) < deadline )); do
        if ! kill -0 "${pid}" 2>/dev/null; then
            echo "start_dashboard_mock: dev server exited before becoming ready. Log tail:" >&2
            tail -n 20 "${log}" >&2
            unset DASHBOARD_MOCK_PID
            return 1
        fi
        if curl -fsS --max-time 2 "http://localhost:${port}/index.html" 2>/dev/null \
                | grep -q 'id="root"'; then
            printf '%s\n' "${pid}"
            return 0
        fi
        sleep 0.5
    done

    stop_dashboard_mock "${pid}"
    echo "start_dashboard_mock: not ready on http://localhost:${port} within ${timeout}s. Log tail:" >&2
    tail -n 20 "${log}" >&2
    return 1
}

# --- stop the mock dashboard (walks descendants, no process-group leader) ---
# Helper: recursively collect all descendants of $1 in post-order (leaves first).
_dashboard_mock_descendants() {
    local parent="$1" child
    for child in $(pgrep -P "${parent}" 2>/dev/null); do
        _dashboard_mock_descendants "${child}"
        printf '%s\n' "${child}"
    done
}

stop_dashboard_mock() {
    local pid="${1:-${DASHBOARD_MOCK_PID:-}}"
    [ -z "${pid}" ] && return 0

    # Collect pnpm + all descendants (node, vite, etc.) post-order so leaves
    # die first. TERM first so vite can flush its socket; KILL after a brief
    # grace period so we never strand the port. We do not rely on process
    # groups (would need `setsid` on Linux, not available on macOS).
    local victims
    victims=$(_dashboard_mock_descendants "${pid}"; printf '%s\n' "${pid}")

    local v
    for v in ${victims}; do kill -TERM "${v}" 2>/dev/null || true; done
    sleep 1
    for v in ${victims}; do kill -KILL "${v}" 2>/dev/null || true; done

    unset DASHBOARD_MOCK_PID
}

# --- screenshot path helper -------------------------------------------------
# Echoes the absolute filename the agent must pass to the io.playwright/mcp
# tool `browser_take_screenshot` (`filename` arg).
dashboard_screenshot_path() {
    local label="$1"
    [ -n "${label}" ] || label="screenshot"
    # Sanitise to kebab-case ascii.
    local safe
    safe=$(printf '%s' "${label}" | sed -E 's/[^a-zA-Z0-9_-]+/-/g; s/^-+|-+$//g' | tr '[:upper:]' '[:lower:]')
    [ -n "${safe}" ] || safe="screenshot"

    local dir ts
    dir="$(designer_dir)"
    ts=$(date -u +'%Y%m%dT%H%M%SZ')
    printf '%s\n' "${dir}/${ts}-${safe}.png"
}

# --- exit-time cleanup (trap covers normal exit, SIGINT, SIGTERM) ----------
trap 'stop_dashboard_mock "${DASHBOARD_MOCK_PID:-}"' EXIT INT TERM
```

## Screenshot capture (MCP contract)

The skill does not invoke the browser directly — it delegates to the agent's `io.playwright/mcp` tool harness. The contract is:

1. The agent has loaded the `io.playwright/mcp` MCP (`https://github.com/LangSensei/emploke-marketplace/tree/main/mcps/io.playwright_mcp.json`).
2. The agent calls the MCP tool `browser_navigate` once with `url = "http://localhost:5180<route>"` (or whatever sub-route the brief specifies).
3. For each screenshot the agent calls the MCP tool `browser_take_screenshot` with arguments:
   - `filename` = the absolute path returned by `Get-DashboardScreenshotPath -Label '<label>'` (PowerShell) or `dashboard_screenshot_path '<label>'` (bash).
   - `fullPage` = `true` when the brief calls for a whole-page capture; otherwise omit.
4. After a source-file edit, the agent waits ~500ms for vite HMR to push the new module before re-screenshotting (HMR is sub-second on warm vite, but the screenshot would otherwise occasionally catch the previous render).

The `<workspace>/.designer/<ISO8601>-<label>.png` convention is what the pilot greps for when archiving missions — agents that invent their own location lose the artifact at handoff time.

## Caller contract

The calling agent MUST:

1. Load this skill body in full before any dashboard automation. The helpers above are not re-derivable from prose.
2. Call `Start-DashboardMock -RepoRoot <worktree-path>` (PS) / `start_dashboard_mock <worktree-path>` (bash) exactly once per task. The single-tenant constraint on port 5180 means a second concurrent call always fails — there is no use case for starting two.
3. Register an exit handler that calls `Stop-DashboardMock` on every code path. The pasted skill snippet already installs one (`Register-EngineEvent` in PS, `trap` in bash); the caller MUST NOT remove it. If the caller wraps additional cleanup in its own `try { … } finally { … }` / `trap`, it must also call `Stop-DashboardMock` from the finally block as belt-and-braces.
4. Use the `Get-DashboardScreenshotPath` / `dashboard_screenshot_path` helpers for every `browser_take_screenshot` call. Never hand-craft a screenshot path.
5. Never spawn a second `pnpm -F @emploke/dashboard dev:mock:e2e` while one is alive. If the first one is stuck, kill it via `Stop-DashboardMock` first.

## Anti-patterns

- **Do NOT** background `pnpm -F @emploke/dashboard dev:mock:e2e` with a bare `&` (bash) or a bare `Start-Process` (PS) without trap-based / engine-event cleanup. Every crash path becomes an orphaned vite holding port 5180 hostage for the next task.
- **Do NOT** point Playwright at `http://localhost:8788` — that's `dev:mock`, the dev-time-for-humans port. `dev:mock:e2e` on 5180 is the agent-dedicated lane; using 8788 collides whenever a human dev has a tab open.
- **Do NOT** rely on `await sleep(N)` or `Start-Sleep -Seconds N` for vite readiness. Cold-start times vary by an order of magnitude depending on npm-cache state and CI runner load. Poll `http://localhost:5180/index.html` as `Start-DashboardMock` already does.
- **Do NOT** invent your own screenshot directory. Always `<workspace>/.designer/`. The pilot archives missions by `grep -r '\.designer/.*\.png' tasks/` — anything outside that path is invisible.
- **Do NOT** run `pnpm dev` (no `:mock` suffix) from this skill. That's the real-backend dev server; running it implies a live backend exists, which is not the contract this skill speaks to.
- **Do NOT** rename or override `Stop-DashboardMock` / `stop_dashboard_mock` without preserving their teardown semantics. The exit-time hook calls them by name; a rename silently breaks the cleanup guarantee.

## CHANGELOG

See `CHANGELOG.md` next to this file.
