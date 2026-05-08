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

The layout is hard-coded:

```
<root>/
├── skills/
│   └── <name>/
│       └── SKILL.md          ← frontmatter + Markdown body, full file preserved on install
└── mcps/
    └── <name>.json           ← single JSON file, content opaque to emploke
```

## Quick start

```ts
import { Catalog } from "@emploke/catalog";

const catalog = await Catalog.open({ catalogDir: "/path/to/workspace/catalog" });

// Install
await catalog.installSkill({ sourceDir: "/tmp/sop-prepared" });
await catalog.installMcp({ name: "playwright", json: { type: "stdio", command: "npx", args: ["@modelcontextprotocol/server-playwright"] } });

// Resolve
const { agent, agentPath, skills, mcps } = await catalog.resolveAgent("code-reviewer");
console.log(agentPath);          // <root>/agents/code-reviewer
console.log(skills.length);      // transitive skill deps in topological order
console.log(mcps.length);

// Or resolve a skill (for tooling / dep inspection)
const sk = await catalog.resolveSkill("squad-lint");
console.log(sk.skillPath);       // <root>/skills/squad-lint
console.log(sk.skills.length);   // includes squad-lint + transitive deps

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

## Design

See the [emploke repository](https://github.com/LangSensei/emploke) for the rationale behind the API shape, the CQRS-flavoured read/write split, and the deliberately narrow scope.

## License

MIT
