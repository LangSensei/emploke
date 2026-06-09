# Changelog

## 1.1.1 (2026-06-09)

### Fixed

- `references/workflow-commands.md` — `emploke workflow list` section now documents the three optional filter flags (`--q`, `--coordinator-agent`, `--created-since`) that the HTTP surface has supported since the substrate-v3 + coord-capability landings. Before this entry the reference advertised "Args: none" with no optional flags, so the only way to discover the filters was to read `WorkflowListQuery` directly.
- Added a worked example to the `workflow list` section showing how to combine `--coordinator-agent` and `--created-since` to narrow recent runs for one coordinator.

### Notes

- This patch ships alongside the CLI changes in PR #354 (Group C of #352) that wired the same three filter flags into the `workflow list` command and added `--metadata-file` / `--details-file` to `workflow create`. The reference doc had drifted because the underlying CLI was missing the flags; with the CLI fix in the same PR, the doc entries now match the implementation.
- No `SKILL.md` text edits in this bump — only `references/workflow-commands.md`.

## 1.1.0 (2026-06-09)

### Added

- New `references/workflow-commands.md` covering the full `emploke workflow …` subcommand surface (14 subcommands: `list`, `create`, `show`, `dag`, `node-show`, `add-node`, `add-subgraph`, `add-edge`, `remove-node`, `remove-edge`, `replace-spec`, `cancel`, `cancel-node`, `finish`) — flags, HTTP routes, body schemas, response shapes, plus coord introspection / batch-mutation snippets.
- New top-level `## Workflow subcommands` section in `SKILL.md` that points to the new reference file and lists the subcommands at a glance.
- `## Common workflows` index entry retained; workflow CLI gets its own first-class section because it's a distinct caller surface (coord-facing) from the ad-hoc playbooks under `references/workflows.md`.

### Notes

- Reference targets the workflow v2.5 wire surface: `kind: "worker"` (full word) on both write and read paths, `iterationCount?` omitted from the list response, `add-edge` returns `toPhase`, `finish` body uses `failure.kind: "coordinator"`, and the new `node-show` subcommand is included. This skill bump should be merged AFTER the workflow v2.5 cleanup PR lands on `main`.

## 1.0.2 — 2026-06-04

### Fixed

- Canonical `workspace add` snippet in `references/workflows.md` now uses the real `--workspace-dir` flag (was `--workdir`, which Commander rejects and breaks the rest of the onboarding playbook). (drift audit H2)
- `SKILL.md` `emploke health` example no longer claims a JSON `"ok"` payload by default; corrected to the exit-code-only form. (drift audit M1)
- `references/error-codes.md` `WorkspacePathConflictError` remediation column now points to `--workspace-dir` instead of the non-existent `--workdir` flag. (drift audit M2)

## 1.0.1 (2026-06-04)

- docs: correct `task rm` semantics to match the CLI's own help text (no longer claims it cancels running tasks) and fix the `--status` flag enum from the non-existent `failure`/`success` values to the actual `failed`/`succeeded`/`cancelled` values, in both `SKILL.md` and `references/workflows.md` (audit-fix follow-up to PR #306).

## 1.0.0

- Initial release under `emploke/cli`. Migrated from `langsensei/emploke-cli` in the community marketplace and relocated into the emploke first-party catalog.
