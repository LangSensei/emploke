# Releasing emploke

Maintainer-only. Customer-facing install instructions live in the root
[`README.md`](../README.md).

## How releases work

The `@langsensei/emploke` npm package is published by a tag-triggered
GitHub Actions workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)).
Tag a version, push, the workflow builds the bundle and publishes via
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC,
no long-lived token).

## Cutting a release

```sh
npm version patch        # bumps package.json + creates v<X.Y.Z> tag + commit
git push --follow-tags   # pushes commit + tag → workflow runs → npm publish
```

Use `minor` / `major` instead of `patch` per [semver](https://semver.org/)
as appropriate.

## Prereleases

```sh
npm version prerelease --preid=rc   # 0.2.0 → 0.2.1-rc.0
git push --follow-tags
```

Versions containing a `-` (e.g. `0.2.1-rc.0`) are published with the `next`
npm dist-tag rather than `latest`, so `npm install -g @langsensei/emploke`
keeps installing the stable line.

## Safety rails

- The workflow refuses to publish if the git tag's version doesn't match
  `package.json`. (Tag `v0.2.1` against a `package.json` claiming `0.2.0`
  fails the build — manual desync can't slip through.)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  is enabled, so the package page links back to the exact commit + workflow
  run that built each release.

## One-time setup (already done)

[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) is
configured on the package so the workflow can publish via OIDC without a
long-lived token. On the npm package settings page (Publishing access →
Trusted Publishers), the GitHub Actions trusted publisher entry is:

| Field                | Value         |
| -------------------- | ------------- |
| Organization or user | `LangSensei`  |
| Repository           | `emploke`     |
| Workflow filename    | `release.yml` |
| Environment          | *(blank)*     |

Trusted Publishing replaces classic automation tokens, which since
October 2025 cap out at 90-day expiry. The OIDC token is short-lived,
scoped to one workflow run, and managed entirely by npm + GitHub — no
`NPM_TOKEN` repo secret to maintain.

## Bundle layout

`pnpm bundle` produces `bundle/emploke.js` plus `bundle/static/` (the
dashboard SPA). The bundle inlines the server + every workspace package +
`hono` / `js-yaml` / etc. The pino logger family (`pino`, `pino-pretty`,
`pino-roll`) is intentionally **not** inlined — pino loads transports
through `worker_threads` with runtime-resolved paths, which can't survive
bundling. Those three packages are declared as runtime `dependencies` in
the root `package.json` and pulled by `npm install -g`.
