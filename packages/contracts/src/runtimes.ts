/**
 * Per-runtime info advertised over `GET /api/runtimes`. Lives in
 * `@emploke/contracts` so both the server's `runtimesRoutes` handler
 * and the dashboard / CLI clients can typecheck against the same
 * shape without one package value-importing the other.
 *
 * Wire shape: `[{ kind: string, capabilities: object }]`. Capabilities
 * are pass-through from `Runtime.capabilities`; an empty object `{}`
 * means the runtime made no opt-in claims (the absence of a flag ===
 * unsupported, not unknown).
 */
export interface RuntimeInfo {
  readonly kind: string;
  readonly capabilities: Record<string, unknown>;
}
