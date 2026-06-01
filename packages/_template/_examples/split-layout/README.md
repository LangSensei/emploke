# `_examples/split-layout/` — facade + sibling subdir reference shape

## Why this exists

The hard rules at [`docs/pkg-template.md § Splitting big files via facade + sibling subdir`](../../../../docs/pkg-template.md#splitting-big-files-via-facade--sibling-subdir) describe the convention in prose. Prose alone is hard to copy — a contributor about to split their `<entity>-service.ts` for the first time wants a real on-disk shape with real concern files they can rename and adapt. That is what this directory is: a self-contained, fully-rule-compliant SPLIT skeleton living next to the package template so the scaffolder's intended "after the file outgrows the threshold" state is visible without leaving the template package.

These files are **documentation that happens to be on disk**. They are NOT built, NOT typechecked under any package's `tsconfig.json`, and NOT run by any test. The leading underscores on `_examples/` (and on the parent `_template/`) keep this dir out of the structural classifier in `packages/task/test/split-convention.test.ts` — see the `entry.name.startsWith("_")` skip in `walkSrcDirs` — and the scaffolder (`scripts/new-pkg.mjs`) skips this dir when copying so new packages do not inherit it.

## What it demonstrates

Each rule from `docs/pkg-template.md § Hard rules` mapped to its concrete artifact:

| Rule  | Demonstrated by                                                                                                          |
|-------|--------------------------------------------------------------------------------------------------------------------------|
| **#1** Subdir basename equals facade basename AND is a direct sibling | `__entity-kebab__-service.ts` next to `__entity-kebab__-service/` in the same directory. |
| **#2** No barrel inside the subdir                                    | The subdir contains `types.ts`, `queries.ts`, `mutations.ts`, `lifecycle.ts`, `_helpers.ts` — no `index.ts`. |
| **#3** Subdir files are package-private                               | The facade is the only thing a downstream `index.ts` would re-export; concern files are never named in the public barrel. |
| **#4** Concern files use bare names                                   | `queries.ts`, `mutations.ts`, `lifecycle.ts` — no `__entity-kebab__-queries.ts` prefix. |
| **#5** Each concern file ≤ ~450 LOC; no nesting                       | The skeleton concerns stay tiny; there is no `queries/by-id.ts` subdir. |
| **#5a** No nested SPLIT inside a SPLIT                                | The subdir is one level deep; no further sibling-name dirs appear inside it. |
| **#6** Facade ≤ ~250 LOC, only ctx construction + 1-line delegates    | `__entity-kebab__-service.ts` does exactly that and stays under 100 LOC. |
| **#7** Shared context                                                 | Facade builds `__Entity__ServiceCtx` once (defined in `__entity-kebab__-service/types.ts`) and passes it to every concern function. No `this`-casting, no field-visibility widening. |

The `_helpers.ts` file inside the subdir demonstrates the package-private utility seam:
extract a helper here when **the same logic appears in two or more concern files** (e.g. an
ISO-timestamp parser used by both `queries.ts` and `mutations.ts`). The leading `_` on
the filename is the same "package-private utility" signal as the top-level `_shared.ts`
files cited in `docs/pkg-template.md § When NOT to use this pattern`. If a helper is used
inside only one concern, keep it private to that concern instead.

## How to apply

When your real `<entity>-service.ts` outgrows the 600 LOC / 3-concern thresholds in `docs/pkg-template.md`:

1. **Copy the structure**, not the content. From this directory, replicate the facade file + the matching subdir + the concern peer files into your package's `src/`. Do not copy the placeholder file bodies — write your own logic.
2. **Rename the placeholders.** Search-and-replace `__entity-kebab__` → your kebab-case entity name (e.g. `task-service`, `workspace-service`), and `__Entity__` → your `PascalCase` entity name (e.g. `Task`, `Workspace`). The scaffolder's `__entity-kebab__` / `__Entity__` token substitution recipe is documented in `scripts/new-pkg.mjs`.
3. **Move methods into the appropriate concern peer file.** Pick one concern at a time: cut the read methods from your old flat service into `queries.ts`, the write methods into `mutations.ts`, the lifecycle hooks into `lifecycle.ts`. Each function takes `(ctx, …args)` as its first parameter. The facade keeps only constructor + ctx-build + 1-line delegates — see the canonical reference at `packages/task/src/task-service.ts`.
4. **Register the new split.** Add the new subdir's repo-relative path to `REQUIRED_SPLITS` in `packages/task/test/split-convention.test.ts`, and remove it from `EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION` if it was previously listed there. See `docs/pkg-template.md § Migration of existing big files (Registry maintenance)` for the rationale.

The canonical real-world reference (loaded with real concern code) is `packages/task/src/task-service.ts` + `packages/task/src/task-service/`. This example is the same shape stripped down to its placeholders so the structure is the foreground.
