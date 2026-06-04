# Changelog

## 1.0.1 (2026-06-04)

### Fixed

- Operating-loop pseudocode now lists the correct task-status enum
  (`succeeded,failed,cancelled`); the prior `success,failure,cancelled` values
  are not accepted by the runtime and would cause completion processing to
  silently no-op. (drift audit H1)
- Stylistic: hiring decision tree now uses the canonical bare `file:` form
  for local-agent install — corrected in `AGENTS.md` (one location) and
  `references/hiring/decision-tree.md` (three locations), matching the rest
  of the pilot body and skill docs. (drift audit L1 + agent-lint NIT on PR
  #310)

## 1.0.0

- Initial release under `emploke/pilot`. Migrated from `langsensei/pilot` in the community marketplace and relocated into the emploke first-party catalog.
