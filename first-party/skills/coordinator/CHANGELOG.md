# Changelog

## 1.1.0 (2026-06-09)

- **Strategy split.** Moved the strategy-specific case bank and brief templates out of this skill into a sibling strategy skill (`emploke/development-loop`). This skill is now the generic orchestration framework; strategy-specific content lives in per-strategy sibling skills the coord agent declares as deps. Motivation: prior 1.0.0 baked the `dev-review-loop` strategy into this skill, which would have forced every future strategy to be a skill edit; the new shape lets strategies ship as additive sibling skills.
- **Restructured body into five sections** (§A–§E):
  - §A — Operating model (now includes strategy-selection step that picks the strategy from `workflow.metadata.strategy`, brief hint, or the sole strategy declared in the coord agent's deps).
  - §B — DAG introspection patterns (NEW). Reusable jq-style snippets every strategy uses: find own parents, classify a parent `(kind, status, agent, taskId)`, find prior-iter siblings, batch-mutate via `add-subgraph` with tempIds.
  - §C — `verdict.json` schema (unchanged content; moved from old §D; remains the universal output protocol every reviewer-role worker writes).
  - §D — Brief plumbing meta-pattern (NEW). Always-include / never-include / output-protocol / `${PLACEHOLDER}` rules every strategy template must follow.
  - §E — How to author a strategy skill (NEW). Required frontmatter, required body sections (case bank, brief templates, placeholder resolution table, stop condition, failure-mode coverage), and the content-only constraint (no `dependencies:` / `prereqs:`).
- **Removed from this skill** (moved verbatim to `emploke/development-loop`): the 5-case `dev-review-loop` classifier and the 4 brief templates (dev iter-1, dev iter-2+, review, designer).
- Description updated to reflect the generic-framework shape.

## 1.0.0 (2026-06-09)

- Initial release. Bundles the `emploke/coordinator` agent's playbook in four sections:
  - §A — Operating model (9-step wake-up loop).
  - §B — Strategies (v1 ships one strategy, `dev-review-loop`, with a 5-case classifier).
  - §C — Brief templates (verbatim dev iter-1, dev iter-2+, review, and designer briefs with `${PLACEHOLDER}` substitution slots).
  - §D — `verdict.json` schema + parse rules for coord's own verdict consumption.
