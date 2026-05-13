# @emploke/catalog

> Skill + MCP dependency-aware registry, file-system backed.

`@emploke/catalog` is the first published package of the [emploke](https://github.com/LangSensei/emploke) TypeScript rewrite. It maintains a local catalog of [Anthropic Claude Skills](https://docs.anthropic.com/) and [Model Context Protocol](https://modelcontextprotocol.io/) servers on disk, tracks the dependency graph between them, and provides install / update / uninstall operations with graph-level safety.

## Scope

What this package **does**:

- Read SKILL.md frontmatter and project four fields: `name`, `description`, `version`, optional `type`, optional `dependencies.{skills,mcps}`. Other frontmatter fields (`prereq`, `license`, …) are preserved on disk but **not interpreted**.
- Track the names of MCP server JSON files (`mcps/<name>.json`). The contents of those files are **never read** by emploke.
- Resolve transitive dependency closures (topological sort) for any skill.
- Validate graph rules on writes: name uniqueness, kebab-case, missing-dependency, no cycles, reverse-dependency safety on uninstall.

What this package **does not** do:

- Interpret business fields (`prereq`, semantic version checks, signature verification, …). That belongs in install tools layered on top.
- Read or interpret MCP JSON contents. Substrates parse the file when they spawn the server.
- Execute, copy or "ingest" skills into agents. That is a substrate / runtime concern.
- Fetch capabilities from the network. The catalog only manages local files; remote sourcing is a job for separate install tools.

## File-system layout

The catalog package stores everything inside the workspace's
shared `workspace.db` — agents, skills, MCPs, file BLOBs, the
dependency graph, and per-entity sync metadata are all SQLite tables
(`agents`, `skills`, `mcps`, `agent_files`, `skill_files`, …). There is
no `<workspace>/catalog/` directory and no per-entity files on disk;
agent and skill source content (frontmatter + Markdown body) is read
out of the BLOB columns by the legacy `agentEntries` /
`getSkillContent` API, not from loose files.

> Why SQLite for catalog?
> See [docs/architecture.md → Backend selection](../../docs/architecture.md#backend-selection-when-fs-when-sqlite)
> for the project-wide decision rule. Catalog has cross-entity
> dependency-graph queries (`resolveAgent`) and BLOB content streams,
> which are exactly the cases the rule says SQLite owns.

## Quick start

```ts
import { DatabaseSync } from "node:sqlite";
import { CatalogManager } from "@emploke/catalog";

// Catalog now reads/writes the per-workspace shared `workspace.db`.
// In production the workspace pkg owns the connection; here we open
// one ourselves for illustration.
const db = new DatabaseSync("/path/to/workspace/workspace.db");
const catalog = await CatalogManager.open({ db });

// Install
await catalog.installSkill({ sourceDir: "/tmp/sop-prepared" });
await catalog.installMcp({ name: "playwright", json: { type: "stdio", command: "npx", args: ["@modelcontextprotocol/server-playwright"] } });

// Resolve
const { agent, skills, mcps } = await catalog.resolveAgent("code-reviewer");
console.log(agent.fqn);          // "public/code-reviewer"
console.log(skills.length);      // transitive skill deps in topological order
console.log(mcps.length);

// Or resolve a skill (for tooling / dep inspection)
const { skill, skills: deps } = await catalog.resolveSkill("squad-lint");
console.log(skill.fqn);          // "public/squad-lint"
console.log(deps.length);        // includes squad-lint + transitive deps

// Update / uninstall
await catalog.updateSkill({ name: "sop", sourceDir: "/tmp/sop-v2" });
await catalog.uninstallMcp("playwright");
```

## Errors

All errors thrown by the public API extend `CatalogError`:

- `NameInvalid` — name is not kebab-case or empty
- `NameConflict` — install/install with a name already in catalog
- `NotFound` — get/update/uninstall a skill or mcp that does not exist
- `MissingDependencies` — declared dependencies are not in the catalog
- `CycleDetected` — install/update would create a dependency cycle
- `HasDependents` — uninstall blocked because something still depends on the target
- `FrontmatterError` — SKILL.md frontmatter is malformed

## GitHub authentication

When installing from a `https://github.com/...` origin, the catalog fetcher
resolves a default token from a two-tier fallback chain:

1. **`GITHUB_TOKEN` / `GH_TOKEN` env var** — if set, used as-is. CI
   environments (GitHub Actions injects `GITHUB_TOKEN` automatically) and
   advanced users who want to force a specific token hit this branch.
2. **`gh auth token --hostname github.com`** — if the [GitHub CLI][gh] is
   installed and authenticated, the fetcher captures its token. Cached
   per-host for 60 seconds so a deep dependency closure doesn't spawn `gh`
   on every fetch. emploke never persists the token.
3. **Anonymous** — no `Authorization` header. Public repos work; private
   repos return HTTP 404.

[gh]: https://cli.github.com/

### Installing from EMU / SSO-protected orgs

For EMU (Enterprise Managed Users) accounts or any github.com org behind
SAML SSO, the workflow is:

```sh
# One time — adds the EMU account alongside any existing accounts.
gh auth login --hostname github.com --web --git-protocol https

# When you want emploke to install from the EMU-protected org:
gh auth switch --user <your-emu-username>

# Then start emploke. The fetcher picks up the EMU token automatically.
pnpm dev
```

Notes:

- A PAT created manually on `github.com/settings/tokens` must be
  authorised for the enterprise via the **"Configure SSO"** button on the
  PAT row — otherwise the API returns HTTP 404 even with a valid-looking
  token. Tokens minted by `gh auth login` get this for free.
- Switching the active `gh` account takes up to 60 seconds to be reflected
  by a long-running emploke process (the cache TTL). Restart emploke for
  instant effect.
- To force a specific token regardless of `gh` state, set
  `GITHUB_TOKEN=…` in the environment — it always wins over the fallback.

## Design

See the [emploke repository](https://github.com/LangSensei/emploke) for the rationale behind the API shape, the CQRS-flavoured read/write split, and the deliberately narrow scope.

## License

MIT
