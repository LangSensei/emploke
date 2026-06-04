# Changelog

## 1.0.1 (2026-06-04)

- docs: correct `task rm` semantics to match the CLI's own help text (no longer claims it cancels running tasks) and fix the `--status` flag enum from the non-existent `failure`/`success` values to the actual `failed`/`succeeded`/`cancelled` values, in both `SKILL.md` and `references/workflows.md` (audit-fix follow-up to PR #306).

## 1.0.0

- Initial release under `emploke/cli`. Migrated from `langsensei/emploke-cli` in the community marketplace and relocated into the emploke first-party catalog.
