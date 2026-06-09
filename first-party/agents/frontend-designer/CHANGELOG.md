# Changelog

## 1.0.0 (2026-06-04)

- Initial release in the first-party catalog. Promoted verbatim from `local/frontend-designer` 1.0.0 (only change: `scope: local` → `scope: emploke`; agent body byte-identical to local source). Original entry below is preserved as provenance.
- Initial release. Local agent for the emploke dashboard.
- Two operating modes:
  - **MODE: spec** — author implementation-ready UI/UX specifications anchored in the dashboard's existing `styles.css` design tokens and breakpoints (640 / 768 / 1024).
  - **MODE: review** — Playwright-driven evidence-based review of dashboard-touching PRs, served from `pnpm --filter @emploke/dashboard dev:mock:e2e` on port 5180.
- Dependencies: `emploke/git-pr` skill (worktree handling), `io.playwright/mcp` MCP (browser automation).
- Defaults to REQUEST_CHANGES in review mode unless evidence overwhelmingly supports approval (Reality Checker discipline).
- Deliberately scope-limited to `packages/dashboard/` — backend and catalog work stays with `emploke/dev` and `emploke/review`.
