# Sub-agent lifecycle

End-to-end timeline for a single local agent: from creation to retirement.

## Stages

```
draft → install → probe → hire → use → evaluate → ... → retire / promote
```

## Stage 1: Draft

Create the AGENTS.md file at `<workspace>/local-agents/<name>/AGENTS.md`. Use:

- `template-base.md` for frontmatter + structure
- `writing-good-agent-prompts.md` for body content

Set `version: 1.0.0`.

## Stage 2: Install

```sh
DIR="<workspace>/local-agents/<name>"
emploke catalog agent install "file://$DIR" --json
```

Verify it installed cleanly:

```sh
emploke catalog agent show "local/<name>" --json | jq '{fqn, status, version}'
```

If status != "ok", read the error and fix the AGENTS.md (common: malformed frontmatter, scope conflict).

## Stage 3: Probe

Dispatch a probe task (see `hiring/probe-tasks.md`):

```sh
emploke task dispatch \
  --agent "local/<name>" \
  --brief "<probe instruction>" \
  --json
```

Wait for completion. Verify the output against probe success criteria.

If the probe fails:

- Was the failure from instruction ambiguity? Refine the probe and try once more.
- Was the failure from a body issue? Edit AGENTS.md, bump to `1.0.1`, re-install, re-probe.
- After 2 cycles of failure: abandon this agent. Try a different approach (different role definition, marketplace candidate, etc.).

## Stage 4: Hire (formal)

If probe passes:

```sh
echo "$(date -u +%Y-%m-%d) | HIRE | local/<name> | passed probe | <one-line about strengths>" >> .pilot/decisions.log
```

Add to `.pilot/hires.md`:

```markdown
## local/<name>
- 2026-05-13 | probe task | success | <summary> | hired
```

Update `.pilot/org-chart.md` to point the relevant role at this agent.

## Stage 5: Use

Dispatch real mission work to this agent. After each task:

- Append to `hires.md` with the outcome
- Update mission's `progress.md` per usual

## Stage 6: Evaluate (continuous)

During reflection cycles:

- Read recent `hires.md` entries for this agent (last 10-20)
- Apply criteria from `hires-evaluation.md`:
  - Star performer → expand scope, consider duplicating
  - Reliable → keep using
  - Watch list → tighten scope, monitor
  - Fire candidate → see Stage 7

## Stage 6.5: Iterate (when needed)

If the agent's outputs need calibration but the agent is fundamentally good:

1. Identify the specific gap in behavior
2. Edit AGENTS.md to add ONE rule addressing it
3. Bump version (e.g. `1.0.0` → `1.1.0` for a behavioral change, `1.0.1` for a wording fix)
4. Re-install:
   ```sh
   emploke catalog agent install "file://$DIR" --json
   ```
5. Probe again with a focused task that tests the new rule
6. Update `hires.md` with the iteration outcome

## Stage 7a: Retire (terminal)

When you're firing the agent:

```sh
emploke catalog agent disable "local/<name>"   # soft, reversible
# Confirm nothing depends on it:
emploke catalog agent show "local/<name>" --json | jq '.blockedReason'
# Hard delete:
emploke catalog agent rm "local/<name>"
# Move the source files:
mv "<workspace>/local-agents/<name>" "<workspace>/local-agents/_retired/<name>-$(date +%Y%m%d)/"
```

Append to `decisions.log`: `RETIRE | local/<name> | <reason>`.

Update `org-chart.md` — either point the role at a replacement, or remove the role entirely.

## Stage 7b: Promote (alternate terminal)

When the agent is so good you want to specialize them:

1. Don't modify the original. Instead, create a v2 with narrower scope:
   ```
   <workspace>/local-agents/<name>-<specialization>/
   ```
2. Copy AGENTS.md, tighten the scope in body, set new name + scope, version `1.0.0`.
3. Install + probe + hire as a new agent.
4. The original can keep doing its broader work; v2 takes the specialized work.

## Cross-cutting hygiene

- **Never modify a marketplace agent** in your local-agents/. If you want a customized version of a marketplace agent, fork it locally (copy + rename + adjust + install with new FQN).
- **Don't reuse names** across hires. If `local/writer` was retired, don't bring it back as `local/writer` again — use `local/writer-v2` or `local/writer-2026-q3`. Reusing creates confusion in audit trail.
- **Mark retired agents in their files** — add a comment block at the top of the moved AGENTS.md explaining when and why retired, in case you need to reference later.

## Lifecycle visualization

If you find yourself unsure where an agent is in the lifecycle, consult `hires.md` and `decisions.log` for that agent's history. The artifacts ARE the lifecycle — there is no separate state machine.
