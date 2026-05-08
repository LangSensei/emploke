# Emploke

> *From εμπλοκή (emplokí) — entanglement.*
>
> A TypeScript toolkit for managing and orchestrating agentic systems built on the [MetaAgents](https://github.com/metaagents-ai/metaagents) format spec — composing [Agent Skills](https://www.claude.com/news/agent-skills) (`SKILL.md`) and [Model Context Protocol](https://modelcontextprotocol.io) servers into reusable Agents.

## Packages

| Package | Description |
|---|---|
| [`@emploke/task`](./packages/task) | Pure value type + state machine for the five-state task lifecycle (`not_started → running → success / failure / cancelled`). Zero I/O. |
| [`@emploke/catalog`](./packages/catalog) | File-system registry of skills, MCPs and agents with dependency-graph algorithms (topological resolve, cycle detection, reverse-dependency safety on uninstall). |
| [`@emploke/session`](./packages/session) | Per-session workdir registry under `~/.emploke/sessions/<id>/`. |
| [`@emploke/runtime`](./packages/runtime) | Runtime adapter interface (`provision` / `refresh` / `buildLaunch` / `deleteState`) + Copilot CLI implementation. |
| [`@emploke/terminal`](./packages/terminal) | Cross-platform terminal spawner that hosts a `LaunchCommand`. |
| [`@emploke/server`](./packages/server) | Hono-based HTTP API exposing catalog / sessions / runtimes. Loopback-only by default. |
| [`@emploke/dashboard`](./packages/dashboard) | React + Vite dashboard, talks to `@emploke/server`. |

All packages are pre-1.0.

## Design

The repo is a pnpm monorepo. [`@emploke/catalog`](./packages/catalog) owns the local marketplace directory of skills + MCPs and its dependency graph (resolve in topological order, reject cycles, block uninstall when something still depends on you). The other packages layer on top: [`@emploke/task`](./packages/task) is the pure five-state lifecycle; [`@emploke/session`](./packages/session) maps each session to a workdir; [`@emploke/runtime`](./packages/runtime) adapts third-party CLIs; [`@emploke/server`](./packages/server) + [`@emploke/dashboard`](./packages/dashboard) expose everything as a single-user local control plane; [`@emploke/terminal`](./packages/terminal) hosts the launched CLI in a real terminal window.

See the [design book](https://langsensei.github.io/emploke/) for the language-neutral Layer 1 axioms (Capability / Agent / Task / Runtime), the Concurrency Contract, and the Observability floor these packages aim to honour. The book's *Positioning* chapter spells out where each package sits relative to MetaAgents (Layer 0) and to emploke's L1–L4 evolution roadmap.

## Development

This repo is a [pnpm workspace](https://pnpm.io/workspaces). Requires Node ≥ 22, pnpm ≥ 10.

```sh
pnpm install
pnpm build       # tsc emit (run first; downstream packages import upstream .d.ts)
pnpm typecheck   # tsc --noEmit across all packages
pnpm test        # vitest across all packages
pnpm lint        # biome check
```

## Design book

The architectural rationale — Capability / Agent / Task / Runtime axioms, six-state Task lifecycle, Concurrency Contract, Observability floor — lives in [`docs/index.html`](docs/index.html).

Read online: **<https://langsensei.github.io/emploke/>**

The book is bilingual (English + 中文).

## License

MIT
