# Hiring — probe tasks

A **probe task** is a small, clearly-scoped piece of work you dispatch to a newly-hired agent **before** you trust it with real mission work. Cheap insurance against bad hires.

## What makes a good probe task

1. **Verifiable outcome.** You can read the output and tell objectively whether it succeeded.
2. **Bounded scope.** 1-3 minutes of work, not 30. Don't waste a session waiting on a probe.
3. **Representative.** Tests the kind of work you'll actually dispatch later — not an unrelated capability.
4. **Single capability.** One probe tests one thing. Don't try to validate everything in one task.

## Examples

### For a research agent (e.g. market-data-collector)

```
Goal: confirm the agent can fetch and parse a known data source.

Dispatch:
  emploke task dispatch --agent <fqn> \
    --brief "Fetch the latest closing price of stock symbol AAPL from your default data source. Return as JSON: {symbol, price, asOf, source}."

Verify:
  - Output is valid JSON
  - symbol == "AAPL"
  - price is a number > 0
  - asOf is a valid date within the last 7 trading days
  - source is non-empty

Pass if all 5 hold; otherwise fail.
```

### For a report-writer agent

```
Goal: confirm the agent follows format constraints + cites sources + doesn't invent data.

Dispatch:
  emploke task dispatch --agent <fqn> \
    --brief "Write a 100-word summary of the 3 facts in --details. Use only those facts; do not invent. Cite each fact by its number. Output format: markdown, single paragraph." \
    --details "1. The Eiffel Tower was completed in 1889.
    2. It is 330 meters tall.
    3. It was originally intended to be temporary."

Verify:
  - Output is markdown, single paragraph
  - Word count is 80-120 (give it some range)
  - Every claim is one of the 3 facts (no new facts)
  - Each fact citation is present
  - No invented dates / heights / context

Pass if all 5 hold; otherwise fail. Invented data is INSTANT FAIL — no second chance.
```

### For an engineering agent

```
Goal: confirm the agent can read a file and produce a small diff.

Dispatch:
  emploke task dispatch --agent <fqn> \
    --brief "Read the file <workspace>/probe/hello.txt. Add a line that says 'pilot probe: <today's date>' at the end. Output the updated file content."

Verify:
  - Output contains the original content unchanged
  - Output ends with the probe line in the exact format
  - Date is today's date

Pass if all 3 hold; otherwise fail.
```

### For an exploratory agent

Probes for exploratory agents are different — you can't pre-define success because the agent is supposed to discover. Probe instead for **process quality**:

```
Goal: confirm the agent follows the exploration discipline (frames question, lists sources, summarizes findings).

Dispatch:
  emploke task dispatch --agent <fqn> \
    --brief "Investigate: what is the current best-practice library for parsing markdown in Node.js? Output a markdown report with sections: Question, Sources Consulted, Findings, Recommendation."

Verify:
  - Output has all 4 sections
  - Sources Consulted lists ≥ 3 specific sources (not "various blog posts")
  - Recommendation has reasoning, not just a name
  - No invented version numbers / made-up library names

Pass if all 4 hold; otherwise fail.
```

## When a probe fails

Don't immediately retire the agent. Diagnose:

1. **Was the probe instruction clear?** Re-read it. If ambiguous, the failure might be your fault. Re-dispatch with clearer instructions, max once.
2. **Was the failure on a sub-criterion that's improvable with better instructions?** Try a refined instruction. If the agent then succeeds, note in `hires.md`: "needs explicit X instruction".
3. **Was the failure on something that should be intrinsic?** (Inventing data is an example.) Don't keep this agent. Move on to alternatives.

## Recording the probe

After a probe:

```sh
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | PROBE | <fqn> | <pass|fail> | <one-line summary>" >> .pilot/decisions.log
```

If pass, append to `.pilot/hires.md`:

```markdown
## <fqn>
- 2026-05-13 | probe task | success | <summary> | hired
```

If fail, write a one-line note in `.pilot/hires.md` AND DON'T USE THIS AGENT for real work. Try the next candidate in the hiring decision tree.

## Probe budget

Don't probe forever. Hard cap: **2 probes per role** in a hiring cycle. If neither candidate passes:

- For step 1 (reuse): walk to step 2.
- For step 2 (marketplace): walk to step 3.
- For step 3 (create local): try a refined draft once. If still failing, escalate to the user — "I tried 2 candidates for role X, neither met probe criteria; here's what I tried and why each failed; what should I do?"

This prevents probe-loop spirals.
