# Changelog

## 1.0.0 (2026-05-27)

- Initial release. Designer agent for mock-driven `packages/dashboard` UI iteration. Depends on the `emploke/dashboard-dev-loop` skill for dev-server lifecycle + screenshot conventions and on the `io.playwright/mcp` MCP for browser automation. Scoped to UI changes under `packages/dashboard/src/**` with embedded before/after screenshots in every PR body.
