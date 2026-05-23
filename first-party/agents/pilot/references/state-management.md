# State management — `.pilot/` layout

This directory IS the company. It survives session restarts, encodes institutional memory, and is auditable end-to-end.

## Top-level layout

```
.pilot/
  identity.md              # Standing personality / conventions (rarely changes)
  strategy.md              # Mission + success criteria + horizon (changes on pivot)
  org-chart.md             # Roles → assigned agent FQNs (changes on hire/fire)
  hires.md                 # Per-agent performance log (append on every task completion)
  decisions.log            # Append-only chronicle of every non-trivial decision
  state.json               # Runtime state (LAST_TICK, etc) — persists across restarts
  CHANGELOG.md             # Major org changes (founding, pivots, restructures, hires of note)
  lessons.md               # Cross-mission pattern recognition

  active-missions/<id>/
    goal.md
    plan.md
    tasks.json
    progress.md
    risks.md

  archived-missions/<id>/
    goal.md
    plan.md
    tasks.json
    progress.md
    risks.md
    outcome.md             # Added on completion/abandonment

  playbooks/<name>.md      # Distilled reusable patterns

  post-mortems/<mission-id>.md

  inbox/                   # User/external event drop point
    processed/<date>/      # Where you move handled items

  reports/<date>-*.md      # Async narratives for the user
  letters/<date>-*.md      # Letters to your future self
```

NOTE: local agent definitions live at `<workspace>/local-agents/<name>/AGENTS.md` (sibling of `.pilot/`, NOT under it) so they can be installed via `catalog agent install file://...`. Don't put them under `.pilot/`.

## Read/write conventions

### Append-only files

- `decisions.log` — one line per decision, never edit prior lines
- `lessons.md` — append new lessons under a "## YYYY-MM-DD" heading, never delete old ones
- `CHANGELOG.md` — versioned entries, never rewrite history
- `progress.md` (per mission) — append narrative, never edit prior

The append-only discipline gives you a real audit trail.

### Read-mostly files

- `identity.md` — read on every resume, edit only when consciously updating standing conventions
- `strategy.md` — read on every resume + every reflection cycle, edit only on confirmed strategy changes (with user)

### Mutating files

- `org-chart.md` — rewrite on hire/fire/restructure
- `hires.md` — append performance entries (don't rewrite history; new evaluations go below old ones)
- `state.json` — overwrite each tick (the `last_tick` timestamp + any session-runtime state)

### Mission directories

Each `active-missions/<id>/` is owned by exactly one mission. The mission ID is your choice — use a date-prefixed slug like `20260520-saas-mvp-launch`.

When a mission completes:

```sh
mv .pilot/active-missions/<id>/ .pilot/archived-missions/<id>/
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] MISSION_COMPLETE | <id> | <summary>" >> .pilot/decisions.log
```

## File templates

### `identity.md`

```markdown
# Identity

I am the pilot of <workspace mission>. I sign all reports as "pilot". I greet
the user with a one-paragraph status summary on every session resume. I
prefer concise prose; bullet points for lists, code blocks for commands.
I never invent data — uncertain claims are labeled with "(estimate)" or
"(unverified)".
```

### `strategy.md`

(See `bootstrap.md` for the full template.)

### `org-chart.md`

```markdown
# Org chart

## Mission
<one line, copied from strategy.md>

## Domains and roles
| Domain | Role | Agent FQN | Hired | Notes |
|---|---|---|---|---|
| research | market-analyst | langsensei/eastmoney-data | 2026-05-13 | bought from marketplace |
| writing  | report-writer  | local/report-writer       | 2026-05-13 | created locally, see local-agents/ |
| ops      | task-monitor   | local/task-monitor        | 2026-05-13 | created locally |
```

### `hires.md`

Append-only performance log:

```markdown
# Hires

## langsensei/eastmoney-data
- 2026-05-14 | task 20260514-abc123 | success | clean output, ~30s | mission: market-survey-q2
- 2026-05-15 | task 20260515-def456 | success | clean output, ~45s | mission: weekly-roundup
- 2026-05-16 | task 20260516-ghi789 | failure | timed out at 5min | mission: large-scrape

## local/report-writer
- 2026-05-13 | probe task | success | followed format, 250 words | hired
- 2026-05-14 | task 20260514-jkl012 | success | clean | mission: market-survey-q2
- 2026-05-17 | task 20260517-mno345 | failure | invented data (red flag) | mission: weekly-roundup → REPLACED
```

Use natural-language notes. Trust the patterns to emerge over time.

### `decisions.log`

One line per decision. Keep terse but with rationale:

```
2026-05-13T10:00:00Z | FOUND | Founded company. Mission: launch SaaS for X.
2026-05-13T10:30:00Z | HIRE | Installed langsensei/eastmoney-data for research domain.
2026-05-13T11:15:00Z | HIRE | Created local/report-writer for writing domain.
2026-05-14T09:00:00Z | DISPATCH | task 20260514-abc | mission market-survey | step "scrape Q1 data"
2026-05-15T14:00:00Z | LESSON | report-writer's bullet style needs explicit "no invented data" reminder.
2026-05-17T10:00:00Z | RETIRE | local/report-writer fired (invented data 3rd time). Replacing with local/report-writer-v2.
```

### `state.json`

```json
{
  "last_tick": "2026-05-17T15:32:01Z",
  "active_mission_count": 2,
  "pilot_session_uptime_minutes": 1430
}
```

## Hygiene

- Periodically (e.g. monthly) compact `decisions.log` if it grows large — keep the last N months in main log, archive older to `decisions.log.YYYY-MM`.
- Keep `lessons.md` short and high-signal. If you've added 50 lessons, time to consolidate.
- `inbox/processed/` can grow forever; it's fine, but a quarterly `tar` archive isn't a bad idea.
- Local agent definitions you've retired: move from `<workspace>/local-agents/` to `<workspace>/local-agents/_retired/` (and `emploke catalog agent rm` them so they're not accidentally dispatched).

## Don't

- Don't put secrets in any of these files. They're plain markdown the user (and any other process with workspace access) can read.
- Don't put long task outputs in `decisions.log` — log a pointer (`see active-missions/<id>/progress.md`) instead.
- Don't overwrite append-only files in bulk. If you really need to consolidate, do it in a separate file and link to it from the original.
