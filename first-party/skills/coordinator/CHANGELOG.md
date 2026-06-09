# Changelog

## 1.0.1 (2026-06-09)

- §A operating-model step 8 and the Decision log explainer now point at `$EMPLOKE_WORKFLOW_DIR/coord-decisions/<utc-iso-timestamp>-$EMPLOKE_NODE_ID.md` instead of `<task-workdir>/coord-decision.md`, so the audit trail is workflow-scoped instead of per-wake-up-fragmented. Step 8 also documents the cross-platform colon-to-dash filename convention. Added a "Reading prior decisions" subsection in §A explaining how to enumerate the directory for iteration counters, backoff, and audit-trail reconstruction (consult-only; never mutate). `verdict.json` and §C parse rules are unchanged.

## 1.0.0 (2026-06-09)

- Initial release. Generic orchestration framework for the `emploke/coordinator` agent: how a coord wake-up is shaped, how to read the DAG, the universal `verdict.json` protocol, the meta-pattern for worker briefs, and the contract a sibling strategy skill must satisfy. Strategy-specific content (case banks, brief templates, stop conditions) lives in per-strategy sibling skills the coord agent declares as deps; this skill stays framework-only.
- Body organised into five sections:
  - §A — Operating model. The 9-step wake-up loop with a strategy-selection step that picks the active strategy from `workflow.metadata.strategy`, an explicit brief hint, or the sole strategy declared in the coord agent's deps.
  - §B — DAG introspection patterns. Reusable snippets every strategy uses: find own parents, classify a parent on `(kind, status, agent, taskId)`, find prior-iter siblings, batch-mutate the DAG via `add-subgraph` with `tempId` references.
  - §C — `verdict.json` schema. The universal output protocol every reviewer-style worker writes, plus the parse rules coord applies.
  - §D — Brief plumbing meta-pattern. Always-include / never-include / output-protocol / `${PLACEHOLDER}` rules every strategy template must follow. Worker FQNs and placeholder slot names belong to strategy skills; the framework illustrates them via generic role nouns only.
  - §E — How to author a strategy skill. Required frontmatter, required body sections (case bank, brief templates, placeholder resolution table, stop condition, failure-mode coverage), and the content-only constraint (no `dependencies:`, no `prereqs:`).
