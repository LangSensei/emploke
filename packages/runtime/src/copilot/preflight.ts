/**
 * Server-bootstrap preflight for the Copilot runtime.
 *
 * Asserts that `@github/copilot-sdk` AND its transitive `@github/copilot`
 * CLI dep are present in the running process's module graph BEFORE the
 * server starts accepting traffic. Fail-fast — better to surface a
 * missing-dep misconfiguration at boot than to let every
 * `tasks.dispatch` fail with a silent `HTTP 400 internal error` later
 * on (the original symptom that motivated this preflight; see issue
 * `fix/copilot-sdk-packaging-chain`).
 *
 * # Why this exists (root cause)
 *
 * The SDK's `CopilotClient` resolves the bundled CLI binary at runtime
 * via `import.meta.resolve('@github/copilot/sdk')`. That call walks the
 * SDK module's own `node_modules` — which only exists when npm has
 * materialised both packages alongside our bundle. If either is missing
 * (e.g. the SDK was inlined into `bundle/emploke.js` and not declared
 * as a runtime dep of `@langsensei/emploke`, OR an operator deleted
 * the SDK from `node_modules` after install), the resolution throws
 * `ERR_MODULE_NOT_FOUND` at first dispatch and the request fails with
 * a generic "internal error" body. This preflight catches the SDK- and
 * CLI-missing failure modes at boot.
 *
 * # MODULE_NOT_FOUND vs ERR_PACKAGE_PATH_NOT_EXPORTED
 *
 * Step 2 below probes the CLI dep via CJS-style resolution
 * (`createRequire(sdkUrl).resolve('@github/copilot/sdk')`). The CLI's
 * `package.json` `exports` map declares only the ESM `import` condition
 * for the `./sdk` subpath, so the CJS resolver throws even when the
 * package is fully installed — but the thrown error code is
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, NOT a missing-module error. We
 * distinguish:
 *
 *   - `MODULE_NOT_FOUND` (CJS) or `ERR_MODULE_NOT_FOUND` (ESM) →
 *     package itself is unreachable on disk → fail the preflight
 *     (this is the packaging-chain bug we are guarding against)
 *   - `ERR_PACKAGE_PATH_NOT_EXPORTED` → package exists on disk; only
 *     the subpath isn't visible to the CJS resolver. The SDK's own
 *     ESM `import.meta.resolve` at runtime DOES honour the `import`
 *     condition and will succeed → preflight passes.
 *
 * This split lets us re-use the cheap, sync `createRequire` API for
 * presence-checking without false-positiving on packages that publish
 * ESM-only conditional exports.
 *
 * # Why this is a function, not in the constructor
 *
 * Two reasons:
 *
 *   1. Unit tests construct `CopilotRuntime` directly without going
 *      through a server boot; running the preflight in the constructor
 *      would force every test fixture (including ones that mock
 *      `headlessDeps.createClient` and never actually load the SDK)
 *      to satisfy a real install. Decoupling lets the test fixture
 *      stay light while the real `runServer` boot path still pays the
 *      check exactly once.
 *
 *   2. The preflight only protects the user-facing install path
 *      (npm-installed bundle). In monorepo source-mode dev the SDK
 *      always resolves via pnpm workspace symlinks; gating
 *      construction on a check that can never fail in dev would be
 *      noise. Wiring it explicitly at the bootstrap site makes the
 *      relationship between "this matters for shipped binaries" and
 *      "this runs at server start" legible at the call site.
 */

import { createRequire } from "node:module";
import { CopilotSdkUnavailableError } from "./errors.js";

/**
 * Resolver dependencies injected into {@link assertCopilotSdkResolvable}
 * so unit tests can drive the two resolution steps without monkey-
 * patching `import.meta.resolve` (which Node refuses) or spawning a
 * subprocess in a tmpdir. Production callers should pass no argument
 * (`assertCopilotSdkResolvable()` keeps the existing zero-arg
 * signature, so the call site in `runServer` is unaffected and the
 * public API of `@emploke/runtime` doesn't break).
 *
 * Both methods are synchronous on purpose — the production
 * implementations (`import.meta.resolve`, `createRequire(...).resolve`)
 * are sync as of Node 22, and the preflight runs on the boot path
 * where a Promise round-trip would just add latency.
 */
export interface CopilotPreflightDeps {
  /**
   * Resolve a bare specifier to a file URL, mirroring
   * `import.meta.resolve(spec)`. Throws on missing module (the Step 1
   * failure mode).
   */
  readonly resolveSpecifier: (spec: string) => string;
  /**
   * Build a CJS-style `require` rooted at the SDK's module URL,
   * mirroring `createRequire(sdkUrl)`. The returned require is then
   * used to probe the `@github/copilot/sdk` subpath in Step 2.
   */
  readonly createRequireAt: (sdkUrl: string) => NodeRequire;
}

const defaultDeps: CopilotPreflightDeps = {
  resolveSpecifier: (spec) => import.meta.resolve(spec),
  createRequireAt: (sdkUrl) => createRequire(sdkUrl),
};

/**
 * Run the Copilot SDK resolvability preflight. Returns void on success;
 * throws {@link CopilotSdkUnavailableError} on failure (caller should
 * let it propagate out of `runServer` so the operator sees the message
 * + cause chain on stderr).
 *
 * Two-step probe:
 *
 *   1. `@github/copilot-sdk` resolvable from this module — what the
 *      runtime adapter `import`s.
 *   2. `@github/copilot` (the CLI binary's package) resolvable FROM
 *      THE SDK'S OWN MODULE URL — mirrors the resolution the SDK
 *      itself does at runtime via `import.meta.resolve('@github/
 *      copilot/sdk')`. Scoped via `createRequire(sdkUrl)` because
 *      pnpm does NOT hoist transitive deps into the consuming
 *      package's node_modules; a naive resolve from preflight.ts
 *      would false-positive in monorepo dev (where the CLI dep is
 *      reachable via the SDK's virtual store but unreachable when
 *      the SDK is imported standalone — the user-install failure
 *      mode).
 *
 * Uses `import.meta.resolve` and `createRequire(...).resolve` (both
 * sync, stable in Node ≥ 22 per emploke's engines field). Neither
 * actually imports or executes the SDK, so we don't pay the SDK's
 * import cost at boot for a check that is purely about presence.
 *
 * See the module-level jsdoc for why we filter on the resolver's
 * error code to distinguish "package missing" from "subpath uses
 * ESM-only exports".
 *
 * The optional `deps` parameter is a test seam: production callers
 * (the `runServer` boot path) keep calling `assertCopilotSdkResolvable()`
 * with no arguments and get the real Node resolvers. Tests pass
 * synthetic deps that throw the codes under test, exercising every
 * branch of the catch logic without touching the real module graph.
 */
export function assertCopilotSdkResolvable(deps: CopilotPreflightDeps = defaultDeps): void {
  // Step 1: SDK itself must be present in *our* module graph.
  let sdkUrl: string;
  try {
    sdkUrl = deps.resolveSpecifier("@github/copilot-sdk");
  } catch (cause) {
    throw new CopilotSdkUnavailableError(cause as Error);
  }

  // Step 2: `@github/copilot` (the CLI binary's package, transitively
  // depended on by the SDK) must be present in *the SDK's* module
  // graph. `createRequire(sdkUrl)` re-roots the resolver at the SDK's
  // location so we see what the SDK itself would see at runtime,
  // independent of pnpm's hoisting behaviour.
  //
  // We probe the `/sdk` subpath because it's what the SDK itself
  // resolves at runtime — that's the canonical evidence of "the CLI
  // is wired up correctly". The CLI's `package.json` exports the
  // subpath under the ESM `import` condition only, so CJS resolution
  // (via `createRequire`) throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
  // even on a healthy install. We treat that error code as "package
  // is present, just ESM-only" → preflight passes.
  //
  // Every OTHER error code surfaces: missing-module (`MODULE_NOT_FOUND`
  // / `ERR_MODULE_NOT_FOUND` — the packaging-chain bug we are
  // guarding against), permission errors (`EACCES` — bad SDK file
  // mode), broken junctions (`ENOTDIR`), and any future Node
  // resolver error code we haven't named. The module-level jsdoc
  // says "we must fail loud" for Step 2; this denylist-of-one
  // brings the code into line with the doc, so a corrupted install
  // can't slip past the preflight just because Node grew a new
  // error code we didn't think to add to an allowlist.
  try {
    const requireFromSdk = deps.createRequireAt(sdkUrl);
    requireFromSdk.resolve("@github/copilot/sdk");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // ERR_PACKAGE_PATH_NOT_EXPORTED means the package itself is
    // reachable on disk; only the subpath isn't visible to the CJS
    // resolver. The SDK's own ESM `import.meta.resolve` at runtime
    // honours the `import` condition and will succeed → preflight
    // passes. This is the only swallow.
    if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return;
    throw new CopilotSdkUnavailableError(cause as Error);
  }
}
