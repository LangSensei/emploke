---
name: dispatch-with-details
scope: emploke
description: "Wrapper over `emploke task dispatch` that takes a brief-file path, auto-derives a ≤200-char summary for `--brief`, forwards the body via `--details-file`, and returns the parsed task id"
version: 1.0.0
---

# Dispatch With Details Skill

## Domain

A thin, agent-agnostic wrapper over `emploke task dispatch` that
removes the recurring friction of authoring the dispatch command by
hand. The `--brief` flag has a hard 200-character limit; orchestrators
that author natural-length briefs hit this every time and waste a
round-trip rewriting it. This skill standardises the "brief in a
file, summary auto-derived, task id parsed out" workflow.

## Boundary

**In scope:**
- Accepting a brief-file path (Markdown) as the primary input.
- Extracting a ≤200-character summary from the file (first non-empty
  heading text or first paragraph), trimmed and ASCII-safe.
- Invoking `emploke task dispatch --agent <agent> --brief
  "<summary>" --details-file <path>` with all caller-provided extras
  forwarded.
- Parsing the returned JSON for the new task id and returning it to
  the caller.

**Out of scope:**
- Authoring brief content. The caller owns brief quality.
- Waiting for the task to complete — use `emploke/dispatch-watchdog`
  for that.
- Mutating the brief file. It is read-only input.

## Why this skill exists

Empirical pain recurring across orchestrator runs:

- `emploke task dispatch --brief "<text>"` rejects payloads >200
  chars with a hard error.
- The natural length of the dispatching agent's brief is multi-paragraph
  Markdown.
- The workaround — write the full brief to a file, pass it via
  `--details-file`, hand-author a ≤200-char summary for `--brief` —
  is correct but rediscovered every time.

This skill canonicalises the workaround so callers stop rediscovering
it.

## Primitive

### PowerShell

```pwsh
function Invoke-EmplokeDispatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Agent,
        [Parameter(Mandatory)] [string] $BriefFile,
        [string[]] $ExtraArgs = @()
    )

    if (-not (Test-Path -LiteralPath $BriefFile)) {
        throw "brief file not found: $BriefFile"
    }

    # Derive summary: first non-empty heading text, else first paragraph.
    $lines = Get-Content -LiteralPath $BriefFile -Encoding UTF8
    $heading = $lines | Where-Object { $_ -match '^\s*#{1,6}\s+(.+)$' } | Select-Object -First 1
    if ($heading) {
        $summary = ($heading -replace '^\s*#{1,6}\s+', '').Trim()
    } else {
        $paragraph = ($lines | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
        $summary = if ($paragraph) { $paragraph.Trim() } else { (Split-Path -Leaf $BriefFile) }
    }

    # Hard-clip to 200 chars (with ellipsis if trimmed).
    if ($summary.Length -gt 200) {
        $summary = ($summary.Substring(0, 197)).TrimEnd() + '...'
    }

    # Use 2>$null to keep stderr noise out of the captured JSON.
    $raw = & emploke task dispatch `
        --agent  $Agent `
        --brief  $summary `
        --details-file $BriefFile `
        --json `
        @ExtraArgs 2>$null | Out-String

    # Regex-extract task id rather than parsing JSON (host-shell JSON parsers can choke on stderr/stdout interleavings).
    if ($raw -match '"(?:id|taskId)"\s*:\s*"([^"]+)"') {
        return $Matches[1]
    }
    throw "could not parse task id from dispatch output:`n$raw"
}
```

### Bash

```bash
emploke_dispatch() {
    local agent=$1 brief_file=$2
    shift 2

    [[ -f "$brief_file" ]] || { echo "brief file not found: $brief_file" >&2; return 1; }

    local summary
    summary=$(awk '
      /^[[:space:]]*#{1,6}[[:space:]]+/ {
        sub(/^[[:space:]]*#{1,6}[[:space:]]+/, "");
        print; exit
      }' "$brief_file")
    if [[ -z "$summary" ]]; then
      summary=$(awk 'NF { print; exit }' "$brief_file")
    fi
    [[ -n "$summary" ]] || summary=$(basename "$brief_file")

    # Clip to 200 chars.
    if (( ${#summary} > 200 )); then
        summary="${summary:0:197}..."
    fi

    local raw
    raw=$(emploke task dispatch \
        --agent  "$agent" \
        --brief  "$summary" \
        --details-file "$brief_file" \
        --json "$@" 2>/dev/null)

    # Regex out the task id.
    local tid
    tid=$(printf '%s' "$raw" | sed -n 's/.*"\(id\|taskId\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -n1)
    [[ -n "$tid" ]] || { echo "could not parse task id: $raw" >&2; return 1; }
    printf '%s\n' "$tid"
}
```

## Caller contract

The caller MUST:
1. Author the full brief as a file (convention:
   `<workspace>/<orchestrator-state-dir>/active-missions/<mission-id>/dispatch-brief.md`).
2. Ensure the file's first heading or first paragraph reads as a
   useful one-line summary for `--brief`.
3. Persist the returned task id (convention: write to
   `<mission-folder>/task-id.txt`) and pair with
   `emploke/dispatch-watchdog`.

The skill does not log; logging the dispatch event is the caller's
responsibility (e.g. orchestrator writes to its own decisions log).

## Anti-patterns

- **Do not** call `emploke task dispatch --brief "<entire long
  brief>"` and re-try on rejection. Author the brief in a file from
  the start.

## CHANGELOG

See `CHANGELOG.md` next to this file.
