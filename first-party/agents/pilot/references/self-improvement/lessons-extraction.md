# Lessons extraction

Turn post-mortems into reusable wisdom. The mechanism that lets the company actually get smarter over time.

## Inputs

- `.pilot/post-mortems/<mission-id>.md` — failure analyses written when missions fail or have notable setbacks
- `.pilot/active-missions/<id>/progress.md` — completed-but-instructive missions that had near-misses
- `.pilot/hires.md` — recurring agent failure patterns

## Output

`.pilot/lessons.md` — append-only collection of one-line wisdom. Future-you reads this before starting any new mission.

## When to extract

- After every mission completion (success or failure)
- After every notable post-mortem
- During idle reflection ticks (if you haven't extracted in a while)

## Extraction process

1. **Identify the surprise.** What did you assume going in that turned out wrong? What did you NOT expect?
2. **Generalize one level.** "The market-data-collector failed on Asian markets" → "Data-collector agents need explicit timezone/region scope."
3. **Make it testable.** "Always check timezone scope when hiring a data-collector" — a future-you can apply this.
4. **One sentence.** If you need a paragraph, you haven't generalized enough.

## Format

```markdown
# Lessons

## 2026-05

- Data-collector agents need explicit timezone/region scope in their probe task — silent regional failures are common.
- For "build a SaaS" missions, dispatch a "user persona" research task BEFORE drafting the landing page. Saves 1-2 redrafts.
- Local agents accumulate quirks across versions. Document those quirks in the agent's body, not in `hires.md` notes — the dispatching pilot needs to see them at use time.

## 2026-06

- Marketplace agents may not be maintained beyond their author's interest. Pin a known-good version (or fork to local) for mission-critical roles.
- The `--purge` flag on `task rm` is irreversible. Always archive (no flag) first; only purge after a confirmed win to free disk.
```

## Anti-patterns in lesson writing

- **Too specific**: "On 2026-05-14, market-data-collector returned wrong data for AAPL because of timezone." → not reusable.
- **Too generic**: "Always test agents before using them." → already a hard rule, not a new lesson.
- **Wrong layer**: a lesson about the user's preferences belongs in `identity.md`, not `lessons.md`. A lesson about workspace state belongs in `decisions.log`.
- **Negative without positive**: "X was bad" without "do Y instead" gives no actionable shape.

## Periodically consolidate

If `lessons.md` has 100+ entries, a quarter or two of accumulated wisdom is in there. Time to extract patterns:

1. Skim all lessons.
2. Group by theme (hiring / dispatch / monitoring / strategy / specific-domain).
3. Write a short prelude per theme summarizing the pattern.
4. Move older detailed lessons into `lessons.md.archive-YYYY-Q`.

This keeps the active `lessons.md` short enough to actually read on every mission start.

## Reading lessons on mission start

Before founding a new mission (during onboarding):

```sh
cat .pilot/lessons.md
```

Decide:

- Are any lessons relevant to this mission?
- Do they suggest specific roles to hire / avoid?
- Do they suggest specific risks to add to `risks.md`?

Update the mission's `risks.md` proactively if lessons surface relevant warnings.

## Cross-mission pollination

Sometimes a lesson learned in mission A is exactly what mission B needs. Consider periodically dispatching a "summarize lessons relevant to mission X" task to a research agent — they can scan `lessons.md` + recent `progress.md` files faster than you can.
