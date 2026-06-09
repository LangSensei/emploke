# Changelog

## 1.0.1 (2026-06-09)

- Audit log location moved from `<task-workdir>/coord-decision.md` to `$EMPLOKE_WORKFLOW_DIR/coord-decisions/<utc-iso-timestamp>-$EMPLOKE_NODE_ID.md` so the trail is workflow-scoped instead of per-wake-up-fragmented. Updates the In scope bullet, the Write Access section (per-task-workdir is now scratch-only, with a new per-workflow shared dir bullet for the audit trail), wake-up loop step 8 (including the cross-platform colon-to-dash filename convention), the Decision log subsection (with a pointer to consulting prior wake-ups' files), and the Report pointer. `verdict.json` stays per-worker and is unchanged.

## 1.0.0 (2026-06-09)

- Initial release. Single workflow orchestrator agent for emploke. Wakes on DAG state changes, classifies its own parents against the selected strategy skill's case bank, and either mutates the DAG via `emploke workflow add-subgraph` or terminates it via `workflow finish`. Never composes technical content — workers own quality, the agent owns sequencing and termination.
- Declares `dependencies.skills` on three skills loaded fresh at every wake-up:
  - `emploke/cli` — subcommand reference for the `emploke workflow …` surface the agent calls.
  - `emploke/coordinator` — generic operating framework: §A operating model (with strategy-selection step), §B DAG introspection patterns, §C `verdict.json` schema, §D brief-plumbing meta-pattern, §E how-to-author-a-strategy guidance.
  - `emploke/dev-review-loop` — the v1 strategy skill (case bank, brief templates, placeholder resolution table, stop condition, failure-mode coverage matrix).
- Selects the active strategy via `workflow.metadata.strategy` → workflow brief hint → sole-strategy-declared-in-deps fallback. For v1 with a single strategy declared, the fallback is the common path and no explicit selection signal is required from the workflow creator.
