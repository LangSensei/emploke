# Changelog

## 1.0.0 (2026-06-09)

- Initial release. Strategy skill for the `emploke/coordinator` agent encoding the `dev → review + frontend-designer → iterate until clean` orchestration. Content-only sibling of the generic `emploke/coordinator` skill (no `dependencies:`, no `prereqs:`).
- Five-case classifier (case bank) over own direct parents — `no parents`, `one dev parent succeeded`, `one dev parent failed/cancelled`, `two reviewer parents`, `two reviewer parents any failed/cancelled` — lifted verbatim from the prior 1.0.0 `emploke/coordinator` skill §B.
- Four brief templates (`template-dev-iter-1`, `template-dev-iter-2-plus`, `template-review`, `template-designer`) with `${PLACEHOLDER}` substitution slots, lifted verbatim from the prior 1.0.0 `emploke/coordinator` skill §C. Templates follow the generic skill §D brief-plumbing meta-pattern (workflow context + prior-iter fetch instructions + output protocol; no technical content; no coord interpretation of findings).
- Placeholder resolution table mapping each `${...}` slot to its source (`workflow.show` field, parent task lookup, or DAG-derived counter).
- Stop condition: `finishWorkflow(succeeded)` when both reviewer verdicts parse cleanly AND the union of their `blocker` / `major` findings is empty. No iteration cap in v1.
- Failure-mode coverage matrix: every `(parent role, parent terminal status)` combination the strategy expects matches exactly one case in the bank (or the generic skill §C verdict.json parse failure path). No fall-through cells.
