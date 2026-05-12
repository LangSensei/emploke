# @emploke/session

Per-session workdir registry for emploke. Each session is a directory with an
agent baked in by the runtime adapter (see [`@emploke/runtime`](../runtime)).
This package **organizes** those workdirs — it does not spawn any process.

## Why

For interactive use, the [GitHub Copilot CLI](https://github.com/github/gh-copilot)
(`copilot -i`) is the chat UI. emploke's job is to:

- prepare a workdir with an agent baked in (the runtime adapter's
  `provision` step pulls bytes from the catalog)
- remember which workdirs exist, what agent each was baked from, and
  the opaque `runtimeSessionId` the runtime returned (this package)
- give callers the exact incantation to launch / resume the runtime in
  a workdir
- surface runtime-side display metadata (title / lastActiveAt) in
  `list()` by calling the runtime's optional `readMetadata` hook

You launch the CLI yourself.

## Layout

Each session has two stores: queryable metadata in a SQLite row, and
an on-disk workdir for the agent's actual product.

```
<sessionsDir>/
├── sessions.db          # SQLite — one row per session: runtime, createdAt, …
└── <id>/                # workdir for session <id>
    ├── AGENTS.md        # baked by the runtime provisioner
    ├── .github/skills/  # …and whatever else the provisioner wrote
    └── …                # plus anything the agent itself produces
```

`<sessionsDir>` is the directory the caller passes to `SessionManager`
(the server hands through `<workspace>/sessions/`). `<id>` is a short
date-prefixed identifier:

```
YYYYMMDD-xxxxxxxx
e.g. 20260508-9dfbdf05
```

The 8-hex-char suffix gives ~4 billion values per day, more than enough for
ad-hoc creation. The workdir contains **no metadata sidecar file** — the
agent name is parsed from `AGENTS.md` frontmatter at read time, and
`runtime` / `createdAt` / `runtimeSessionId` / `lastLaunchMode` come
from the row in `sessions.db`. The directory name is the **only source
of truth for the session ID**.

> Why SQLite for session metadata (and FS for the workdir)?
> See [docs/architecture.md → Backend selection](../../docs/architecture.md#backend-selection-when-fs-when-sqlite)
> for the project-wide decision rule. Session metadata uses the
> hybrid pattern: queryable fields in SQLite, agent product on FS.

## Usage

```ts
import { CatalogManager } from "@emploke/catalog";
import { SessionManager } from "@emploke/session";

const catalog = await CatalogManager.open({ catalogDir: "/path/to/workspace/catalog" });
const sessions = new SessionManager({
  catalog,
  runtimeRegistry,
  sessionsDir: "/path/to/workspace/sessions",
  workspaceDir: "/path/to/workspace",
});

const session = await sessions.create({ agent: "demo-agent" });
console.log("workdir:", session.workdir);

const cmd = await sessions.buildInteractiveLaunch(session.id);
console.log("run:", cmd.display);
// → cd "/Users/.../.emploke/sessions/20260508-9dfbdf05" && copilot -i
```

After the user runs `copilot -i` in the workdir at least once, listing surfaces
the runtime-supplied display metadata (read via `Runtime.readMetadata`):

```ts
const records = await sessions.list();
records[0].lastActiveAt   // ISO timestamp of the most recent CLI activity
records[0].preview        // runtime-derived display title (Copilot: workspace.yaml.name)
records[0].runtimeSessionId  // the opaque id the runtime owns
```

Resume is the same call as launch — `buildInteractiveLaunch` produces `cd && copilot -i --resume <id>`
once a `runtimeSessionId` exists, or `cd && copilot -i` (fresh session) when it doesn't:

```ts
const cmd = await sessions.buildInteractiveLaunch(records[0].id);
console.log(cmd.display);
// → cd "/.../20260508-9dfbdf05" && copilot -i --resume <sid>
```

`buildInteractiveLaunch(id, { remote: true })` produces a remote-friendly variant when
the runtime supports it (otherwise throws `RuntimeDoesNotSupportRemoteError`).

## What this package does NOT do

- Spawn `copilot`. `buildInteractiveLaunch` returns the invocation; you exec it.
- Track headless task execution. That's [`@emploke/task`](../task).
- Stream events from Copilot. The Copilot CLI handles the chat UI itself.

## Caveats

- **One Copilot session per emploke workdir**. Provision pre-allocates
  a `runtimeSessionId` and threads it through `--resume=<id>` on every
  launch — first launch creates the Copilot session, subsequent
  launches resume the same one. (Pre-emploke installs that ran
  `copilot -i` directly in a workdir without `--resume` could end up
  with multiple Copilot sessions per cwd; this is no longer possible
  for sessions emploke provisioned itself.)
- **Path matching**: case-insensitive on Windows, case-sensitive elsewhere
  (no special handling for case-insensitive macOS volumes — pull requests
  welcome with a robust detection strategy).
- **`delete(id, { purge: true })`** may fail with `EBUSY` on Windows if
  Copilot currently has the session open. The error is surfaced; the
  metadata row is left intact.

## License

MIT
