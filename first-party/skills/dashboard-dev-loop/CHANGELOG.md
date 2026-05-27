# Changelog

## 1.0.0 (2026-05-27)

- Initial release. Process-lifecycle primitive for `pnpm -F @emploke/dashboard dev:mock:e2e` on port 5180, with a deterministic HTTP readiness gate, kill-tree teardown registered on PowerShell exit / bash trap, and a screenshot-path helper that pins the output convention at `<workspace>/.designer/<ISO8601>-<label>.png`. Screenshot capture itself is delegated to the `io.playwright/mcp` tool `browser_take_screenshot`; this skill owns the filename, the dependency owns the bytes.
