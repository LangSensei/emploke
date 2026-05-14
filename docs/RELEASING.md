# Releasing emploke

Maintainer-only. Customer-facing install instructions live in the root
[`README.md`](../README.md).

## How releases work

The `@langsensei/emploke` npm package is published by a tag-triggered
GitHub Actions workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)).
Tag a version, push, and the workflow builds the bundle, publishes to
npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC, no long-lived token), and creates a GitHub Release with
auto-generated notes.

## Cutting a release

`main` is branch-protected — direct pushes are refused. The
`npm version` shortcut documented in many node-project READMEs assumes
you can push the bump commit straight to `main`, which doesn't apply
here. Use the two-step flow below.

### Step 1: bump `package.json` via PR

```sh
git checkout main && git pull
git checkout -b chore/release-vX.Y.Z
npm version <patch|minor|major> --no-git-tag-version
#   ^ writes the new version into package.json but does NOT commit
#     and does NOT create a tag — those happen later, on main.
git commit -am "chore(release): vX.Y.Z"
git push -u origin chore/release-vX.Y.Z
gh pr create --title "chore(release): vX.Y.Z" --base main
# review + merge the PR through normal channels
```

### Step 2: tag the merge commit, push the tag

```sh
git checkout main && git pull
git tag vX.Y.Z          # e.g. v0.2.0 — no `npm version` here, just git tag
git push origin vX.Y.Z
```

The tag push triggers `release.yml`, which:

1. Verifies the tag's version matches `package.json` (would catch a typo).
2. Builds the bundle (`prepublishOnly: pnpm bundle` in root `package.json`).
3. Publishes via `npm publish --provenance --access public` over OIDC.
4. Creates a GitHub Release for the tag with auto-generated notes (`gh release create --generate-notes`). Prereleases get marked as such so the GitHub UI doesn't promote them as the latest stable.

If you forget step 2 after step 1, nothing breaks — the bumped
`package.json` is on `main` but no release happens until a tag is
pushed. The next attempt to bump (`npm version` from the new state)
would compute the next version up.

### Why two steps?

The `npm version <patch|minor|major>` shortcut tries to do bump +
commit + tag + push in one shot. Two of those (commit + push) are
blocked by `main`'s branch protection, and the third (tag) needs to
point at the *merged* commit, not the local one. Splitting the steps
keeps the tag pointing at the actual commit that ships, which is what
the npm provenance attestation will record.

## Prereleases

```sh
git checkout main && git pull
git checkout -b chore/release-vX.Y.Z-rc.0
npm version prerelease --preid=rc --no-git-tag-version   # 0.2.0 → 0.2.1-rc.0
git commit -am "chore(release): vX.Y.Z-rc.0"
git push -u origin chore/release-vX.Y.Z-rc.0
gh pr create --base main
# merge, then:
git checkout main && git pull
git tag vX.Y.Z-rc.0
git push origin vX.Y.Z-rc.0
```

Versions containing a `-` (e.g. `0.2.1-rc.0`) are published with the `next`
npm dist-tag rather than `latest`, so `npm install -g @langsensei/emploke`
keeps installing the stable line. The matching GitHub Release is also
marked as a prerelease so the repo's Releases page does not promote it
as the latest stable.

## Safety rails

- The workflow refuses to publish if the git tag's version doesn't match
  `package.json`. (Tag `v0.2.1` against a `package.json` claiming `0.2.0`
  fails the build — manual desync can't slip through.)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  is enabled, so the package page links back to the exact commit + workflow
  run that built each release.

## Recovering from a botched release

If the release workflow fails on a tag push (npm registry hiccup, transient
CI issue, the v0.2.0 npm self-upgrade race that bit us once), the tag
exists on the remote but the package wasn't published. Two recovery paths:

### Same version, fixed workflow

If the fix is in the workflow itself (or any non-source file) and you want
to reuse the same version number:

```sh
# 1. PR + merge the workflow fix to main
# 2. Move the tag to the merge commit
git tag -d vX.Y.Z                       # delete local
git push origin :refs/tags/vX.Y.Z       # delete remote
git checkout main && git pull
git tag vX.Y.Z                          # re-tag at the new HEAD
git push origin vX.Y.Z                  # triggers workflow again
```

### Bump to a new version

If the source itself is broken, just cut a fresh release with a higher
version following the normal two-step flow above. Don't try to re-publish
the same version with different bytes — npm forbids overwrite.

### npm published but GitHub Release missing

If `npm publish` succeeded but the `Create GitHub Release` step failed
(rare — usually a transient `gh` API hiccup), npm has the package and
the tag exists but the Releases page is missing the entry. Recover with:

```sh
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
# Add `--prerelease` for prereleases (versions with a `-`).
```

No need to re-tag or re-publish — the npm side is already done.

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
