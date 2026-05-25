import { describe, expect, it } from "vitest";
import { assertCopilotSdkResolvable, CopilotSdkUnavailableError } from "../../src/index.js";

/**
 * Tests for the server-bootstrap preflight that guards the
 * @github/copilot-sdk dependency chain.
 *
 * The function is a fail-fast check intended to run inside
 * `runServer` before the copilot runtime is registered. The
 * happy-path test confirms it runs to completion in the monorepo
 * test env (where pnpm workspace symlinks always materialise the SDK
 * AND its transitive @github/copilot CLI dep). The negative path is
 * not exercised here because faking an unresolvable specifier from
 * within a running test process would require either monkey-patching
 * import.meta.resolve (Node refuses) or spawning a subprocess in a
 * tmpdir without node_modules (covered indirectly by the e2e bundle
 * smoke).
 *
 * What this DOES pin:
 *   - The function is exported from `@emploke/runtime`.
 *   - The error class is exported (so server bootstrap can catch /
 *     re-throw / type-check on it without depending on the
 *     `errors.js` internal path).
 *   - The success path returns void without throwing in dev.
 */
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
});
