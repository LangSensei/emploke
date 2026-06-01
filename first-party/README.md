# first-party  Emploke's bundled catalog

This directory ships the agents, skills, and MCPs that the emploke project itself maintains in lock-step with the codebase. Entries here use `scope: emploke`.

## Why is this in the main repo?

These entries depend on emploke internals (CLI surface, agent frontmatter schema, runtime contracts) tightly enough that they should version-bump and PR together with the code that defines those internals. Living in `packages/`'s neighbor `first-party/` lets schema changes land atomically with corresponding entry updates.

For community-maintained catalog entries, see [emploke-marketplace](https://github.com/LangSensei/emploke-marketplace).

## Install

Same mechanism as marketplace. Use any of:

```
emploke catalog agent install --url https://github.com/LangSensei/emploke/tree/main/first-party/agents/dev
emploke catalog skill install --url https://github.com/LangSensei/emploke/tree/main/first-party/skills/cli
```

The emploke dashboard's "Install from URL" field also accepts these.

## Contents

### Agents

- `emploke/dev`  implements features and fixes for emploke itself
- `emploke/review`  reviews PRs against the emploke codebase
- `emploke/strategist`  proposes architectural direction
- `emploke/pilot`  general orchestrator (recommended starting point for new workspaces)
- `emploke/agent-distill`  distills working catalog patterns into reusable agents/skills
- `emploke/agent-forge`  creates new local agents from briefs
- `emploke/agent-lint`  validates catalog entries against the schema
- `emploke/designer`  iterates on `packages/dashboard` UI against MSW mocks (mock dev server + Playwright screenshots + PRs)

### Skills

- `emploke/cli`  emploke CLI command reference (workspace, agent, task, session, catalog subcommands)
- `emploke/dashboard-dev-loop`  lifecycle for the `packages/dashboard` mock dev server + Playwright screenshot conventions
- `emploke/dispatch-watchdog`  script + pattern for blocking on a long-running task
- `emploke/dispatch-with-details`  pattern for dispatching tasks with structured detail bodies
- `emploke/git-pr`  git branch management and GitHub PR workflow using worktrees
- `emploke/meta-agent-schema`  authoritative frontmatter/layout schema for catalog entries

## Schema

Same as marketplace. See [emploke-marketplace/CONTRIBUTING.md](https://github.com/LangSensei/emploke-marketplace/blob/main/CONTRIBUTING.md) for the rules; only the `scope:` value differs (`emploke` here vs. `langsensei` there).
