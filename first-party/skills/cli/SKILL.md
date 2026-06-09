---
name: cli
scope: emploke
description: "Control an emploke server from the CLI — workspaces, agents, tasks, sessions, catalog, workflows"
version: 1.1.0
---

# emploke/cli skill

You're an AI controlling an emploke server through its CLI. This skill teaches you the **conventions that aren't obvious from `--help`** — most importantly the workspace-scoping discipline that prevents your commands from racing with other clients.

## When to use

- Dispatching a task to an emploke agent
- Installing / syncing / enabling an agent or skill
- Inspecting a task's progress (one-shot or live tail)
- Managing workspaces, sessions, MCP catalog entries

If the user just wants you to read repo files or run shell commands, this skill is irrelevant.

## Setup

emploke injects what you need into your env when it spawns your task or session:

- `EMPLOKE_SERVER` — server URL (the CLI uses this automatically)
- `EMPLOKE_WORKSPACE` — workspace UUID (workspace-scoped commands inherit it)

Quick verification:

```sh
emploke health         # exit 0 ⇒ CLI works + server reachable
```

## Workspace discipline

Every workspace-scoped command requires an explicit selector. The CLI reads `EMPLOKE_WORKSPACE` from your env (already set), so commands work as-is:

```sh
emploke task dispatch --agent writer --brief "..."
```

To act on a different workspace, pass `--workspace <id>` per command:

```sh
emploke task list --workspace ws-Y
```

The CLI does not consult any server-side shared "current workspace" state — selectors are process-local, immune to interference from other clients (other CLI sessions, dashboard tabs, AI agents on the same server).

## Output discipline

- **For parsing, always pass `--json`.** Human format is not a stable contract.
- **For streaming activity, pipe through `jq -c`** to keep one event per line.
- **Read `code` in error stderr**, not just the message. Errors look like:
  ```
  agent "writer" is not ready: prereqs not acknowledged (HTTP 409, EntryNotReadyError)
    agent: langsensei/writer
    cause: prereqs not acknowledged
    fix:   emploke catalog agent ack-prereqs langsensei/writer
  ```
  The `fix:` line is your next command, verbatim. See `references/error-codes.md` for the full table.

## Common workflows

Detailed playbooks live in `references/workflows.md`. Quick index:

- **Install an agent and make sure it's ready to dispatch** — handles `prereqs not acknowledged`, `disabled by user`, missing dependencies.
- **Dispatch a task and wait for completion** — covers the `EntryNotReadyError` retry loop.
- **Monitor a long-running task** — one-shot history, live tail, resume after Ctrl+C.
- **Sync (re-resolve) an installed entry against its upstream origin** — preview-then-apply with `planToken`.
- **Clean up failed / stale tasks** — list, filter, archive vs purge.
- **Set up a fresh workspace with a standard agent set** — atomic onboarding script.
- **Create a local agent on the fly** — write `AGENTS.md`, `catalog agent install --file /abs/path`, dispatch.

## Workflow subcommands

`emploke workflow …` is the surface a `kind: coordinator` task uses to seed a workflow, walk its live DAG, and mutate it (add / remove nodes and edges, replace specs, cancel, finish). Workers do not call into it — they just exit, and the substrate joins their result back to the DAG via `task.metadata.workflowNodeId`.

The full per-subcommand reference (flags, HTTP route, body schema, response shape, exit-code notes, plus coord introspection / batch-mutation snippets) lives in `references/workflow-commands.md`. The 14 subcommands at a glance:

| Read-only | Coord-only mutation | Terminal |
| --- | --- | --- |
| `list`, `show`, `dag`, `node-show` | `add-node`, `add-subgraph`, `add-edge`, `remove-node`, `remove-edge`, `replace-spec`, `cancel-node` | `create`, `cancel`, `finish` |

All workflow subcommands accept the same `--server / --home / --workspace / --output / --json` flags and follow the exit-code table below. The reference doc only calls out per-command additions.

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | success | continue |
| 1 | generic error (incl. missing workspace) | read stderr; usually missing flag/env |
| 2 | usage error (missing required flag, removed subcommand) | fix the invocation; do not retry as-is |
| 3 | server unreachable | ask user to `emploke start` or check `--server` |
| 4 | server returned 4xx/5xx | read `code` in stderr; consult `references/error-codes.md` |

Exit code 2 means **"the command itself is wrong"** — never retry it without changing the invocation. Exit code 4 means "the server rejected this" — read the `code` field, it tells you the next move.

## Anti-patterns

- **Don't poll without backoff.** `while true; do emploke task list; done` is wrong. If you need to wait for a task, use `emploke task activity <tid> --follow` (real-time SSE) instead of polling `task list`.
- **Don't use `--follow` for one-shot data.** `--follow` blocks until the task terminates. For "what's the latest activity right now?" use `emploke task activity <tid>` (no `--follow`) and read the JSON.
- **Don't `--purge` casually.** Default `task rm` (no flag) removes the metadata row only — and **requires the task to be in a terminal state** (`succeeded` / `failed` / `cancelled`); it does NOT cancel a running task. If the task is still running, use `emploke task cancel <tid>` first, then `task rm`. `task rm --purge` additionally removes the task workdir and the runtime's per-task state on disk — use only after you're sure you don't need the post-mortem material (`stderr.log`, etc).
- **Don't ignore `last seq:` on stderr** when streaming. On every clean `--follow` exit (`event: end` from the server, or stream closed) AND on mid-stream-error exit, the CLI prints `last seq: <N>` to stderr — pass `--after <N>` to the next `--follow` invocation to resume without gaps or duplicates. **Caveat:** Ctrl+C kills the process between frames and stderr is not flushed; recover the seq from stdout in that case (`... | tail -1 | jq .seq`) since each printed item carries its own `seq`.
- **Don't construct workspace ids from the dashboard URL.** Always `emploke workspace list --json | jq` to get a current id.

## Common SSE resume pattern

```sh
# History-then-tail (combines snapshot with live).
# The one-shot response is tail-first, so the LAST item in the
# returned `activity` array is the latest seq we've seen — that
# becomes the resume point.
N=$(emploke task activity <tid> --json | jq -r '.activity[-1].seq')
emploke task activity <tid> --follow --after "$N" | jq -c

# Resume after a clean --follow exit (server sent event: end, or
# stream closed). stderr's last line on either of those is `last seq: <N>`.
emploke task activity <tid> --follow --after <N> | jq -c

# Resume after Ctrl+C — stderr was not flushed, so derive the last
# seq from stdout instead. Each NDJSON line carries its own seq.
N=$(printf '%s\n' "$LAST_STDOUT_LINE" | jq -r .seq)
emploke task activity <tid> --follow --after "$N" | jq -c
```

## What this skill is NOT

- **Not a substitute for `--help`.** Concrete flag lists / new subcommands change with releases; consult `emploke <cmd> --help` for the canonical surface.
- **Not a server admin guide.** This skill assumes the server is running and configured. Service lifecycle (`emploke start / stop / restart / serve`) is a separate concern.

## See also

- `references/workflows.md` — multi-step playbooks for the common goals
- `references/workflow-commands.md` — full per-subcommand reference for `emploke workflow …`
- `references/error-codes.md` — every `code` value the server emits + the matching `emploke` command to fix it
