# @emploke/catalog

Skill + MCP + Agent registry with dependency-aware install / update /
uninstall. SQLite-backed; the per-workspace `workspace.db` owns
`agents`, `skills`, `mcps`, the `*_files` BLOB tables, and the
dependency edge tables.

## Scope

What this package **does**:

- Read `AGENTS.md` / `SKILL.md` frontmatter and project five fields:
  required `name` / `description` / `version`, optional `scope`
  (defaults to `public`), optional `prereqs`, optional
  `dependencies.{skills,mcps}`. Other frontmatter fields
  (`license`, ) are preserved on disk but **not interpreted**.
- Track the names of MCP server JSON files (`mcps/<name>.json`). The
  contents of those files are **never read** by emploke beyond
  recording metadata.
- Resolve transitive dependency closures (topological sort) for any
  skill or agent.
- Validate graph rules on writes: name uniqueness, kebab-case,
  missing-dependency, no cycles, reverse-dependency safety on
  uninstall (via in-repo `count()` checks, since FK constraints were
  dropped along with the previous per-pkg migration framework  the
  service throws a synthetic `HasDependentsError` instead).

What this package **does not** do:

- Interpret business fields (`prereqs`, semantic version checks,
  signature verification, ). That belongs in install tools layered
  on top.
- Read or interpret MCP JSON contents. Substrates parse the file
  when they spawn the server.
- Execute, copy or "ingest" skills into agents. That is a substrate /
  runtime concern.
- Fetch capabilities from the network. The fetcher subpackage handles
  origin parsing + bytes-on-disk; the catalog only manages local
  state.

## Layout

```
packages/catalog/src/
  schema.ts                Drizzle tables (private; only types exported)
  types.ts                 Public DTOs (Agent / Skill / Mcp + entries + resolve results)
  validate.ts              FQN / name / install-body validators
  origin-mutability.ts     Helper to detect mutable origins (file:, etc.)
  agent/                   Per-entity service + errors + entity class
  skill/
  mcp/
  facade/                  Cross-entity CatalogService + DTOs
  fetcher/                 Origin parser + remote bytes fetcher
  migrations.ts            applyCatalogMigrations (drizzle migration applier)
  compose.ts               composeCatalogModule({ dbFile|db, fetcher? })
  testing.ts               openTestCatalogDb helper (via /testing subpath)
  index.ts                 public barrel
drizzle/                   generated SQL migrations (committed)
drizzle.config.ts          drizzle-kit config
```

## On-disk

Everything lives inside the per-workspace shared `workspace.db`:
`agents`, `skills`, `mcps`, the `*_files` BLOB tables (agent +
skill content), and the per-entity dep edge tables. There is no
`<workspace>/catalog/` directory and no per-entity files on disk;
agent and skill source content (frontmatter + Markdown body) is
read out of the BLOB columns.

> Why SQLite for catalog? See
> [docs/architecture.md  Backend selection](../../docs/architecture.md#backend-selection-when-sqlite)
>  catalog has cross-entity dependency-graph queries (`resolveAgent`)
> and BLOB content streams, which are exactly the cases the rule says
> SQLite owns.

## Quick start

```ts
import { composeCatalogModule } from "@emploke/catalog";

const { service: catalog, close } = await composeCatalogModule({
  dbFile: "/abs/path/to/workspace.db",
});

// Install (origin-driven). The resolver fetches the entry + its
// transitive deps, surfaces conflicts, and returns a CatalogPlan;
// install() walks the topology in order.
await catalog.installSkill("file:/tmp/sop-prepared");
await catalog.installAgent("github:org/repo/tree/main/agents/code-reviewer");
await catalog.installMcpFromOrigin("file:/tmp/mcps/playwright.json");

// Resolve from the local catalog (no network  DAG walk over
// already-installed entries; used by the runtime when materialising
// a workdir).
const plan = await catalog.resolveAgent("public/code-reviewer");

// Read DTOs at the boundary.
await catalog.listSkillEntries();        // SkillEntry[]
await catalog.getSkill(fqn);             // Skill | null
await catalog.listAgentEntries();
await catalog.listMcps();

await close();
```

## Errors

- `AgentFrontmatterError` / `SkillFrontmatterError`  malformed YAML
- `*NameInvalidError`  fails kebab-case / length / charset
- `*NotFoundError`  unknown FQN
- `*OriginConflictError`  install collision
- `CyclicDependencyError`  `resolveAgent` walk found a cycle
- `HasDependentsError`  uninstall blocked by reverse-deps (the FK
  substitute mentioned above)
- `McpInvalidJsonError`  MCP file failed JSON schema check
- `FetchError` / `OriginParseError`  fetcher subpackage errors

## Testing

```sh
pnpm --filter @emploke/catalog test
```

Vitest runs in `forks` pool (better-sqlite3''s native binding
segfaults on worker-thread teardown on Windows).

## License

MIT