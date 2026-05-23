# Org evolution

Periodically reshape the organization to fit current mission needs. Don't let yesterday's org chart cap today's productivity.

## Triggers for evolution

- **Mission shift**: the strategy changed; current roles don't fit
- **Capability gap**: you keep needing $X work and have no agent for it
- **Capability redundancy**: agents A and B do near-identical work
- **Workload imbalance**: one role is overloaded, another idle
- **Quality drift**: an agent's quality is dropping (see `hires-evaluation.md`)
- **Quarterly rebalance** (see `rituals/quarterly-org-rebalance.md`)

## Evolution operations

### Splitting a role

When a role has accumulated too much scope:

1. Identify the natural fault line in the work.
2. Create a new local agent for one side.
3. Update `org-chart.md` — original role keeps narrower scope, new role takes the rest.
4. For in-flight tasks, decide: complete with the original agent, or migrate.
5. Append to `decisions.log`: `SPLIT | <original> → <kept-narrow> + <new-role>`.

### Merging roles

When two roles substantially overlap:

1. Identify the common scope.
2. Pick one agent (the better performer) to absorb the merged role.
3. Update `org-chart.md`.
4. Reassign in-flight tasks from the deprecated agent.
5. Disable + remove the deprecated agent.
6. Append to `decisions.log`: `MERGE | <a> + <b> → <kept>`.

### Adding a role

When you find yourself dispatching the same kind of work to ill-fitting agents:

1. Define the new role precisely (use `sub-agent/domains.md`'s 4-question framework).
2. Hire (decision tree).
3. Probe.
4. Add to `org-chart.md`.
5. Append to `decisions.log`: `ADD_ROLE | <role> | <reason>`.

### Removing a role

When a role hasn't seen meaningful work in 30 days OR no longer aligns with mission:

1. Confirm no in-flight tasks depend on it.
2. Disable then remove the agent (`emploke catalog agent disable / rm`).
3. Update `org-chart.md`.
4. Append to `decisions.log`: `REMOVE_ROLE | <role> | <reason>`.

### Replacing an agent for an existing role

(Most common — keep the role, swap the agent.)

1. Identify the new candidate (decision tree).
2. Hire and probe.
3. On probe success, update `org-chart.md` to point the role at the new agent.
4. Disable + remove the old agent.
5. Append to `decisions.log`: `REPLACE_AGENT | role <role> | <old> → <new>`.

## Evolutionary discipline

- **Change one thing at a time.** Don't simultaneously split + merge + add new roles in one cycle. You won't be able to attribute outcomes.
- **Document reasoning.** Every evolution change goes in `decisions.log` with the reason. Future-you needs to understand why the org looks the way it does.
- **Track ROI.** After an evolution change, watch the next mission to see if the change paid off. Append to `lessons.md` if it did or didn't.

## Don't

- **Don't reorg every week.** Constant churn is its own dysfunction. Hard rule: at most one structural evolution per mission cycle (or per week if missions are short).
- **Don't reorg as a substitute for hard work.** "Maybe a different org chart will fix this" is sometimes true and often a procrastination tactic. Be honest with yourself.
- **Don't preserve the org for sentimental reasons.** Roles exist to serve the mission; they're not part of identity.

## Long-term vision

A healthy org evolves slowly but consistently. Over a quarter, you might see:

- Started with: 3 roles
- Q-end: 4 roles (+1 new for emerged need, +1 split, -1 merged)
- Net: same roughly-3-4 roles, but each tuned for current reality

If your org is identical 3 months later, either the mission was perfectly stable (rare) or you're not adapting (more likely — investigate).
