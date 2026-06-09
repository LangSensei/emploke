# Changelog

## 1.1.0 (2026-06-09)

- **Strategy split.** Added the new strategy skill `emploke/development-loop` to `dependencies.skills` (full GitHub URL form, alongside `emploke/cli` and the generic `emploke/coordinator` skill). With this change the agent loads three skills on wake-up: `cli` (subcommand reference), `coordinator` (generic operating framework — §A operating model with strategy-selection step, §B DAG introspection patterns, §C `verdict.json` schema, §D brief-plumbing meta-pattern, §E how-to-author-a-strategy guidance), and `development-loop` (the v1 strategy skill with the 5-case classifier and 4 brief templates).
- **Updated body Setup + Wake-up loop + Strategy execution sections** to reflect that the agent now loads both the generic skill and one (or more) strategy skills, and that the wake-up loop's step 5 selects the active strategy via the priority `workflow.metadata.strategy` → workflow brief hint → sole-strategy-declared-in-deps fallback. For v1 with a single strategy declared, the fallback path is the common case and no explicit selection signal is required from the workflow creator.
- Body cross-references updated: §B → §C for `verdict.json` schema; "strategy case bank" references now point at the `emploke/development-loop` skill rather than the (now generic) `emploke/coordinator` skill.
- No behavioural change for v1 single-strategy workflows: the agent's runtime decisions are identical to 1.0.0 (the prior `dev-review-loop` content was simply moved from the generic skill into the new strategy skill).

## 1.0.0 (2026-06-09)

- Initial release. Single workflow orchestrator agent for emploke. Declares dependencies on the `emploke/cli` skill (workflow subcommand reference) and the sibling `emploke/coordinator` skill (operating model, strategies, brief templates, and verdict.json schema). Wakes on DAG state changes, classifies own parents, mutates the DAG via `add-subgraph` or terminates via `finish` — never composes technical content.
