# Changelog

All notable changes to `@langsensei/emploke` are documented here. The
format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows pre-1.0 semantic versioning conventions
(breaking changes permitted on any release).

## Unreleased

### Breaking

- **`DELETE /api/workspaces/:id/tasks/:tid` now returns 409 on
  non-terminal tasks** (was: implicit `kill` + 200). Cancel the task
  first via `POST /api/workspaces/:id/tasks/:tid/cancel` (or
  `emploke task cancel <tid>`), then delete. ADR-001 §3.5 makes the
  two verbs orthogonal: only `cancel()` and `shutdown()` ever touch
  subprocesses now. The 409 body carries the structured envelope
  `{ error, code: "InvalidTransition", status: <current>, transition: "delete" }`
  so consumers can branch on `code` instead of parsing prose.
- **`Task.fail()` / `Task.cancel()` entity signatures changed**
  (in-process callers only). `fail(error: string, opts)` →
  `fail(failure: TaskFailure, opts)` where `TaskFailure` is now a
  5-variant discriminated union (`exited` / `signal` / `shutdown` /
  `orphan` / `internal`). `cancel(opts)` →
  `cancel(cancellation: TaskCancellation, opts)` where
  `TaskCancellation` is a 2-variant union (`user` / `orphan`).
  ADR-001 §3.12. Direct entity callers (custom orchestrators bypassing
  `TaskManager`) need to update; the HTTP / CLI / dashboard wire
  surfaces are additive at the consumer boundary (old consumers
  ignore the new fields).

### Added

- **`emploke task cancel <tid>`** — new CLI verb. Sends SIGTERM to
  the live subprocess and waits for the exit watcher to persist
  `status='cancelled'`. Stdout on success: `task <id> cancelled`.
  `--json` prints the updated Task as JSON. Exits 4 on a 409
  (already-terminal) with the typed `InvalidTransition` envelope.
  ADR-001 §3.7.
- **`POST /api/workspaces/:id/tasks/:tid/cancel`** — new HTTP route.
  No request body in v1. Response shapes:
  - `200 OK` + Task JSON (carries the new `cancellation` field).
  - `404 Not Found` — task missing.
  - `409 Conflict` — already terminal; body carries
    `{ error, code: "InvalidTransition", status: <prev>, transition: "cancel" }`.
  - `503 Service Unavailable` — manager is shutting down.
  ADR-001 §3.6.
- **`cancellation` field on the Task wire shape** — present iff
  `status === 'cancelled'`. Discriminated by `cancellation.kind`
  (`user` | `orphan`). ADR-001 §3.9.
- **Structured `failure` / `cancellation` discriminated unions** —
  `TaskFailure` carries `kind` + variant-specific extras (e.g.
  `exitCode` for `exited`, `signal` for `signal`). The dashboard
  branches on `kind` and renders typed copy per variant
  (`FailureBlock` / `CancellationBlock`). ADR-001 §3.12.
- **`ManagerShuttingDownError`** typed error class. Both `dispatch()`
  and `cancel()` throw this when `shutdown()` has been called; the
  route layer maps to 503 (was: bare `Error("…shutting down…")`
  collapsing to 400). ADR-001 §3.2.a.
- **`tasks` SQLite schema bumped to v3** with five additive nullable
  columns (`failure_kind`, `failure_exit_code`, `failure_signal`,
  `cancellation_kind`, `cancellation_message`). Legacy v2 rows with
  `failure_error` populated but no `failure_kind` are synthesised as
  `{ kind: 'internal', message }` at read time with a one-line warn.
  ADR-001 §3.12.

## 0.4.3 (2026-05-17)

(Pre-existing tag; see git log for prior releases.)
