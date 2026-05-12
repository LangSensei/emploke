# @emploke/session

Per-session workdir registry for emploke. Each session is a directory with an
agent baked in (via [`@emploke/provisioner`](../provisioner)). This package
**organizes** those workdirs — it does not spawn any process.

## Why

For interactive use, the [GitHub Copilot CLI](https://github.com/github/gh-copilot)
(`copilot -i`) is the chat UI. emploke's job is to:

- prepare a workdir for an agent (provisioner)
- remember which workdirs exist, what agent each was baked from, and which
  Copilot sessions have run in each (this package)
- give callers the exact incantation to launch / resume Copilot in a workdir

You launch Copilot yourself.

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

const cmd = await sessions.buildLaunch(session.id);
console.log("run:", cmd.display);
// → cd "/Users/.../.emploke/sessions/20260508-9dfbdf05" && copilot -i
```

After the user runs `copilot -i` in the workdir at least once, listing surfaces
the discovered Copilot sessions:

```ts
const records = await sessions.list();
records[0].copilotSessions       // [{ sessionId, name, summary, ... }, …]
records[0].latestCopilotSession  // most recently updated
```

Resume:

```ts
const sid = records[0].latestCopilotSession?.sessionId;
if (sid) {
  const cmd = await sessions.getResumeCommand(records[0].id, sid);
  console.log(cmd.display);
  // → cd "/.../20260508-9dfbdf05" && copilot -i --resume <sid>
}
```

## What this package does NOT do

- Spawn `copilot`. `getLaunchCommand` / `getResumeCommand` return the
  invocation; you exec it.
- Track headless task execution. That belongs to a future
  `@emploke/runtime` package.
- Stream events from Copilot. The Copilot CLI handles the chat UI itself.

## Caveats

- **Multiple Copilot sessions per workdir**: running `copilot -i` twice in the
  same cwd creates two distinct Copilot sessions. Each emploke workdir can
  have zero or more Copilot sessions associated. `latestCopilotSession`
  returns the most recently updated one.
- **`copilot -i --resume <sid>` from a different cwd**: Copilot's internal cwd
  for that session may shift. The cwd-based join here is best-effort: a
  session that moves cwd will appear under whichever workdir matches the new
  cwd, or none.
- **Path matching**: case-insensitive on Windows, case-sensitive elsewhere
  (no special handling for case-insensitive macOS volumes — pull requests
  welcome with a robust detection strategy).
- **`deleteCopilotState: true`** may fail with `EBUSY` on Windows if Copilot
  currently has the session open. The error is surfaced; the emploke workdir
  is left intact.

## License

MIT
