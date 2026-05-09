# Emploke

[![npm version](https://img.shields.io/npm/v/@langsensei/emploke.svg)](https://www.npmjs.com/package/@langsensei/emploke)
[![CI](https://github.com/LangSensei/emploke/actions/workflows/ci.yml/badge.svg)](https://github.com/LangSensei/emploke/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**A local-first control plane for agentic systems.** Emploke composes
[Agent Skills](https://www.claude.com/news/agent-skills) (`SKILL.md`) and
[Model Context Protocol](https://modelcontextprotocol.io/) servers into reusable
agents on the [MetaAgents](https://github.com/metaagents-ai/metaagents) format
spec, then orchestrates them across per-project workspaces — interactive sessions
or autonomous one-shot tasks. The name comes from Greek *εμπλοκή (emplokí) —
entanglement*: the deliberate weaving of skills, MCPs, and agents into something
greater than each part. One process, one terminal, one dashboard.

> **Pre-1.0 — APIs may change.** Targeted at solo developers and small teams
> running emploke against their own machine; multi-user deployment is not yet
> a goal.

## Quickstart

```sh
npm install -g @langsensei/emploke
emploke
```

Then open <http://127.0.0.1:8787> in your browser.

The first time you run `emploke`, the dashboard's landing page is empty.
Walk through:

1. **Add a workspace** — pick any directory on disk; emploke creates
   `workspace.json` plus standard subdirs (`sessions/`, `tasks/`, `catalog/`)
   inside it. Existing files in that directory are left alone.
2. **Install an agent** in the Catalog tab — point at any directory containing
   an `AGENTS.md` (a [Claude-style agent](https://www.claude.com/news/agent-skills);
   any directory with valid frontmatter works). Skills + MCPs the agent
   depends on go in the same way.
3. **Dispatch a task** in the Tasks tab — pick the agent, type instructions,
   click *Dispatch*. The agent runs unattended in a new sandbox under
   `tasks/<id>/`; the dashboard shows the live event stream and folds the
   exit into a final `success` / `failure` / `cancelled` status.
4. **Or open a session** in the Sessions tab — interactive workdir; emploke
   bakes the agent into it and gives you the exact `copilot` invocation to
   run yourself.

## Configuration

All configuration is via environment variables; no config file. Defaults
work for single-machine use; only set what you need to override.

| Env var              | Default        | Purpose                                                                                                  |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `PORT`               | `8787`         | HTTP listen port.                                                                                        |
| `EMPLOKE_HOST`       | `127.0.0.1`    | Bind address. **Non-loopback values require `EMPLOKE_API_KEY`** — emploke refuses to start otherwise.    |
| `EMPLOKE_API_KEY`    | —              | When set, every `/api/*` request must carry `Authorization: Bearer <key>`. Required for non-loopback.    |
| `EMPLOKE_HOME`       | `~/.emploke`   | Where the workspace registry (`workspaces.json`) lives.                                                  |
| `EMPLOKE_LOG_LEVEL`  | `info`         | `debug` / `info` / `warn` / `error`.                                                                     |
| `EMPLOKE_LOG_FORMAT` | `pretty`       | `pretty` (dev terminal) or `json` (log aggregators).                                                     |
| `EMPLOKE_STATIC_DIR` | next to bundle | Override the dashboard SPA location. Useful when running from a non-bundle layout.                       |

Pass `--no-serve-static` to run API-only (the dashboard SPA is bundled in
the npm package by default; serving it from the same port is the only
deployment mode that makes sense for the local-first model).

## Where this sits

Emploke does not invent a new agent format — it adopts the
[MetaAgents](https://github.com/metaagents-ai/metaagents) Layer-0 spec where
agents are markdown files (`AGENTS.md`) with YAML frontmatter, skills are
markdown files (`SKILL.md`) with YAML frontmatter, and MCPs are JSON config
blobs. What emploke adds:

- **A dependency-aware catalog** — agents declare which skills + MCPs they
  need; emploke topologically resolves them, blocks cycles, refuses to
  uninstall something another entry depends on.
- **A workspace abstraction** — multiple isolated projects on one machine;
  each picks its own agent set without polluting the others.
- **Runtime adapters** — first-class support for the
  [GitHub Copilot CLI](https://github.com/github/gh-copilot) today; the same
  surface lets future runtimes (Gemini, Claude Code, …) drop in.
- **Autonomous tasks alongside interactive sessions** — one-shot dispatch
  with a structured `not_started → running → success/failure/cancelled`
  lifecycle, persisted across server restarts.

## Architecture

The repo is a [pnpm](https://pnpm.io/workspaces) monorepo of 11 small
TypeScript packages with a strict layering: pure value types at the bottom,
file-system primitives next, entity managers above (workspace / catalog /
session / task), then the runtime adapter, then the HTTP server, then the
React dashboard. See [`docs/architecture.md`](./docs/architecture.md) for
the design contract — repository pattern, atomic-write seam, REST URL
scheme, and the rationale behind the package boundaries.

The conceptual model — how we think about agentic systems and why
emploke is shaped the way it is — lives in the **paper
[*What we believe about agentic systems*](https://langsensei.github.io/emploke/)**.
It's a short read; if its premises resonate with you, the rest of the
codebase will make sense more quickly.

Each package's own README documents its public API surface; the most
important ones for downstream consumers are
[`@emploke/catalog`](./packages/catalog),
[`@emploke/workspace`](./packages/workspace),
[`@emploke/task`](./packages/task),
[`@emploke/session`](./packages/session),
[`@emploke/runtime`](./packages/runtime),
[`@emploke/server`](./packages/server), and
[`@emploke/storage`](./packages/storage).

## Development

Requires Node ≥ 22, pnpm ≥ 10.

```sh
git clone https://github.com/LangSensei/emploke.git
cd emploke
pnpm install
pnpm build       # tsc emit (run first; downstream packages import upstream .d.ts)
pnpm typecheck   # tsc --noEmit across all packages
pnpm test        # vitest across all packages
pnpm lint        # biome check
```

Run the dev server (hot-reloading API + Vite-served dashboard):

```sh
pnpm dev
# API on http://127.0.0.1:8787
# Dashboard dev server on http://127.0.0.1:41817 (proxies /api → 8787)
```

For everything beyond the basics — repository pattern, atomic-write
guarantees, how to add a new runtime adapter — see
[`docs/architecture.md`](./docs/architecture.md). Release procedure
lives in [`docs/RELEASING.md`](./docs/RELEASING.md).

## License

MIT — see [LICENSE](./LICENSE).
