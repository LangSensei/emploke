# Emploke

> *From εμπλοκή (emplokí) — entanglement.*
>
> A TypeScript toolkit for managing and orchestrating agentic systems built on the [MetaAgents](https://github.com/metaagents-ai/metaagents) format spec — composing [Agent Skills](https://www.claude.com/news/agent-skills) (`SKILL.md`) and [Model Context Protocol](https://modelcontextprotocol.io) servers into reusable Agents.

## Packages

| Package | Description |
|---|---|
| [`@emploke/task`](./packages/task) | Pure value type + state machine for the five-state task lifecycle (`not_started → running → success / failure / cancelled`). Zero I/O. |
| [`@emploke/paths`](./packages/paths) | Pure resolver from `process.env` to emploke's user-level filesystem layout (`EMPLOKE_HOME`, registry file, default workspace dir). |
| [`@emploke/catalog`](./packages/catalog) | File-system registry of skills, MCPs and agents with dependency-graph algorithms (topological resolve, cycle detection, reverse-dependency safety on uninstall). One catalog per workspace. |
| [`@emploke/workspace`](./packages/workspace) | Per-project root holding the workspace's catalog plus ephemeral state (sessions / tasks / workflows / logs), plus a `$EMPLOKE_HOME`-level registry mapping kebab-case names to absolute paths. |
| [`@emploke/runtime`](./packages/runtime) | Runtime adapter interface (`provision` / `refresh` / `buildLaunch` / `deleteState` / optional `registerWorkspace`) + Copilot CLI implementation. |
| [`@emploke/session`](./packages/session) | Per-session workdir registry under `<workspace>/sessions/<id>/`, parameterised over a runtime registry. |
| [`@emploke/terminal`](./packages/terminal) | Cross-platform terminal spawner that hosts a `LaunchCommand`. |
| [`@emploke/server`](./packages/server) | Hono-based HTTP API exposing workspace-scoped catalog and session routes (`/api/workspaces/<name>/{catalog,sessions}/...`). Loopback-only by default. |
| [`@emploke/dashboard`](./packages/dashboard) | React + Vite dashboard with a workspace switcher in the sidebar; talks to `@emploke/server`. |

All packages are pre-1.0.

## Layout

```
$EMPLOKE_HOME/                       (default ~/.emploke; override with EMPLOKE_HOME)
└── workspaces.json                  registry: kebab-case name -> absolute path

<workspace>/                         absolute path; user-chosen, or auto-created at
                                     $EMPLOKE_HOME/workspaces/default
├── workspace.json                   self-describing metadata (name, schemaVersion, defaults)
├── catalog/                         per-workspace skills, agents, mcps
│   ├── skills/<name>/SKILL.md
│   ├── agents/<name>/AGENT.md
│   └── mcps/<name>.json
├── sessions/<id>/                   per-session workdirs
├── tasks/<id>/                      placeholder (future)
├── workflows/<id>/                  placeholder (future)
└── logs/                            placeholder (future)
```

The HTTP API uses URL-path scoping: every workspace-scoped resource lives
under `/api/workspaces/<name>/...`. Catalog endpoints are
`/api/workspaces/<name>/catalog/{skills,agents,mcps,overview}`; sessions
are `/api/workspaces/<name>/sessions/...`. There is no global catalog
mount — switching workspace switches the catalog the dashboard sees.

## Design

The repo is a pnpm monorepo with three layered abstractions on top of a few pure helpers:

- [`@emploke/catalog`](./packages/catalog) owns each workspace's marketplace of skills + MCPs and its dependency graph (resolve in topological order, reject cycles, block uninstall when something still depends on you). One `Catalog` instance per workspace, rooted at `<workspace>/catalog/`.
- [`@emploke/workspace`](./packages/workspace) owns the **per-project** root: one `workspace.json` per workspace, one `$EMPLOKE_HOME/workspaces.json` registry mapping URL-routing names to absolute paths.
- [`@emploke/runtime`](./packages/runtime) adapts third-party CLIs. It provisions per-session workdirs (`provision`) and performs one-time per-workspace setup (`registerWorkspace`, e.g. recording the workspace as trusted with the underlying CLI so spawned sessions don't trigger trust prompts).

[`@emploke/task`](./packages/task) is the pure five-state lifecycle. [`@emploke/session`](./packages/session) maps each session to a workdir under the active workspace's `sessions/`. [`@emploke/server`](./packages/server) + [`@emploke/dashboard`](./packages/dashboard) expose everything as a single-user local control plane; one server process can host multiple workspaces, deciding which one a request targets from the URL path. [`@emploke/terminal`](./packages/terminal) hosts the launched CLI in a real terminal window.

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
