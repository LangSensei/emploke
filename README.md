# Designer assets for PR #221

Orphan branch hosting before/after screenshots referenced from the body of
[LangSensei/emploke#221](https://github.com/LangSensei/emploke/pull/221).
The screenshots were captured against the MSW mock dashboard
(`pnpm -F @emploke/dashboard dev:mock:e2e` on port 5180) by the
`emploke/designer` agent.

| Label | Route | Trigger |
|---|---|---|
| schedules-list | `/workspaces/<wsId>/runtime/schedules` | default landing (paused-experiment auto-selected) |
| schedules-detail-enabled | `?scheduleId=sched-hourly-report` | enabled fixture with lastFiredAt |
| schedules-detail-disabled | `?scheduleId=sched-weekly-digest` | paused fixture without lastFiredAt |
| tasks-comparison | `/workspaces/<wsId>/runtime/tasks` | cross-page reference for consistency check |

These files exist only on this orphan branch and are not part of any
release. They're referenced via raw.githubusercontent.com URLs from
the PR body so reviewers can see before/after at a glance without
checking out the branch.
