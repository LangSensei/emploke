# @emploke/runtime

Runtime adapter contract + Copilot CLI implementation.

A *runtime* adapts a third-party CLI (GitHub Copilot, Gemini, Claude
Code, …) for use by emploke. It owns four operations against the CLI's
on-disk world: provision a workdir, refresh activity, build a launch
command, delete state. Plus one optional operation: one-shot
non-interactive task dispatch.

Per-runtime preconditions (folder-trust setup, credential refresh,
license checks, …) live **inside the adapter**, executed lazily at the
moment they're needed. There is intentionally no cross-runtime
"register workspace" hook — different CLIs have wildly different
gating rules and abstracting them just leaks one runtime's internals
into the others.

## The contract

```ts
interface Runtime {
  readonly kind: string;              // "copilot", "gemini", "claude-code", ...

  /**
   * Bake `agent` into `workdir`. The runtime pulls bytes from the
   * supplied `catalog` (via skillEntries / agentEntries / getMcpContent),
   * not via on-disk catalog paths — so a future SQLite-backed catalog
   * works without code changes here.
   *
   * Pre-allocating runtimes (CLI accepts `--resume=<uuid>`) return a
   * freshly minted id; discovery-only runtimes return `null` and rely
   * on refresh() to learn the id later.
   */
  provision(
    workdir: string,
    agent: AgentResolveResult,
    catalog: CatalogManager,
  ): Promise<{ runtimeSessionId: string | null }>;

  /** Poll the CLI for activity. `null` = no record of this session. */
  refresh(session: Session): Promise<{
    lastActiveAt: string;
    preview: string | null;
    runtimeSessionId: string;
  } | null>;

  /**
   * Build the exact `cmd args cwd` the user runs to drop into a
   * session. `workspaceDir` is the absolute path of the workspace this
   * session lives under; runtimes whose interactive mode requires a
   * per-launch precondition keyed off the workspace root use it to
   * perform that precondition here, lazily, only when the user
   * actually launches.
   *
   * Async by contract: a runtime may need to do a small amount of
   * idempotent fs work (write a config, refresh a token) before
   * returning the launch spec. Pure runtimes simply `return { ... }`
   * without `await`ing anything.
   */
  buildLaunch(session: Session, workspaceDir: string): Promise<LaunchCommand>;

  /** Remove the CLI's per-session state. Throws on partial failure. */
  deleteState(session: Session): Promise<void>;

  /** Optional: spawn a one-shot non-interactive worker. */
  dispatchTask?(opts: DispatchTaskOpts): Promise<TaskHandle>;

  /** Optional: where the runtime writes a per-task event log. */
  taskEventsPath?(taskWorkdir: string): string | null;
}
```

The interface is deliberately small. Anything CLI-specific that
doesn't fit one of these verbs (telemetry, logging, custom flags) is
the runtime's private concern and should not leak into emploke's
surface.

Runtimes are stateless across calls — all per-session data lives
either in `Session.runtimeSessionId` (an opaque, runtime-specific id)
or in the CLI's own storage. Runtimes never mutate the `Session` they
receive; they return updated values that the caller persists.

## CopilotRuntime

The shipped implementation in this package. Adapts the
[GitHub Copilot CLI](https://github.com/github/gh-copilot).

```ts
import { CopilotRuntime } from "@emploke/runtime";

const rt = new CopilotRuntime();
// Optional config:
//   copilotStateDir?:   defaults to ~/.copilot/session-state
//   copilotConfigPath?: defaults to ~/.copilot/config.json
//   randomUUID?:        test seam for id generation
```

Key design points:

- **Pre-allocates a UUID at provision time** and threads it through
  `--resume=<id>` on every launch. First launch creates the session;
  subsequent launches resume it. Eliminates the "scan all sessions
  and match by cwd" dance the old impl needed.
- **Per-launch trust preflight, not workspace-bootstrap.**
  `buildLaunch(session, workspaceDir)` runs `ensureDirTrusted` against
  `~/.copilot/config.json` immediately before returning the launch
  spec, so trust I/O happens at the moment the user actually launches
  an interactive session — never eagerly at workspace open. The write
  is idempotent and ancestor-aware: the first launch in a workspace
  pays one read+write; every subsequent launch passes `isPathCovered`
  and short-circuits without writing.
  `dispatchTask` (`copilot -p --yolo`) does not need trust and never
  touches the file.
- **Trust file is `config.json`, NOT `settings.json`.** The Copilot
  CLI (verified against 1.0.44) only reads `trustedFolders` from
  `config.json`; entries in `settings.json` are silently ignored, even
  though `config.json`'s leading comment misleadingly says "User
  settings belong in settings.json".
- **Defends against malformed `runtimeSessionId`.** Every method that
  would compose the id into a filesystem path or `--resume=<id>`
  argument runs it through `isCopilotSessionId` first. Tampered
  `session.json` with `"../../etc"` degrades gracefully — refresh
  returns "no activity", deleteState is a no-op, buildLaunch produces
  a fresh launch (no `--resume`).

## How `provision` materialises an agent

Source content is streamed from the catalog, never copied via fs paths:

```text
<workdir>/
├── AGENTS.md                     # ← catalog.agentEntries(name) "AGENTS.md"
├── prompt.txt                    # ← any sibling files the agent installed
├── scripts/run.sh                #   (multi-file agents work end-to-end)
├── .mcp.json                     # ← merged from agent.mcps via getMcpContent
├── .github/skills/<name>/        # ← catalog.skillEntries(name), per skill
│   ├── SKILL.md
│   └── ...                       #   sibling files preserved
├── .github/hooks/                # ← skill / agent `hooks/copilot/*` merged here
└── .git/                         # ← git init -q (for --resume cwd-stability)
```

Scoped skill names like `langsensei/weather` are flattened to
`langsensei__weather` because Copilot's `.github/skills/` discovery is
single-level.

When two skills contribute files at the same relative path under
`.github/hooks/` or `.github/skills/<name>/`, the later one wins.
Skill order is the topological order the catalog produced.

## Adding a new runtime

1. Implement the `Runtime` interface; follow `CopilotRuntime` as a
   reference. Most methods boil down to "translate emploke's verbs
   into the CLI's flags / state paths."
2. Pull agent content from the supplied `CatalogManager` arg via
   `agentEntries(name)` / `skillEntries(name)` / `getMcpContent(name)`.
   Never resolve catalog paths from the resolve result.
3. Implement `dispatchTask` if the CLI supports unattended scripting
   (e.g. Copilot's `-p/--prompt` mode). Wire stdout/stderr to log
   files in the supplied `taskDir`.
4. Implement `taskEventsPath(taskWorkdir)` if the CLI writes a
   structured per-session event log; the dashboard streams the bytes
   opaquely.
5. Register in `packages/server/src/runtime-registry.ts`.

The dashboard adapts automatically — runtimes are listed via
`/api/runtimes` and the create-session / dispatch-task forms pick
them up.

## Errors

```ts
RuntimeError
├── RuntimeNotFoundError                — kind not in registry
├── RuntimeProvisionFailed              — provision() threw (workdir prep, catalog read)
├── RuntimeRefreshFailed                — refresh() threw (CLI state corruption)
├── RuntimeStateDeletionFailed          — deleteState() threw
├── RuntimeDispatchTaskFailed           — dispatchTask() spawn / pre-spawn failure
└── (Copilot-specific)
    ├── InvalidMcpJson                  — MCP content failed JSON parse during provision
    ├── WorkdirPrepFailed               — git init / mkdir failed
    └── TrustRegistrationFailed         — config.json mutation failed (mkdir, lock,
                                          atomic write); thrown by buildLaunch's
                                          per-launch ensureDirTrusted preflight
```

## Testing

```sh
pnpm --filter @emploke/runtime test
```

Tests cover Copilot runtime (provision, refresh, buildLaunch,
deleteState, dispatchTask) plus path-traversal hardening, trust-file
locking semantics, and Windows-specific spawn timing.

`packages/runtime/test/copilot/test-catalog.ts` is the in-memory
catalog helper that backs every provision-side test — useful when
adding a runtime to avoid mkdtemp-heavy fixtures.

## License

MIT
