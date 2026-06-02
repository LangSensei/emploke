# @emploke/runtime

Runtime adapter contract + Copilot CLI implementation.

A *runtime* adapts a third-party CLI (GitHub Copilot today; Gemini,
Claude Code planned) for use by emploke. The interface is
**domain-agnostic** - it doesn't know about emploke's `Session` /
`Task` value types. It exposes two execution modes (interactive vs
headless) plus a uniform observability + maintenance surface that
works against either:

- **Interactive** - `provision` (bake an agent into a workdir) +
  `buildInteractiveLaunch` (build the shell command the user runs to
  drop into the CLI).
- **Headless** - `launchHeadless` (spawn the CLI as a detached worker
  that consumes a prompt and exits).
- **Observability** - `readMetadata` (title / lastActiveAt) +
  `readActivity` (paginated parsed timeline) + `streamActivity`
  (live SSE tail). All keyed by an opaque `runtimeSessionId`.
- **Maintenance** - `deleteState` (rm the runtime's recorded state
  for one `runtimeSessionId`).

Per-runtime preconditions (folder-trust setup, credential refresh,
license checks, ...) live **inside the adapter**, executed lazily at
the moment they're needed.

## Layout

```
packages/runtime/src/
  types.ts                       Public contract (Runtime, LaunchCommand, ActivityItem, ...)
  errors.ts                      Cross-runtime error classes
  runtime-registry.ts            RuntimeRegistry (kind -> Runtime lookup)
  placeholders.ts                ${workspaceDir} / ${sharedDir} expansion helpers
  shared-dir.ts                  Shared-state dir helper (cross-runtime)
  copilot/
    copilot-runtime.ts           CopilotRuntime - the canonical adapter
    activity.ts                  ActivityItem translation from Copilot event log
    ids.ts                       Copilot session-id allocators + parsers + safeCopilotId guard
    interactive-launch.ts        buildCopilotLaunchCommand (--session-id, --yolo)
    launch-headless.ts           launchCopilotHeadless + mergeEnv + .mcp.json polyfill
    preflight.ts                 assertCopilotSdkResolvable (server-boot SDK presence check)
    provision.ts                 Bake AGENTS.md + .mcp.json into workdir
    state.ts                     workspace.yaml reader (CopilotWorkspaceMetadata)
    trust.ts                     Copilot trustedFolders preflight
    errors.ts                    Copilot-specific subclasses
  index.ts                       public barrel
```

## Contract (simplified)

```ts
interface Runtime {
  readonly kind: string;                          // "copilot", "gemini", ...
  readonly capabilities?: RuntimeCapabilities;

  // Interactive
  provision(
    workdir: string,
    agent: ResolvedAgent,
    catalog: AgentContentSource,
    ctx: ProvisionContext,
  ): Promise<{ runtimeSessionId: string | null }>;

  buildInteractiveLaunch(
    runtimeSessionId: string | null,
    workdir: string,
    workspaceDir: string,
    opts?: BuildInteractiveLaunchOpts,
  ): Promise<LaunchCommand>;

  // Headless
  launchHeadless?(opts: LaunchHeadlessOpts): Promise<RuntimeHandle>;

  // Observability
  readMetadata?(runtimeSessionId: string): Promise<RuntimeSessionMetadata | null>;
  readActivity?(opts: ReadActivityOpts): Promise<ActivityResult | null>;
  getLastAgentActivity?(runtimeSessionId: string): Promise<AgentActivity | null>;
  streamActivity?(opts: StreamActivityOpts): AsyncIterable<ActivityItem>;

  // Maintenance
  deleteState(runtimeSessionId: string): Promise<void>;
}
```

`ResolvedAgent` and `AgentContentSource` are runtime-private structural
types (defined in `src/types.ts`). They name the shape the runtime needs
from any agent / catalog source; consumers like `@emploke/catalog`
satisfy them by structural typing without runtime ever importing the
catalog package.

## CopilotRuntime

```ts
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";

const runtime = new CopilotRuntime({
  // Cross-cutting env layered into every spawned subprocess
  // (server bootstrap populates this via buildSubprocessEnvBase).
  subprocessEnvBase: { EMPLOKE_SERVER, EMPLOKE_SHARED_DIR },
  // Keys to delete from the inherited parent env on the HEADLESS
  // launch path (interactive shells inherit wholesale and cannot
  // unset). Server bootstrap passes ["EMPLOKE_HOME"].
  subprocessEnvScrub: ["EMPLOKE_HOME"],
});

const registry = new RuntimeRegistry();
registry.register(runtime);
```

`buildInteractiveLaunch` emits `copilot --session-id=<id> --yolo`
(falling back to `--yolo` alone for a fresh session). The package is
verified empirically against Copilot CLI 1.0.44 (see the class jsdoc in
`copilot/copilot-runtime.ts` and `copilot/trust.ts` for the per-feature
verification notes).

## Env contract

`LaunchCommand.env` is `Readonly<Record<string, string>>` - string
values only, no `undefined` (the windows terminal spawner cannot quote
`undefined`, and inlined `export K=v` / `$env:K='v'` forms in display
strings have no representation for "unset"). Two complementary knobs
carry the split semantics:

- `subprocessEnvBase` - positive declarations, applied on every launch
  path (both interactive and headless).
- `subprocessEnvScrub` - "delete from parent env" keys, applied only
  by `launchHeadless` (interactive shells inherit the parent env
  wholesale and have no syntactic way to unset).

See `packages/server/src/subprocess-env.ts` for the canonical
production values.

## Testing

```sh
pnpm --filter @emploke/runtime test
```

Vitest runs in `forks` pool, matching the other emploke packages - keeps
test-isolation semantics uniform across the monorepo.

## License

MIT