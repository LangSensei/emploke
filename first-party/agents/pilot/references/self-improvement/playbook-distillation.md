# Playbook distillation

When you do the same thing 3+ times, it's a pattern. Capture it as a reusable playbook so future-you (or future agents) can execute without re-deriving.

## What's a playbook?

A short markdown file in `.pilot/playbooks/<name>.md` describing a repeatable workflow:

- Goal
- Inputs needed
- Steps (with concrete commands / templates)
- Success criteria
- Common pitfalls (from the times you tried it before)

## Triggers to distill

- A mission used the same step sequence as a prior mission, with minor parameter changes
- An agent task instruction has been almost-identical 3+ times
- A hiring + probe + dispatch chain has been repeated for the same role-shape

## Distillation process

1. **Identify the pattern.** Look at recent `progress.md` files across missions. What's repeating?
2. **Extract the variable parts.** What changes between invocations? (Inputs, scope, agent picks.) These become parameters.
3. **Extract the invariant parts.** What's the same every time? These become the playbook body.
4. **Write it.** Use the template below.
5. **Reference it.** Next time the pattern triggers, dispatch with `// follows playbook X` in your reasoning, OR for highly-templated work, use the playbook directly.

## Template

```markdown
# <playbook name>

## Goal
<one-paragraph description of what this accomplishes>

## When to use
- <trigger condition 1>
- <trigger condition 2>

## Inputs (parameters)
- `<param1>`: <type, what it represents>
- `<param2>`: <type, what it represents>

## Outputs
<what you'll have at the end>

## Steps

### 1. <step name>
```sh
# concrete commands with parameters substituted via $VAR
emploke task dispatch --agent <fqn> --brief "<param-using-template>"
```
What to verify: <observable outcome>

### 2. <step name>
...

## Success criteria
- <criterion 1>
- <criterion 2>

## Common pitfalls
- <thing that went wrong before, and how to avoid it>
- ...

## Last invocation
- 2026-05-14 (mission <id>) | success
- 2026-05-15 (mission <id>) | success-with-modifications: <what>
- 2026-05-16 (mission <id>) | failed at step 3 because <reason> → playbook updated
```

## Maintenance

- Append to "Last invocation" each time you use the playbook.
- If you modify the playbook based on a new lesson, bump a small version note at the top: `version: 1.1, updated 2026-05-16: <what changed>`.
- If a playbook hasn't been used in 90 days, archive it to `.pilot/playbooks/_archive/`.

## When NOT to write a playbook

- Single occurrence ("I'll need this someday"). YAGNI. Wait until you actually do.
- Highly variable workflows where each invocation is meaningfully different. Forcing them into a playbook adds friction.
- Workflows that are too short to bother — if it's 2 commands, just remember them.

## Examples of good playbook subjects

- "Onboard a new mission of type X" (recurring mission shape)
- "Replace agent A with agent B without losing in-flight work"
- "Refresh stale data sources" (operations cadence)
- "Quarterly retrospective on missions completed this period"

## Examples of bad playbook subjects

- "Dispatch any task" (too generic)
- "Handle the project we did last week" (too specific)
- "Decide whether to escalate" (judgment, not procedure)
