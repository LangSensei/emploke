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
emploke start
```

Then open <http://127.0.0.1:8787> in your browser. `emploke start` runs the
server as a detached background process so the terminal is free; the rest
of the lifecycle is `emploke stop`, `emploke restart`, `emploke status`,
and `emploke logs -f`. Run `emploke help` (or just `emploke`) for the full
command tree, or `emploke serve` to keep it in the foreground (the legacy
behaviour, useful for `tmux` panes or `systemd` units).

The first time you run `emploke`, the dashboard's landing page is empty.
Walk through:

1. **Add a workspace** — give it a display name. Optionally pick a directory
   on disk; if you don't, emploke creates one under
   `$EMPLOKE_HOME/workspaces/<uuid>/` so the workspace id and the on-disk
   directory share the same name. Either way emploke writes
   a `workspace.db` SQLite file plus `sessions/` and `tasks/` subdirs
   inside; existing files in a user-supplied directory are left alone.
2. **Install an agent** in the Catalog tab — point at any directory containing
   an `AGENTS.md` (a [Claude-style agent](https://www.claude.com/news/agent-skills);
   any directory with valid frontmatter works). Skills + MCPs the agent
   depends on go in the same way.
3. **Dispatch a task** in the Tasks tab — pick the agent, write a brief
   (one-line goal) and optional details, click *Dispatch*. The agent runs
   unattended in a new sandbox under
   `tasks/<id>/`; the dashboard shows the live event stream and folds the
   exit into a final `succeeded` / `failed` / `cancelled` status.
4. **Or open a session** in the Sessions tab — interactive workdir; emploke
   bakes the agent into it and gives you the exact `copilot` invocation to
   run yourself.

## Configuration

All configuration is via environment variables; no config file. Defaults
work for single-machine use; only set what you need to override.

| Env var              | Default        | Purpose                                                                                                  |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `PORT`               | `8787`         | HTTP listen port.                                                                                        |
| `EMPLOKE_HOST`       | `127.0.0.1`    | Bind address. emploke is **loopback-only** — non-loopback values are refused at startup. For remote access, expose the loopback socket through SSH port-forward, a reverse proxy (mTLS / OIDC), or a mesh VPN (Tailscale, …). |
| `EMPLOKE_HOME`       | `~/.emploke`   | Where the global SQLite registry (`global.db`) lives.                                                  |
| `EMPLOKE_LOG_LEVEL`  | `info`         | `debug` / `info` / `warn` / `error`.                                                                     |
| `EMPLOKE_LOG_FORMAT` | `pretty`       | `pretty` (dev terminal) or `json` (log aggregators).                                                     |
| `EMPLOKE_STATIC_DIR` | next to bundle | Override the dashboard SPA location. Useful when running from a non-bundle layout.                       |

Pass `--no-serve-static` to run API-only (the dashboard SPA is bundled in
the npm package by default; serving it from the same port is the only
deployment mode that makes sense for the local-first model).

## Filesystem contract

Everything emploke writes under `<EMPLOKE_HOME>` (default `~/.emploke`)
and per-workspace internals is **server-internal state**. The layout —
file names, JSON shapes, SQLite schemas, sidecar files — is implementation
detail and may change between versions. Reading these files for inspection
is fine; **anything else (writes, hand-edits, `rm`) is unsupported and
may be detected as corruption.**

For the path-by-path layout (what emploke owns vs the agent vs the
runtime adapter) and the rationale for keeping clients out of
`<EMPLOKE_HOME>/`, see [`docs/architecture.md` →
Filesystem contract](./docs/architecture.md#filesystem-contract).

## CLI

After `npm install -g @langsensei/emploke` the `emploke` binary exposes
two layers of commands:

### Lifecycle (talk to the local process)

| Command            | Behaviour                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `emploke`          | Print top-level help (alias for `emploke help`).                                                                                                                         |
| `emploke help [c]` | Top-level help, or per-subcommand help when `c` is given.                                                                                                                |
| `emploke serve`    | Run the server in the foreground — current dev behaviour. Honours every env var in the *Configuration* table; flags override env.                                        |
| `emploke start`    | Spawn the server as a detached background process. Records pid + port in `<EMPLOKE_HOME>/runtime.json`. Idempotent.       |
| `emploke stop`     | SIGTERM the recorded pid, wait for graceful shutdown (escalates to SIGKILL after 30 s), then delete `runtime.json`. Idempotent. *Windows note:* `process.kill` maps to `TerminateProcess` — there is no graceful equivalent on Windows; the server's atomic-write persistence keeps state consistent regardless. |
| `emploke restart`  | `stop` then `start` with the same flags.                                                                                                                                 |
| `emploke status`   | Print one-line health summary. Exit codes: `0` running + healthy, `3` not running, `4` running but `/api/health` not responding. `--json` for scripts.                   |
| `emploke logs`     | Cat the rolling server log under `<EMPLOKE_HOME>/logs/`. `-f` follows the file as it grows (Ctrl-C to stop).                                                             |

### API client (talk to a running server)

65 typed routes — wrapped 1:1 by the CLI's `client.call(...)` surface;
the typed manifest in `packages/contracts/src/routes.ts` is the single
source of truth that both the server registers handlers against and
the CLI builds typed calls from. Adding a route on either side
without updating the other fails CI.

```sh
# server connection (default: http://127.0.0.1:8787, picked up from
# `runtime.json` when `emploke start` has run)
emploke health
emploke config --json
emploke runtime list

# workspaces
emploke workspace list
emploke workspace add --name "Sandbox" --workdir ~/code/sandbox
export EMPLOKE_WORKSPACE=<id>          # required for workspace-scoped commands
emploke workspace show <id>
emploke workspace rm <id> --purge

# sessions and tasks (workspace-scoped; pass --workspace <id> to override the env above)
emploke session new --agent writer
emploke session list --agent writer --json
emploke task dispatch --agent triage --brief "Scan recent issues"
emploke task list --status running,succeeded
emploke task events <tid>     # one-shot dump of the runtime's NDJSON log
emploke task activity <tid>   # runtime-parsed activity timeline (JSON)

# catalog
emploke catalog overview
emploke catalog skill list
emploke catalog skill install --file /abs/path/to/skill
emploke catalog agent install --url https://github.com/LangSensei/emploke/tree/main/first-party/agents/dev
emploke catalog mcp install --url https://github.com/LangSensei/emploke/tree/main/first-party/mcps/example.json
```

Common flags on every API command:

- `--server <url>` — overrides `EMPLOKE_SERVER` and `runtime.json`. Defaults to `http://127.0.0.1:8787`.
- `--workspace <id>` — workspace-scoped commands. Overrides `EMPLOKE_WORKSPACE` and the server's `currentWorkspace`.
- `--output <fmt>` / `--json` — `table` (human-friendly default) or `json` (for scripting).

Exit codes: `0` success, `1` generic error, `2` usage error, `3` server unreachable, `4` server returned a 4xx/5xx.

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
  with a structured `running → succeeded/failed/cancelled`
  lifecycle, persisted across server restarts.

## Architecture

The repo is a [pnpm](https://pnpm.io/workspaces) monorepo of 14 small
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
[`@emploke/runtime`](./packages/runtime), and
[`@emploke/server`](./packages/server).

## First-party catalog

The repo ships a [`first-party/`](./first-party/) subtree of agents and
skills (scope `emploke`) that the project maintains in lock-step with the
code — they depend on internals (catalog schema, CLI surface) tightly
enough to version-bump and PR together with the packages that define
those internals. See [`first-party/README.md`](./first-party/README.md)
for the full list and install URLs; community-maintained entries continue
to live in [emploke-marketplace](https://github.com/LangSensei/emploke-marketplace).

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
