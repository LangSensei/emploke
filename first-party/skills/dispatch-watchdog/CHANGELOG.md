# Changelog

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
