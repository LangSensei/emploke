# Changelog

## 1.0.0 (2026-06-09)

- Initial release. Single workflow orchestrator agent for emploke. Declares dependencies on the `emploke/cli` skill (workflow subcommand reference) and the sibling `emploke/coordinator` skill (operating model, strategies, brief templates, and verdict.json schema). Wakes on DAG state changes, classifies own parents, mutates the DAG via `add-subgraph` or terminates via `finish` — never composes technical content.
