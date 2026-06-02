# @emploke/__PKG__

TODO: replace this README with a short description of what the
__PKG__ package owns.

A new pkg's README should describe **this package's** bounded
context, public surface, and any package-specific notes — NOT
re-state the monorepo-wide conventions. Those live in
[`docs/pkg-template.md`](../../docs/pkg-template.md) and apply
verbatim:

- Per-pkg `src/` layout, file naming, `<entity>-<role>.ts` prefix
  rule, where DTOs live → `docs/pkg-template.md` §§ Layout, File
  naming convention, Where DTOs live.
- Test placement (mirror src; flat-only for cross-cutting) →
  `docs/pkg-template.md § Test layout convention`.
- When and how to split a service into facade + sibling subdir →
  `docs/pkg-template.md § Splitting big files via facade + sibling
  subdir`. A self-contained reference shape with placeholder names
  lives at
  [`packages/_template/_examples/split-layout/`](./_examples/split-layout/).
- Inline catch-block error normalization (no `utils/errors.ts`) →
  `docs/pkg-template.md § Catch-block error normalization`.

## Boundary

Downstream packages depend on `__Entity__Service` directly, OR on a
narrow capability interface declared in the downstream package itself
(e.g. `@emploke/runtime`'s `AgentContentSource`).

## Naming check (PR review)

PR review must mechanically diff the new pkg's file tree against
`packages/_template/` + sibling pkgs' naming. Any divergence from
the conventions cited above requires a written justification in
the PR body.
