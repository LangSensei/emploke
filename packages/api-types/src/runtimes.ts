/**
 * Per-runtime info advertised over `GET /api/runtimes`. Lives in
 * `@emploke/api-types` so both the server's `runtimesRoutes` handler
 * and the dashboard / CLI clients can typecheck against the same shape
 * without one package value-importing the other.
 *
 * Wire shape: `[{ kind: string, capabilities: object }]`. Capabilities
 * are pass-through from `Runtime.capabilities`; an empty object `{}`
 * means the runtime made no opt-in claims (the absence of a flag ===
 * unsupported, not unknown).
 *
 * The previous wire shape was a bare `string[]` of kinds. Bumping to
 * an object array is a breaking change for the dashboard but kept the
 * additive surface honest — clients that only needed kind names map
 * `.map(r => r.kind)` once at the api boundary.
 */
export interface RuntimeInfo {
  readonly kind: string;
  readonly capabilities: Record<string, unknown>;
}
