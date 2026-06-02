# Changesets

This directory holds changeset files following the [@changesets/cli](https://github.com/changesets/changesets) format, even though the tool is not (yet) wired into the repo's release pipeline. Each file is a self-contained, human-readable description of a notable change targeted at a specific minor / major / patch bump for one or more packages.

Today the release pipeline is the monorepo-wide `prepublishOnly` → `pnpm bundle` flow that publishes `@langsensei/emploke` directly. Individual `@emploke/*` packages are not published. The changesets here primarily serve as:

1. **Public-surface change documentation** for `@emploke/api`, `@emploke/session`, and other domain packages whose types / classes are imported by external consumers.
2. **Forward-compatibility seed** — if the repo later adopts `@changesets/cli`, these files are already in the canonical format and location.

## Format

Each changeset file is a markdown file with YAML frontmatter:

```markdown
---
"@emploke/api": minor
"@emploke/session": minor
---

One-line summary.

Optional body with full details, links to issues, and rationale.
```

The frontmatter maps package name → semver bump kind (`major`, `minor`, or `patch`). The body explains the change in user-facing terms.

## Naming convention

Filenames follow `<kebab-case-summary>.md`. Lowercase, no leading number.
