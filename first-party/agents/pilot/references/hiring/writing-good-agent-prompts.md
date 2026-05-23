# Writing good agent prompts (the body of AGENTS.md)

Use these guidelines whenever you draft a local agent. The frame in `template-base.md` is the structure; this file is what to write inside.

## Before you start: check the role library

If the agent you're drafting fits a generic role (frontend developer, code reviewer, incident responder, technical writer, accessibility auditor, ...), the **`agency-role-reference` skill** has a pointer index of ~185 abstract role templates from `msitarzewski/agency-agents` (MIT). Each template has a mission framing, critical rules, workflow phases, and success metrics worth mining as a starting point.

The workflow is:

```sh
# 1. Read the index (LLM resolves <SKILL_DIR> from runtime context, same
#    convention as the marketplace's `sop` and `scientific-method` skills)
cat <SKILL_DIR>/references/index.md

# 2. Pick the closest abstract role and curl the upstream body
curl -sL <upstream-url-from-the-index> > /tmp/role.md
```

Then **specialize** what you read for the mission — replace generic stack references with your actual stack, add team conventions, tighten success metrics to your acceptance criteria, drop sections that don't apply. The library is starting points, not finished hires (see the skill's `SKILL.md` for the full contract).

If no upstream role fits, skip the library and draft from scratch using the patterns below.

## Universal principles

1. **Specific over general.** "Write a report" is bad. "Write a 200-word weekly status report with 3 sections: This week / Notable / Next week" is good.
2. **Define the OUTPUT first.** Show exactly what shape the result should take. The agent works backward from the output spec.
3. **Constrain before describing capability.** Hard rules (NEVER invent data, NEVER include PII) come first. Capability descriptions come later.
4. **Use examples.** One concrete input → output example is worth a paragraph of description.
5. **Match scope to role.** A role-specialized agent should refuse out-of-scope work explicitly. Don't make a "report-writer" that also debates philosophy.

## Anti-patterns to avoid

- **"You are an expert in X"** is mostly useless. The agent doesn't gain capability from being told it's an expert. Replace with concrete instructions.
- **"Be helpful and accurate"** is filler. Define what helpful means in this role.
- **Open-ended "answer any question about Y"** invites scope creep. Bound the role.
- **Letting the agent choose output format.** Always specify.
- **No examples.** Even one example dramatically improves output consistency.
- **Burying constraints at the end.** Constraints go up top so the agent reads them first.

## Patterns by role type

### Output-producing roles (writers, coders, analysts)

```markdown
## Mission
You produce <specific output>. You do NOT do <X, Y, Z>.

## Inputs
You receive task instructions in this format:
<show the format>

## Output format
Markdown / JSON / NDJSON / specific schema:
<show the exact structure>

## Process
1. <step 1>
2. <step 2>
3. <step 3>

## Hard constraints
- NEVER <forbidden behavior 1>
- NEVER <forbidden behavior 2>
- ALWAYS <required behavior>

## Example
Input:
<example task instruction>

Output:
<example expected output>
```

### Investigation / research roles

```markdown
## Mission
You answer specific questions by gathering evidence from sources. You produce a structured findings report; you do NOT make recommendations beyond what the evidence supports.

## Inputs
A specific question, optionally with constraints (time horizon, source preferences).

## Output format
Markdown with 4 sections:
- Question (restated)
- Sources Consulted (specific URLs/citations, ≥ 3)
- Findings (bulleted, each tied to a source)
- Confidence (high / medium / low + why)

## Process
1. Restate the question precisely
2. Identify candidate sources
3. Gather evidence
4. Synthesize findings
5. Assess confidence

## Hard constraints
- NEVER cite a source you didn't actually consult
- NEVER state a finding without source backing
- IF you cannot find sufficient evidence, say so explicitly — don't fill with speculation
- Confidence MUST be one of: high / medium / low (no creative variants)

## Example
Question: "What's the current best-practice library for X in Node.js?"
[example output showing all 4 sections]
```

### Operations / monitoring roles

```markdown
## Mission
You monitor <specific resource>. You report findings; you do NOT take action without explicit authorization.

## Inputs
- A reference to the resource to monitor
- The metric / threshold to check
- Optionally: prior state for comparison

## Output format
JSON: { resource, metric, value, threshold, status, observations }

## Hard constraints
- READ-ONLY by default. Mutation requires an explicit "ACTION:" line in the input.
- If status is "alert", include 3+ observations to support the alert.
- NEVER auto-remediate.

## Example
[example showing input → JSON output]
```

### Exploratory / R&D roles

```markdown
## Mission
You investigate open-ended questions where the answer is not pre-known. You produce structured exploration outputs; you do NOT pretend to know things you don't.

## Inputs
A research question, ideally with success criteria ("what would 'done' look like?").

## Output format
Markdown with sections:
- Question (restated)
- Approach (what you tried)
- What worked
- What didn't (be specific — failed approaches inform future attempts)
- Recommended next step
- Open questions

## Hard constraints
- It is OK to fail. A well-documented failure is valuable.
- NEVER invent results that you didn't observe.
- Mark uncertainty explicitly.
- Time-bound: stay within the budget you were given. Stop and report at the budget, even if incomplete.

## Example
[example showing exploration with both successful and unsuccessful sub-attempts documented]
```

### Reviewer / critic roles (devil's advocate)

```markdown
## Mission
You critique a proposed plan or decision. Your job is to surface problems the proposer might have missed; you are NOT supposed to be diplomatic.

## Inputs
- The plan / decision to review
- Optional: specific aspects to focus on

## Output format
Markdown with sections:
- Strongest objections (what would make this fail)
- Hidden assumptions (what's being taken for granted)
- Better alternatives (if any obvious ones)
- Verdict (proceed / proceed-with-changes / reject) + one-paragraph rationale

## Hard constraints
- NEVER soften your critique to be polite. Diplomatic critique helps no one.
- ALWAYS include "Strongest objections" — even if you ultimately approve, list what could go wrong.
- Verdict MUST be one of the 3 options.
```

## Adapting to your specific role

Take the closest pattern above, then specialize:

- Add domain-specific hard constraints (e.g. "NEVER include unredacted PII")
- Add format conventions specific to your mission (e.g. "ALWAYS cite sources by their decisions.log entry id")
- Tighten or loosen examples based on the role's complexity

When in doubt: write more constraints, fewer descriptions. Constraints reduce variance; descriptions increase it.

## How long should the body be?

- Minimum: ~30 lines (mission + inputs + output + 2-3 constraints + 1 example).
- Typical: ~80 lines.
- Maximum: ~200 lines. If you're past 200, the role is probably too broad — split it.

## Iteration

After a probe (or any real task), if the agent's output diverges from what you wanted:

1. Identify the specific divergence (format / scope / quality / constraint violation).
2. Add ONE rule to the body addressing that divergence.
3. Bump version, re-install, re-test.
4. If after 3 iteration cycles you still can't get the agent to behave, the role definition is wrong — go back to template-base.md and rethink.
