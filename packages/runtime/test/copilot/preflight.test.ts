import { describe, expect, it } from "vitest";
import {
  assertCopilotSdkResolvable,
  type CopilotPreflightDeps,
  CopilotSdkUnavailableError,
} from "../../src/index.js";

/**
 * Tests for the server-bootstrap preflight that guards the
 * @github/copilot-sdk dependency chain.
 *
 * The function is a fail-fast check intended to run inside
 * `runServer` before the copilot runtime is registered. The
 * happy-path test confirms it runs to completion in the monorepo
 * test env (where pnpm workspace symlinks always materialise the SDK
 * AND its transitive @github/copilot CLI dep).
 *
 * The negative-path cases use the `CopilotPreflightDeps` injection
 * seam to drive both resolution steps from inside the test process
 * (no monkey-patching of `import.meta.resolve`, no subprocess
 * spawn). The production call site in `runServer` keeps the
 * zero-arg signature.
 *
 * What this DOES pin:
 *   - The function is exported from `@emploke/runtime`.
 *   - The error class is exported (so server bootstrap can catch /
 *     re-throw / type-check on it without depending on the
 *     `errors.js` internal path).
 *   - The success path returns void without throwing in dev.
 *   - Step 1 failure surfaces as CopilotSdkUnavailableError.
 *   - Step 2 missing-module failure surfaces as
 *     CopilotSdkUnavailableError (both code spellings).
 *   - Step 2 ERR_PACKAGE_PATH_NOT_EXPORTED is swallowed (healthy
 *     install — CLI publishes the subpath under ESM-only exports).
 *   - Step 2 EACCES (and any other code) surfaces — pins the
 *     denylist-of-one behaviour the explicit-filter change brought
 *     in (the previous allowlist would have swallowed EACCES).
 */

const FAKE_SDK_URL = "file:///fake/node_modules/@github/copilot-sdk/dist/index.js";

function makeDeps(overrides: Partial<CopilotPreflightDeps>): CopilotPreflightDeps {
  // A deps object that never throws by default — happy path that
  // each test then overrides one method on to exercise a single
  // failure mode without polluting the other step.
  const base: CopilotPreflightDeps = {
    resolveSpecifier: () => FAKE_SDK_URL,
    createRequireAt: () =>
      ({
        resolve: () => "/fake/node_modules/@github/copilot/sdk/index.js",
      }) as unknown as NodeRequire,
  };
  return { ...base, ...overrides };
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("assertCopilotSdkResolvable", () => {
  it("returns void when @github/copilot-sdk and @github/copilot are resolvable (monorepo env)", () => {
    expect(() => assertCopilotSdkResolvable()).not.toThrow();
  });

  it("exports CopilotSdkUnavailableError so callers can type-discriminate", () => {
    // Constructible with a synthetic cause; carries the install hint
    // in `.message` and chains the cause via `.cause` (ES2022).
    const cause = new Error("Cannot find module '@github/copilot-sdk'");
    const err = new CopilotSdkUnavailableError(cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CopilotSdkUnavailableError);
    expect(err.name).toBe("CopilotSdkUnavailableError");
    expect(err.message).toContain("@github/copilot-sdk");
    expect(err.message).toContain("npm install");
    // The brief message includes the cause's message so operators
    // see the underlying ERR_MODULE_NOT_FOUND chain without a
    // separate stderr write.
    expect(err.message).toContain("Cannot find module");
    expect(err.cause).toBe(cause);
  });

  it("Step 1 fails: resolveSpecifier throws ERR_MODULE_NOT_FOUND → CopilotSdkUnavailableError wraps it", () => {
    // The packaging-chain failure mode: the SDK itself isn't in our
    // node_modules (e.g. the published bundle forgot to declare
    // @github/copilot-sdk as a runtime dep). import.meta.resolve
    // throws an Error whose `code` is `ERR_MODULE_NOT_FOUND`.
    const cause = errnoError("Cannot find package '@github/copilot-sdk'", "ERR_MODULE_NOT_FOUND");
    const deps = makeDeps({
      resolveSpecifier: () => {
        throw cause;
      },
    });
    expect(() => assertCopilotSdkResolvable(deps)).toThrow(CopilotSdkUnavailableError);
    try {
      assertCopilotSdkResolvable(deps);
    } catch (err) {
      // .cause chains to the original Node resolver error so
      // operators see the underlying ERR_MODULE_NOT_FOUND on stderr.
      expect((err as CopilotSdkUnavailableError).cause).toBe(cause);
    }
  });

  it("Step 2 fails with MODULE_NOT_FOUND (CJS resolver) → CopilotSdkUnavailableError", () => {
    // The SDK is reachable but its transitive @github/copilot CLI
    // dep isn't — the bundle pulled the SDK in but didn't bring its
    // peers along. createRequire(sdkUrl).resolve(...) throws an
    // Error whose `code` is `MODULE_NOT_FOUND` (CJS spelling).
    const cause = errnoError("Cannot find module '@github/copilot/sdk'", "MODULE_NOT_FOUND");
    const deps = makeDeps({
      createRequireAt: () =>
        ({
          resolve: () => {
            throw cause;
          },
        }) as unknown as NodeRequire,
    });
    expect(() => assertCopilotSdkResolvable(deps)).toThrow(CopilotSdkUnavailableError);
    try {
      assertCopilotSdkResolvable(deps);
    } catch (err) {
      expect((err as CopilotSdkUnavailableError).cause).toBe(cause);
    }
  });

  it("Step 2 fails with ERR_PACKAGE_PATH_NOT_EXPORTED → swallowed (healthy ESM-only install)", () => {
    // The CLI's package.json exports the ./sdk subpath under the
    // ESM `import` condition only, so CJS resolution throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED even on a fully-installed
    // happy path. The SDK's own ESM resolver at runtime will
    // succeed → preflight must not fail.
    const cause = errnoError(
      "No 'exports' main defined in package.json for ./sdk",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
    const deps = makeDeps({
      createRequireAt: () =>
        ({
          resolve: () => {
            throw cause;
          },
        }) as unknown as NodeRequire,
    });
    expect(() => assertCopilotSdkResolvable(deps)).not.toThrow();
  });

  it("Step 2 fails with EACCES → CopilotSdkUnavailableError (denylist-of-one surfaces everything else)", () => {
    // EACCES is the canonical case for the denylist-of-one filter:
    // every resolver error code EXCEPT ERR_PACKAGE_PATH_NOT_EXPORTED
    // must surface the preflight failure, so a corrupted install with
    // the wrong file mode on the CLI binary fails loudly at boot
    // instead of slipping past as a no-op and exploding later at
    // dispatch time.
    const cause = errnoError("EACCES: permission denied", "EACCES");
    const deps = makeDeps({
      createRequireAt: () =>
        ({
          resolve: () => {
            throw cause;
          },
        }) as unknown as NodeRequire,
    });
    expect(() => assertCopilotSdkResolvable(deps)).toThrow(CopilotSdkUnavailableError);
    try {
      assertCopilotSdkResolvable(deps);
    } catch (err) {
      expect((err as CopilotSdkUnavailableError).cause).toBe(cause);
    }
  });
});
