# Changelog

All notable changes to `@emploke/server` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- `scripts.start` now invokes `dist/bin.js` (the foreground bin) instead of `dist/index.js` (the library module). Closes #286.

### Changed

- `scripts.typecheck` now type-checks both `src/**` and `test/**` via `tsconfig.typecheck.json` (matches the api / task pattern). The previously opt-in `typecheck:strict` script is removed (now equivalent to `typecheck`). Closes #285.
