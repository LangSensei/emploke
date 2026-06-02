import { describe, expect, it } from "vitest";
import { pwshEnvPrefix, shExportPrefix } from "../src/_shared.js";

/**
 * Regression test for the defence-in-depth filter inside the env
 * prefix builders (`shExportPrefix`, `pwshEnvPrefix` in `_shared.ts`).
 *
 * The typed contract for `LaunchCommand.env` is
 * `Readonly<Record<string, string>>`, but an `undefined` value can
 * still slip in via an unchecked `as`-cast over `NodeJS.ProcessEnv`
 * at the assembly site. Without this filter, `shQuote(value)` /
 * `pwshQuote(value)` would crash on the `undefined` with
 * "Cannot read properties of undefined (reading 'replace')". The
 * primary guard lives upstream where the env bag is assembled; this
 * test pins the secondary guard inside the prefix builders so an
 * upstream regression cannot reach the crashing path — the builders
 * drop the bad entry and emit the rest verbatim.
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
