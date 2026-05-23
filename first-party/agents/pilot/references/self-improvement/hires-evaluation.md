# Hires evaluation

Read & maintain `.pilot/hires.md` to make hire/fire/promote decisions data-driven.

## What goes in `.pilot/hires.md`

One section per agent (FQN as the heading). Per task completion, append one line:

```
- YYYY-MM-DD | task <tid> | <success|failure|cancelled> | <one-line summary> | mission: <mission-id>
```

Keep it terse. The signal is the pattern across many entries, not the prose of any one.

## Reading the log for evaluation

Periodic question (asked during reflection): **how is this agent doing?**

For each agent, scan the last N entries (say N=20):

- **Success rate**: count successes / total
- **Quality flags**: did multiple entries mention "invented data", "ignored format", "missed scope"?
- **Recency**: are recent entries trending better or worse than earlier ones?
- **Consistency**: are outcomes stable across similar work, or wildly variable?

## Evaluation thresholds (defaults)

You set your own based on mission tempo, but useful defaults:

- **Star performer**: ≥ 90% success rate, no quality flags in last 10 entries
- **Reliable**: 70-90% success, occasional minor flags, predictable
- **Watch list**: 50-70% success, OR pattern of quality flags
- **Fire**: < 50% success, OR any "invented data" / "ignored hard constraint" entry (single instance is enough)

## Actions

- **Star performer**: assign more / harder work; consider duplicating into specialized variants
- **Reliable**: keep using; document their best fit areas in their `hires.md` section header
- **Watch list**: don't expand their scope; investigate why they're slipping (better instructions? wrong agent for the work?)
- **Fire**:
  ```sh
  emploke catalog agent disable "$FQN"   # soft first
  ```
  After confirming nothing depends on it, remove. Append to `decisions.log`:
  ```
  YYYY-MM-DDTHH:MM:SSZ | RETIRE | <fqn> | <reason summary> | replaced by: <new agent or "none yet">
  ```

## Promotion = role expansion or specialization

When a star performer has a clear strength area:

- **Specialization**: create a v2 agent with a tightened scope (`local/report-writer-v2-saas-focused`). The original keeps its current scope; the v2 is for the narrower work.
- **Cross-mission promotion**: assign them to a mission they hadn't worked on, see if they generalize.

Document promotions in `decisions.log`:

```
YYYY-MM-DDTHH:MM:SSZ | PROMOTE | <fqn> | <reasoning>
```

## Don't

- **Don't fire on a single failure** (unless it's a binary trust violation like inventing data). Variance is natural.
- **Don't promote on a single success.** Pattern matters more than instance.
- **Don't keep an agent around for sentimental reasons** ("we built this together"). The company is built to deliver, not to preserve.
- **Don't keep > 3 agents in the same role.** If you have 3 candidates for "writer", one of them is dead weight. Pick the best 1-2 and fire the rest.

## Pro tip

Add a `## <fqn> — assessment` block under each agent's section, updated periodically:

```markdown
## local/report-writer
- 2026-05-14 | task ... | success | ...
- 2026-05-15 | task ... | success | ...
- 2026-05-16 | task ... | failure | invented data
- 2026-05-17 | task ... | success | ...
- 2026-05-17 | task ... | failure | invented data again

### Assessment (2026-05-17)
Star → Watch list → Fire. Inventing data twice in 3 days. Replacing
with local/report-writer-v2 with explicit "no-invented-data" reminder
in the agent body.
```

This makes `hires.md` not just an audit log but a usable reasoning artifact.
