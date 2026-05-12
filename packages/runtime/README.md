# @emploke/runtime

Runtime adapter contract + Copilot CLI implementation.

A *runtime* adapts a third-party CLI (GitHub Copilot, Gemini, Claude
Code, …) for use by emploke. The interface is **domain-agnostic** —
it doesn't know about emploke's `Session` / `Task` value types. It
exposes two execution modes (`-i` interactive vs `-p` headless) plus
a uniform observability + maintenance surface that works against
either:

- **Interactive** — `provision` (bake an agent into a workdir) +
  `buildInteractiveLaunch` (build the shell command)
- **Non-interactive** — `launchHeadless` (spawn the CLI as a detached
  worker that consumes a prompt and exits)
- **Observability** — `readMetadata` (title / lastActiveAt) +
  `readActivity` (paginated parsed timeline) + `streamActivity`
  (live SSE tail). All keyed by an opaque `runtimeSessionId` string.
- **Maintenance** — `deleteState` (rm the runtime's recorded state
  for one `runtimeSessionId`)

Per-runtime preconditions (folder-trust setup, credential refresh,
license checks, …) live **inside the adapter**, executed lazily at the
moment they're needed.

## The contract

```ts
interface Runtime {
  readonly kind: string;              // "copilot", "gemini", "claude-code", ...
  readonly capabilities?: RuntimeCapabilities;

  // ─── Interactive mode (-i) ─────────────────────────────────────

  /**
   * Bake `agent` into `workdir`. The runtime pulls bytes from the
   * supplied `catalog` (via skillEntries / agentEntries / getMcpContent),
   * not via on-disk catalog paths.
   *
   * Pre-allocating runtimes (CLI accepts `--resume=<uuid>`) return a
   * freshly minted id; discovery-only runtimes return `null` and rely
   * on the caller (or a future per-runtime discovery hook) to learn
   * the id later.
   */
  provision(
    workdir: string,
    agent: AgentResolveResult,
    catalog: CatalogManager,
    ctx: ProvisionContext,
  ): Promise<{ runtimeSessionId: string | null }>;

  /**
   * Build the exact `cmd args cwd` the user runs to drop into a CLI
   * session. `runtimeSessionId === null` ⇒ no `--resume` flag.
   * `workspaceDir` is the workspace root; runtimes whose interactive
   * mode requires a per-launch precondition keyed off the workspace
   * root use it to perform that precondition here, lazily.
   */
  buildInteractiveLaunch(
    runtimeSessionId: string | null,
    workdir: string,
    workspaceDir: string,
    opts?: BuildInteractiveLaunchOpts,
  ): Promise<LaunchCommand>;

  // ─── Non-interactive mode (-p) ─────────────────────────────────

  /** Optional: spawn a one-shot non-interactive worker. */
  launchHeadless?(opts: LaunchHeadlessOpts): Promise<RuntimeHandle>;

  // ─── Observability ─────────────────────────────────────────────

  /**
   * Optional: read the runtime's display metadata for one
   * `runtimeSessionId` — principally a `title` field the CLI
   * generates from the first user prompt. Returns `null` when the
   * runtime has no record of the id.
   */
  readMetadata?(runtimeSessionId: string): Promise<RuntimeSessionMetadata | null>;

  /**
   * Optional: read + parse the runtime's per-conversation event log
   * into the runtime-neutral {@link ActivityItem} discriminated
   * union (`user | assistant | thinking | tool_call | system | summary`),
   * plus the agent's headline result. Paginated by `cursor` + `limit`;
   * surfaces `truncated` when the source had to be capped (e.g. raw
   * file size exceeded the per-runtime cap).
   */
  readActivity?(opts: ReadActivityOpts): Promise<ActivityResult | null>;

  /**
   * Optional: live-tail variant. AsyncIterable that yields
   * `ActivityItem`s as they're written to the runtime's native log,
   * until `opts.signal` aborts.
   */
  streamActivity?(opts: StreamActivityOpts): AsyncIterable<ActivityItem>;

  // ─── Maintenance ───────────────────────────────────────────────

  /** Remove the runtime's recorded state for one runtimeSessionId. */
  deleteState(runtimeSessionId: string): Promise<void>;
}
```

The interface is deliberately small. Anything CLI-specific that
doesn't fit one of these verbs (telemetry, logging, custom flags) is
the runtime's private concern and should not leak into emploke's
surface.

Runtimes are stateless across calls — per-conversation data lives
either keyed by an opaque `runtimeSessionId` (string) or in the CLI's
own storage. The Runtime layer never imports `Session` or `Task` —
managers (`@emploke/session`, `@emploke/task`) translate their
domain concepts into runtime calls at the call site.

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
  `buildInteractiveLaunch(runtimeSessionId, workdir, workspaceDir, opts)` runs
  `ensureDirTrusted` against `~/.copilot/config.json` immediately
  before returning the launch spec, so trust I/O happens at the
  moment the user actually launches an interactive session — never
  eagerly at workspace open. The write is idempotent and
  ancestor-aware: the first launch in a workspace pays one
  read+write; every subsequent launch passes `isPathCovered` and
  short-circuits without writing. `launchHeadless` (`copilot -p --yolo`)
  does not need trust and never touches the file.
- **Trust file is `config.json`, NOT `settings.json`.** The Copilot
  CLI (verified against 1.0.44) only reads `trustedFolders` from
  `config.json`; entries in `settings.json` are silently ignored, even
  though `config.json`'s leading comment misleadingly says "User
  settings belong in settings.json".
- **Defends against malformed `runtimeSessionId`.** Every method that
  would compose the id into a filesystem path or `--resume=<id>`
  argument runs it through `isCopilotSessionId` first. Tampered
  persisted state with `"../../etc"` degrades gracefully — `readMetadata`
  returns null, `deleteState` is a no-op, `buildInteractiveLaunch` produces a
  fresh launch (no `--resume`).
- **Activity reads share an internal helper.** `readMetadata` and the
  legacy session-state reader both go through `readCopilotWorkspaceYaml`
  so workspace.yaml parsing has one source of truth. `readActivity`
  reads `events.jsonl` with a 4 MB cap (tail-reads the last N bytes
  on overflow, surfaces `truncated.size_limit`); `streamActivity`
  polls + tails the same file with line-at-a-time parsing.

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
3. Implement `launchHeadless` if the CLI supports unattended scripting
   (e.g. Copilot's `-p/--prompt` mode). Wire stdout/stderr to log
   files in the supplied `opts.workdir`.
4. Implement `readActivity` (and ideally `streamActivity`) to read
   your runtime's per-conversation log end-to-end and return
   runtime-neutral `ActivityItem[]` + a derived "headline result"
   string. The dashboard / CLI / future MCP consumers render
   `ActivityItem`s without seeing your log format or storage path.
   Pagination via `cursor` + `limit` is mandatory for
   `readActivity`; `streamActivity` honours `opts.signal` for
   cleanup on HTTP-client disconnect.
5. Implement `readMetadata` if the CLI surfaces a session-level
   display title (Copilot's `workspace.yaml.name`).
6. Register in `packages/server/src/runtime-registry.ts`.

The dashboard adapts automatically — runtimes are listed via
`/api/runtimes` and the create-session / dispatch-task forms pick
them up.

## Errors

```ts
RuntimeError
├── RuntimeNotFoundError                — kind not in registry
├── RuntimeProvisionFailed              — provision() threw (workdir prep, catalog read)
├── RuntimeRefreshFailed                — readMetadata() threw (CLI state corruption)
├── RuntimeStateDeletionFailed          — deleteState() threw
├── RuntimeHeadlessLaunchFailed           — launchHeadless() spawn / pre-spawn failure
└── (Copilot-specific)
    ├── InvalidMcpJson                  — MCP content failed JSON parse during provision
    ├── WorkdirPrepFailed               — git init / mkdir failed
    └── TrustRegistrationFailed         — config.json mutation failed (mkdir, lock,
                                          atomic write); thrown by buildInteractiveLaunch's
                                          per-launch ensureDirTrusted preflight
```

## Testing

```sh
pnpm --filter @emploke/runtime test
```

Tests cover Copilot runtime (provision, readMetadata, buildInteractiveLaunch,
deleteState, launchHeadless, readActivity with cap + pagination,
streamActivity with abort) plus path-traversal hardening, trust-file
locking semantics, and Windows-specific spawn timing.

`packages/runtime/test/copilot/test-catalog.ts` is the in-memory
catalog helper that backs every provision-side test — useful when
adding a runtime to avoid mkdtemp-heavy fixtures.

## License

MIT
