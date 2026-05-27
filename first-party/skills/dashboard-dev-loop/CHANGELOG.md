# Changelog

## 1.0.1 (2026-05-27)

- fix(bash): replace `setsid` + negative-pid `kill` with a recursive `pgrep -P` descendant walk so the Bash variant works on macOS without `brew install util-linux`. Teardown semantics (TERM, 1-second grace, KILL) are preserved. Closes #217.

## 1.0.0 (2026-05-27)

- Initial release. Process-lifecycle primitive for `pnpm -F @emploke/dashboard dev:mock:e2e` on port 5180, with a deterministic HTTP readiness gate, kill-tree teardown registered on PowerShell exit / bash trap, and a screenshot-path helper that pins the output convention at `<workspace>/.designer/<ISO8601>-<label>.png`. Screenshot capture itself is delegated to the `io.playwright/mcp` tool `browser_take_screenshot`; this skill owns the filename, the dependency owns the bytes.
