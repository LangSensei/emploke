# Error code reference

Every error from the emploke server has the envelope `{error, code?, ...}`. The CLI's `formatError` surfaces both the human message AND the `code`, like:

```
not found (HTTP 404, WorkspaceNotRegisteredError)
```

For `EntryNotReadyError` it also unpacks `agent` and `reason` into structured CTAs:

```
agent "writer" is not ready: prereqs not acknowledged (HTTP 409, EntryNotReadyError)
  agent: langsensei/writer
  cause: prereqs not acknowledged
  fix:   emploke catalog agent ack-prereqs langsensei/writer
```

When you see a `fix:` line, run that command verbatim — it's the canonical remediation.

## Where `code` values come from (two paths)

The server emits `code` from two different code paths, both ending up in the same `{error, code}` envelope:

1. **Typed-error allow-list** (`packages/server/src/routes/_shared.ts:SAFE_ERROR_NAMES`). When a route catches an error whose `name` is on this list, the name passes through to `code`. Most entries below come from this path.
2. **Inline literals** in handler code (`c.json({error, code: "BadRequest"}, 400)` etc). A small set of generic codes is hand-rolled this way.

Both are stable wire contracts. The distinction matters only if you're maintaining the server: adding a new typed error means adding to `SAFE_ERROR_NAMES`; adding a new inline code is just a string change.

## Full code table

| code | typical HTTP | meaning | fix |
|---|---|---|---|
| `WorkspaceNotRegisteredError` | 404 | The workspace id doesn't exist | `emploke workspace list` to find a real id |
| `WorkspaceNotFoundError` | 404 | Workspace metadata missing on disk | Re-create or restore from backup |
| `WorkspaceCorruptedError` | 500 | Workspace SQLite row is corrupted | Server-side issue; ask user to inspect logs |
| `WorkspaceAlreadyExistsError` | 409 | `workspace add` collided | Use a different name/workdir, or remove the existing one |
| `WorkspaceIdConflictError` | 409 | Same workspace id used twice in concurrent `add` | Retry once; if persistent, server bug |
| `WorkspacePathConflictError` | 409 | Two workspaces on the same workdir | Pick a different `--workdir` |
| `WorkspaceNameInvalidError` | 400 | Name fails validation | Use kebab-case, ASCII, no slashes |
| `WorkspaceIdInvalidError` | 400 | Bad id format | Get a real id via `workspace list` |
| `WorkspaceHasLiveTasksError` | 409 | Reload would orphan running task subprocesses | Cancel/wait for the tasks (`emploke task list --status running`), retry |
| `SessionNotFoundError` | 404 | Session id unknown | `emploke session list` to find it |
| `InvalidSessionIdError` | 400 | Malformed session id | Check the format (timestamp-shortuuid) |
| `SessionCorruptedError` | 500 | Session metadata corrupted on disk | Server-side; surface to user |
| `SessionIdAllocationFailedError` | 500 | Server couldn't mint a new session id | Retry; if persistent, server bug |
| `TaskNotFoundError` | 404 | Task id unknown | `emploke task list` to find it |
| `InvalidTaskIdError` | 400 | Malformed task id | Check the format |
| `CorruptedTaskError` | 500 | Task metadata column is corrupted | `emploke task rm <tid> --purge` to clean |
| `TaskIdAllocationFailedError` | 500 | Server couldn't mint a new task id | Retry; if persistent, server bug |
| `RuntimeDoesNotSupportTasksError` | 400 | Runtime can't dispatch tasks | Pick a runtime that does (e.g. copilot) |
| `RuntimeProvisionFailed` | 500 | Couldn't start the runtime process | Check runtime config; usually needs CLI binary on PATH |
| `RuntimeHeadlessLaunchFailed` | 500 | Runtime headless launch failed | Same as above |
| `RuntimeRefreshFailed` | 500 | Runtime metadata refresh failed | Often transient; retry |
| `EntryNotReadyError` | 409 | Agent is blocked — see `reason` | See "EntryNotReadyError reasons" below |
| `AgentNotFoundError` | 400 / 404 | Agent FQN not installed | `emploke catalog agent install <origin>` |
| `AgentNameInvalidError` | 400 | Bad agent name | Check `[a-z0-9-]+` and matching folder name |
| `AgentFrontmatterError` | 400 | Agent frontmatter validation failed | Read message; fix the YAML in upstream |
| `AgentOriginConflictError` | 409 | Two agents with same FQN, different origins | Decide which to keep, remove the other |
| `AgentPlanStaleError` | 400 | `planToken` expired (5-min TTL) or already used | Re-run `agent sync-resolve` |
| `SkillNotFoundError` | 404 | Skill FQN not installed | `emploke catalog skill install <origin>` |
| `SkillNameInvalidError` | 400 | Bad skill name | Same as agent |
| `SkillFrontmatterError` | 400 | Skill frontmatter validation failed | Read message; fix YAML upstream |
| `SkillOriginConflictError` | 409 | Two skills with same FQN, different origins | Pick one |
| `PlanStaleError` | 400 | Skill plan token expired/used | Re-run `skill sync-resolve` |
| `McpNotFoundError` | 404 | MCP not installed | `emploke catalog mcp install <origin> --name <fqn>` |
| `McpNameInvalidError` | 400 | Bad MCP FQN | Use `<namespace>/<short>` |
| `McpInvalidJsonError` | 400 | MCP JSON failed schema validation | Read message; fix the JSON |
| `McpOriginConflictError` | 409 | Two MCPs with same FQN, different origins | Pick one |
| `HasDependentsError` | 409 | Trying to remove an entry someone depends on | Remove dependents first, or use `--force`-equivalent if exposed |
| `CyclicDependencyError` | 400 | Install would create a cycle | Inspect the resolve plan; the chain is in the message |
| `ImmutableOriginError` | 405 | `update` / `patch` on a non-`file:` origin entry | Re-install the upstream version instead of editing |
| `OriginParseError` | 400 | Malformed origin URL | Check the URL format |
| `FetchError` | 502 | Couldn't fetch the origin (404, network error, etc) | Check the URL is reachable; transient — safe to retry |
| `NoEventsYet` | 404 | Runtime hasn't produced activity events yet | Wait, then retry |
| `NoTerminalFoundError` | 400 | Couldn't find a terminal to spawn the session in | Server-side; check OS terminal config |
| `TerminalSpawnFailedError` | 500 | Terminal spawn failed | Same |
| `UnsupportedPlatformError` | 400 | Operation not supported on this OS | No remedy; cross-platform gap |
| `BadRequest` | 400 | Generic 400 (malformed body, invalid query) | Read the message; fix the call |
| `NotFound` | 404 | Generic 404 (resource id not found) | Check the id; usually a typo or stale reference |
| `PlanTokenInvalid` | 410 | `--plan-token` was malformed, expired, or already consumed | Re-run the corresponding `... sync-resolve` to mint a fresh token |
| `internal error` (no `code`) | 500 | Server-side fault that escaped the safe-error allow-list | Server-side; surface to user with the request id from logs |

## EntryNotReadyError reasons

`EntryNotReadyError` always carries a `reason: BlockedReason` payload. The CLI auto-renders the matching CTA, but here's the cheat-sheet for AI logic:

| `reason` field | meaning | exact CLI fix |
|---|---|---|
| `disabledByUser: true` | Agent was manually disabled | `emploke catalog agent enable <fqn>` |
| `needsPrereqsAck: true` | User hasn't acknowledged the entry's `prereqs` | `emploke catalog agent ack-prereqs <fqn>` (or `skill ack-prereqs`) |
| `orphaned: true` | Skill/MCP installed but no agent references it | Either install an agent that uses it, or `emploke catalog skill rm <fqn>` |
| `missingDeps: [{kind, fqn}, ...]` | Listed dependencies aren't installed | For each: `emploke catalog <kind> install <origin>` (origin from upstream catalog) |
| `blockedDeps: [{kind, fqn}, ...]` | Listed dependencies are themselves blocked | Recursively apply this table to each dep |

A single `EntryNotReadyError` can carry multiple `reason` fields at once (e.g. both `needsPrereqsAck` AND `missingDeps`). The CLI prints one `cause:` line per active field; resolve all of them, then retry the original command.

If the CLI prints `cause: blocked (reason fields not recognized by this CLI version)`, the server has emitted a new `BlockedReason` variant the CLI doesn't know about. Inspect via the dashboard or upgrade the CLI for typed remediation.

## When you see no `code`

If stderr only contains a message like `internal error (HTTP 500)` with no `code`, that means the server intentionally suppressed the underlying error name (it wasn't on the safe-error allow-list — leaks paths, etc). You can't infer remediation from the message alone. Surface it to the user and ask them to check the server logs for the matching request id.
