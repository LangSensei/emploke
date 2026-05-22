import { describe, expect, it } from "vitest";
import { pwshEnvPrefix, shExportPrefix } from "../src/_shared.js";

/**
 * Regression test for the defence-in-depth filter added to the env
 * prefix builders.
 *
 * Original bug (PR #148 round 1): the windows terminal spawner
 * crashed with "Cannot read properties of undefined (reading
 * 'replace')" when `LaunchCommand.env` contained an `undefined`
 * value. Root cause was in CopilotRuntime (mixed scrub semantic in
 * the base env bag, fixed at the source).
 *
 * This test pins the secondary guard inside `_shared.ts`: even if a
 * future regression re-introduces an undefined env value upstream,
 * the prefix builders must NOT crash. They drop the bad entry and
 * emit the rest verbatim.
 */
describe("env prefix builders: defence-in-depth undefined filter", () => {
  it("shExportPrefix skips undefined values without throwing", () => {
    const env = {
      KEEP: "yes",
      // biome-ignore lint/suspicious/noExplicitAny: regression probe
      DROP_UNDEF: undefined as any,
      // biome-ignore lint/suspicious/noExplicitAny: regression probe
      DROP_NULL: null as any,
    } as Record<string, string>;
    const out = shExportPrefix(env);
    expect(out).toContain("KEEP='yes'");
    expect(out).not.toContain("DROP_UNDEF");
    expect(out).not.toContain("DROP_NULL");
  });

  it("pwshEnvPrefix skips undefined values without throwing", () => {
    const env = {
      KEEP: "yes",
      // biome-ignore lint/suspicious/noExplicitAny: regression probe
      DROP_UNDEF: undefined as any,
      // biome-ignore lint/suspicious/noExplicitAny: regression probe
      DROP_NULL: null as any,
    } as Record<string, string>;
    const out = pwshEnvPrefix(env);
    expect(out).toContain("$env:KEEP = 'yes'");
    expect(out).not.toContain("DROP_UNDEF");
    expect(out).not.toContain("DROP_NULL");
  });

  it("returns empty string when EVERY entry is filtered out", () => {
    const env = {
      // biome-ignore lint/suspicious/noExplicitAny: regression probe
      A: undefined as any,
      // biome-ignore lint/suspicious/noExplicitAny: regression probe
      B: undefined as any,
    } as Record<string, string>;
    expect(shExportPrefix(env)).toBe("");
    expect(pwshEnvPrefix(env)).toBe("");
  });
});
