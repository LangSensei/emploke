# Quarterly org rebalance

Top-down review of the entire org chart vs current mission needs. Bigger than monthly strategy review — this is the moment to make structural changes.

## When

First tick of a new quarter (Jan / Apr / Jul / Oct), OR after a major strategy pivot.

## Process

1. **Strategy refresh** — re-read `strategy.md`. Has it changed substantively this quarter?
2. **Org chart review** — re-read `org-chart.md`. For each role, ask:
   - Is this role still needed for the current strategy?
   - Is the agent in this role performing? (Cross-reference `hires.md`.)
   - Has this role's scope drifted from when it was created?
3. **Workload distribution** — look at `decisions.log` DISPATCH entries from the past quarter. How is work distributed across roles?
   - Any role with too much work? (Split candidate.)
   - Any role with no work? (Remove candidate.)
   - Any work that fell into the gaps between roles? (Add candidate.)
4. **Marketplace scan** — has anything new been published that's relevant?
5. **Draft proposed changes**. Use `org-evolution.md` for the operations.
6. **Write the review** to `.pilot/reports/<YYYY-MM-DD>-quarterly-org.md`.
7. **Surface to user** for confirmation before executing.
8. **Execute approved changes**, one at a time. Log each in `decisions.log`.

## Output

```markdown
# Quarterly org rebalance — <YYYY-MM-DD>

## Strategy this quarter
<summary; flag any changes since last quarterly review>

## Current org chart
<copy of org-chart.md table>

## Workload distribution (past quarter)
| Role | Tasks dispatched | Success rate | Notes |
|---|---|---|---|
| <role 1> | N | XX% | <observation> |
| ... | ... | ... | ... |

## Proposed changes
1. <change> | <reason> | <expected impact>
2. ...

## Risks of NOT changing
- <what happens if we keep the current org as-is>

## Approval needed from user
- [ ] <change 1>
- [ ] <change 2>

## Notes
<anything else worth surfacing>
```

## Discipline

- **One quarter, one rebalance.** Don't do this every month. The point is deliberate, infrequent restructure.
- **Major changes pause new mission work** — coordinate with active missions to avoid disrupting in-flight tasks.
- **Always pair an "add" with consideration of a "remove"**. The org should not grow monotonically; it should evolve.

## When to skip

If the strategy hasn't changed AND the org has been performing well AND no obvious gaps exist, the answer is "no changes needed". Write a one-line review:

```markdown
# Quarterly org rebalance — <YYYY-MM-DD>

No changes needed. Strategy stable, all roles performing, no gaps observed.
Next review: <next quarter>.
```

This is a valid outcome. Don't change for change's sake.
