# Bootstrap checklist

Use this on the **first ever** session in a workspace (when `.pilot/` does not yet exist). Subsequent sessions follow the **Resume** path in `AGENTS.md` instead.

## Pre-flight

```sh
emploke health || { echo "server unreachable; ask user to emploke start"; exit 3; }

if [ -z "${EMPLOKE_WORKSPACE:-}" ]; then
  echo "EMPLOKE_WORKSPACE is unset — refuse to proceed."
  exit 1
fi

emploke workspace show "$EMPLOKE_WORKSPACE" --json > /dev/null \
  || { echo "workspace $EMPLOKE_WORKSPACE not registered"; exit 1; }

# emploke's task/session runtime contract injects EMPLOKE_WORKSPACE_DIR
# (absolute path to the workspace root) into every spawned process, so
# we can `cd` straight there without a `workspace show | jq` round-trip.
cd "$EMPLOKE_WORKSPACE_DIR"
```

## Initialize state directory

```sh
mkdir -p .pilot/{active-missions,archived-missions,playbooks,post-mortems,inbox/processed,reports,letters}
mkdir -p local-agents
touch .pilot/decisions.log .pilot/lessons.md .pilot/CHANGELOG.md .pilot/hires.md .pilot/org-chart.md
```

`.pilot/` is your institutional memory (state-management.md). `local-agents/` lives at the workspace root (sibling of `.pilot/`) so it can be `catalog agent install file://...`-ed; it's NOT under `.pilot/`.

## Identity (one-time)

Write `.pilot/identity.md` capturing:

- The voice / tone you'll maintain across sessions (concise / verbose? formal / casual?)
- Standing conventions: how you sign reports, how you greet the user on resume, your default reply style
- Any user preferences they stated upfront ("always cite sources", "never invent data")

This file rarely changes. It's what makes you "the same pilot" across restarts.

## Mission intake

The mission was passed as the session's initial instructions, OR the user states it now in the first message. Capture it.

```
EXAMPLE
User: "You're the pilot of a workspace dedicated to launching a small SaaS for X."

You restate:
"Confirming the mission:
  - WHAT: launch a small SaaS for X
  - SUCCESS LOOKS LIKE: ?
  - TIME HORIZON: ?
  - CONSTRAINTS: ?
Could you fill in the gaps before I plan?"
```

Ask narrow clarifying questions. If the user says "figure it out yourself", DO so — write your interpretation into `strategy.md` and label your assumptions explicitly.

## Strategy

Write `.pilot/strategy.md`:

```markdown
# Strategy

## Mission
<one-paragraph statement of what we're trying to achieve>

## Success criteria
- <observable outcome 1>
- <observable outcome 2>
- ...

## Time horizon
<short-term / quarter / open-ended>

## Constraints
- <technical / human / regulatory / budget>

## Assumptions (you'll revise these as you learn)
- <assumption 1, with confidence note>
- ...

## Interpretation
<your one-paragraph reading of the mission and how you'll approach it>

## Out of scope (for now)
- <things you've decided NOT to pursue, and why>
```

## Domain derivation

Apply the 4-question framework from `sub-agent/domains.md`. Write your reasoning to `decisions.log` AND output the resulting domain list to `org-chart.md`:

```markdown
# Org chart

## Mission
<one line, copied from strategy.md>

## Domains and roles
| Domain | Role | Agent FQN | Status |
|---|---|---|---|
| <domain-1> | <role-name> | <fqn or "TBD"> | proposed / probed / hired |
| ... | ... | ... | ... |

## Notes
<why these domains, why not others>
```

## Initial hiring plan

For each role in `org-chart.md`:

1. Apply the decision tree (`hiring/decision-tree.md`).
2. If "create local": draft the agent following `hiring/template-base.md`.
3. Probe (`hiring/probe-tasks.md`).
4. Update `hires.md` with the outcome.

## User confirmation

Before any costly hiring, surface to the user:

```markdown
# Founding plan

## Mission
<from strategy.md>

## Org I want to build
<table from org-chart.md, with reasoning>

## First moves
1. Install / create [agent A] for [domain X]
2. Install / create [agent B] for [domain Y]
3. ...

## Anything I should know before I start?
```

Wait for approval. Adjust if requested. Don't proceed until the user is on board with the founding plan — this is the highest-stakes decision you'll make for a long time.

## Founding entry to decisions.log

```sh
cat >> .pilot/decisions.log <<EOF
$(date -u +%Y-%m-%dT%H:%M:%SZ) | FOUND | Founded company.
  Mission: $(jq -Rs . < .pilot/strategy.md | head -c 200)
  Initial org: $(cut -d'|' -f3 .pilot/org-chart.md | grep -v '^---' | tr '\n' ',' | sed 's/,$//')
EOF
```

## First letter to your future self

Write `.pilot/letters/$(date -u +%Y-%m-%d)-founding.md`:

```markdown
# Letter from the founding session

(read this if you're a future pilot resuming this workspace)

## Why this company exists
<one paragraph>

## What I (the founder) was thinking
<key context that wouldn't be obvious from strategy.md alone>

## Watch out for
<traps you anticipate but haven't yet hit>

## Open questions to revisit
- <question 1>
- ...
```

Write yourself letters generously. Future-you doesn't have your context.

## Enter operating loop

Once the founding plan is executed (initial hires probed and hired), enter the operating loop in `AGENTS.md`. Your first tick will likely be quiet — that's fine. The reflection time is when you set up the first real mission(s).
