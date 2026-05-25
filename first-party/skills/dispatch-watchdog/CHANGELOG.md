# Changelog

## 1.1.1 (2026-05-25)

### Fixed

- PowerShell primitive: status parse silently failed because the
  documented `$raw = & emploke task show … --json` returns
  `System.String[]` in PowerShell, and the subsequent `-match` against
  the array does not populate `$Matches[1]` reliably. The `$status`
  variable was therefore always empty, the terminal-status check never
  fired, and the watchdog ran forever instead of exiting and signalling
  completion to the runtime. Fix: `-join` the array into a single
  string before the regex match. Added an explicit anti-pattern bullet
  and a post-spawn sanity-check step (caller contract item 5) to catch
  the failure mode early if it recurs in a different form.

### Audited (no change)

- Bash primitive — `$(...)` command substitution joins to a single
  string, `printf | sed` is stream-based; no equivalent bug.

## 1.1.0

- Caller contract: added item 4 mandating a 5-second "verify started"
  check against the first log line, plus made the mtime-based
  liveness rule (2× poll interval) explicit in item 2. Fixes a
  silent-failure mode where a watchdog spawned with bad args looks
  "running" from the runtime's POV but never emits notifications.
- PowerShell and bash example bodies now emit a
  `watchdog started for <tid>` line on entry so callers have a
  deterministic marker to verify.

## 1.0.0

- Initial release under `emploke/dispatch-watchdog`. Migrated from `langsensei/dispatch-watchdog` in the community marketplace and relocated into the emploke first-party catalog.
