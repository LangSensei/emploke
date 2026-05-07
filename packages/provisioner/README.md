# @emploke/provisioner

Per-provider workspace composer for emploke. Takes a fully-resolved skill +
MCP manifest from [`@emploke/catalog`](../catalog) and writes the files an
agent runtime expects.

## Quick start

```ts
import { Catalog } from "@emploke/catalog";
import { CopilotProvisioner } from "@emploke/provisioner";

const catalog = new Catalog({ root: "~/.emploke/catalog" });
await catalog.scan();

const resolveResult = catalog.resolveAgent("dev-agent");

const provisioner = new CopilotProvisioner();
await provisioner.provision({
  resolveResult,
  targetDir: "/tmp/run-1234/workdir",
});
```

After provisioning, the target directory looks like:

```
/tmp/run-1234/workdir/
├── AGENTS.md             # copied verbatim from <agentPath>/AGENTS.md
├── .mcp.json             # { "mcpServers": { … } } (omitted if no MCPs)
├── .git/                 # empty repo (so Copilot discovers .github/hooks)
└── .github/
    ├── skills/
    │   └── <flat-name>/  # SKILL.md (+ any other files); see "Scoped names" below
    │       └── SKILL.md
    └── hooks/            # merged contents of every <skill>/hooks/copilot/
```

### What provisioner does NOT do: per-task instructions

`AGENTS.md` is the agent's **persona** (system-prompt-level base context the
CLI auto-loads from the workdir). It comes from the catalog and is owned by
the agent author. **Per-task instructions** (the actual job — "review PR
#42") are NOT written by the provisioner; the runtime passes them to the
CLI directly:

```sh
copilot -p "Review PR #42" --yolo --output-format json
```

This split lets the same provisioned workdir serve many tasks against the
same agent without re-provisioning.

The execution unit is always an agent — `provision()` accepts only an
`AgentResolveResult`. To dispatch a single skill, wrap it in an agent.

### Scoped names

The Copilot CLI scans `.github/skills/` one level deep, so a scoped skill name
like `langsensei/weather` cannot be written as a nested directory (Copilot would
look for `.github/skills/langsensei/SKILL.md` and fail to discover the skill).
Provisioner therefore flattens scoped names with a `__` separator:

| Catalog name           | On-disk dir                  |
| ---------------------- | ---------------------------- |
| `weather`              | `weather/`                   |
| `langsensei/weather`   | `langsensei__weather/`       |
| `io.playwright/mcp`    | `io.playwright__mcp/`        |

The mapping is exposed as `flattenSkillName(name)` and is fully reversible
(`flat.split("__").join("/")`). MCPs use the original name as a JSON key in
`.mcp.json`, so they are **not** flattened.

## Design

### Why a fully-resolved manifest, not an agent name?

The provisioner does not import the catalog at runtime — it imports only the
`AgentResolveResult` type. Three benefits:

1. **Independence** — provisioner and catalog can evolve separately; tests
   don't need a real on-disk catalog.
2. **Composability** — callers can pre-resolve once and provision many task
   directories, or transform the manifest (inject extra MCPs, filter
   skills) before provisioning.
3. **Clear error boundaries** — resolution errors come from catalog;
   file-write errors come from provisioner.

### Skill layout convention (hooks)

Each skill in the catalog may include runtime-specific hooks under:

```
<skill-dir>/
├── SKILL.md
├── … (any other files / subdirs)
└── hooks/
    ├── copilot/         # composed into <targetDir>/.github/hooks/
    ├── claude/          # (future) composed into <targetDir>/.claude/hooks/
    └── …
```

The `hooks/` subdirectory is a **provisioner concern, not a catalog
concern** — catalog stores it as opaque skill content. Each provisioner
knows the convention for its own provider.

When two skills contribute files with the same destination path, the later
one in topological order wins (silent overwrite). This matches SWAT's
behaviour and keeps composition deterministic.

### v1 scope

- One provider: **Copilot** (`.github/`, `AGENTS.md`, `.mcp.json`,
  `git init` for hook discovery).
- Other providers (Claude, OpenCode) will land in follow-up packages /
  PRs. We deliberately did not abstract a `BaseProvisioner` yet — the
  abstraction will be extracted with evidence once a second provider
  exists.

## Error model

| Error | When |
|---|---|
| `InvalidMcpJson` | An MCP file referenced by the resolve result fails JSON parse. Catalog validates JSON at install time, so this normally indicates corruption or out-of-band edits. |
| `WorkspacePrepFailed` | Per-provider workspace prep (e.g. `git init`) fails. Wraps the underlying spawn / exit error. |
| `ProvisionError` | Base class for all of the above. |

Provisioning is **fail-fast**: any error leaves the target directory
half-written. The caller decides whether to roll back (`fs.rm(targetDir,
{ recursive: true })`).

## Requirements

- Node ≥ 22 (uses `fs.cp` with `filter`, `node:util.promisify` on `execFile`)
- `git` on PATH (Copilot provisioner runs `git init` so the CLI can
  discover `.github/hooks/`)
