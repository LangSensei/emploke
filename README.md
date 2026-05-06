# Emploke

> *From εμπλοκή (emplokí) — entanglement.*
>
> A TypeScript toolkit for managing and orchestrating agentic systems on top of [Anthropic Claude Skills](https://www.claude.com/news/agent-skills) and [Model Context Protocol](https://modelcontextprotocol.io) servers.

> **Note**: This is a TypeScript rewrite in progress. The previous Go axiom kernel is preserved unchanged under [`archive/`](./archive/) and continues to be built/tested by CI.

## Status

| Package | Description | Status |
|---|---|---|
| [`@emploke/catalog`](./packages/catalog) | File-system registry of skills + MCPs with dependency-graph algorithms | ✅ in progress (this PR) |

## Design

The TypeScript rewrite is structured as a pnpm monorepo. The first package, [`@emploke/catalog`](./packages/catalog), owns a single concern: maintaining a local marketplace directory of skills + MCPs with their dependency graph (resolve in topological order, reject cycles, block uninstall when something still depends on you).

Subsequent packages will layer on top of catalog (task lifecycle / substrates / conformance suite) — see prior Go work in [`archive/`](./archive/) and the [design book](https://langsensei.github.io/emploke/) for background.

## Development

This repo is a [pnpm workspace](https://pnpm.io/workspaces). Requires Node ≥ 20, pnpm ≥ 10.

```sh
pnpm install
pnpm typecheck   # tsc --noEmit across all packages
pnpm test        # vitest across all packages
pnpm lint        # biome check
pnpm build       # tsc emit
```

## Design book (archived Go axiom kernel)

The original architectural rationale — six-state Task lifecycle, Concurrency Contract, Observability floor — lives in [`docs/index.html`](docs/index.html).

Read online: **<https://langsensei.github.io/emploke/>**

The book is bilingual (English + 中文).

## License

MIT
