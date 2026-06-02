/**
 * Shape returned by `GET /api/health`. Lives in `@emploke/api`'s
 * `contracts/` directory (not in the server package) because both ends
 * of the wire — the server route handler that produces it AND the CLI
 * / dashboard clients that consume it — need to agree on the shape
 * without one package value-importing the other.
 *
 * Sensitive values are deliberately NOT exposed: the endpoint is
 * unauthenticated so it can serve the dashboard backoff probe before
 * the user has supplied an API key, and so external monitors don't
 * need credentials. Anything you'd hide from a stranger on the
 * network does not belong here.
 */
export interface HealthResponse {
  /**
   * Always `"ok"` for now. Reserved as an enum for the future case
   * where the server can self-report `"degraded"` (e.g. a runtime is
   * missing, fs is read-only). Clients should treat any non-`"ok"`
   * value as "server is up but something is wrong" rather than
   * parse-faulting.
   */
  readonly status: "ok";
  /** Server package name, e.g. `"@emploke/server"`. */
  readonly name: string;
  /** Server semver, e.g. `"0.0.1"`. */
  readonly version: string;
  /** ISO 8601 UTC timestamp when this server process started. */
  readonly startedAt: string;
  /** Whole seconds since `startedAt`, computed at request time. */
  readonly uptimeSec: number;
  /**
   * ISO 8601 UTC timestamp at the moment the server formed this
   * response.
   *
   * Used by the dashboard to compute its clock skew against the server
   * (`offsetMs = Date.parse(serverNow) - clientNowAtFetch`). This way
   * filters like "tasks created in the last 7 days" use the server's
   * clock as the anchor, not the user's laptop clock — so a phone-on-LAN
   * dashboard, or a laptop whose NTP drifted, won't silently miss rows
   * that were just persisted by the server.
   */
  readonly serverNow: string;
}
