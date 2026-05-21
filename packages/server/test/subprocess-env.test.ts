import { describe, expect, it } from "vitest";
import { buildSubprocessEnvBase, SUBPROCESS_ENV_SCRUB_KEYS } from "../src/subprocess-env.js";

describe("buildSubprocessEnvBase", () => {
  it("emits EMPLOKE_SERVER + EMPLOKE_SHARED_DIR", () => {
    const env = buildSubprocessEnvBase({
      hostname: "127.0.0.1",
      port: 8787,
      sharedDir: "/var/lib/emploke",
    });
    expect(env.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
    expect(env.EMPLOKE_SHARED_DIR).toBe("/var/lib/emploke");
  });

  it("rewrites 0.0.0.0 wildcard to loopback for the dialable URL", () => {
    // Children of the server live on the same host. Dialing 0.0.0.0 is
    // platform-specific (Windows refuses outright), and there is no
    // case where a child should ever try to. Loopback is the only
    // address guaranteed to work from a same-host child.
    const env = buildSubprocessEnvBase({
      hostname: "0.0.0.0",
      port: 8787,
      sharedDir: "/h",
    });
    expect(env.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
  });

  it("rewrites :: (IPv6 wildcard) to loopback for the same reason", () => {
    const env = buildSubprocessEnvBase({
      hostname: "::",
      port: 9999,
      sharedDir: "/h",
    });
    expect(env.EMPLOKE_SERVER).toBe("http://127.0.0.1:9999");
  });

  it("preserves explicit non-wildcard hostnames (e.g. LAN bind)", () => {
    const env = buildSubprocessEnvBase({
      hostname: "192.168.1.10",
      port: 8787,
      sharedDir: "/h",
    });
    expect(env.EMPLOKE_SERVER).toBe("http://192.168.1.10:8787");
  });

  it("freezes the returned object so accidental mutations fail loudly", () => {
    // The returned env is shared by reference into every per-workspace
    // TaskService (via PerWorkspaceContainerCache). Concurrency-safety
    // depends on it being immutable — a stray mutation would silently
    // poison every subsequent task across every workspace. Freeze
    // turns that footgun into a TypeError in strict mode.
    const env = buildSubprocessEnvBase({
      hostname: "127.0.0.1",
      port: 8787,
      sharedDir: "/h",
    });
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      (env as { EMPLOKE_SERVER?: string }).EMPLOKE_SERVER = "http://evil";
    }).toThrow();
  });

  it("includes ONLY positive declarations — no undefined-valued keys leak in", () => {
    // The base bag has a single semantic: "set this key to this value
    // in every spawned subprocess." The complementary "delete this
    // key from inherited env" semantic lives in
    // `SUBPROCESS_ENV_SCRUB_KEYS` instead, because only the headless
    // launch path can actually act on it (interactive shells inherit
    // parent env wholesale and `$env:` can only SET, not unset).
    //
    // Mixing the two in a single bag — previously `EMPLOKE_HOME:
    // undefined` lived here — silently broke the interactive path
    // (Windows `pwshQuote(undefined)` crashed the terminal spawner)
    // because the type lied: `NodeJS.ProcessEnv` admits undefineds.
    // Keep this surface string-only and the lie can't return.
    const env = buildSubprocessEnvBase({
      hostname: "127.0.0.1",
      port: 8787,
      sharedDir: "/h/shared",
    });
    for (const [k, v] of Object.entries(env)) {
      expect(typeof v).toBe("string");
      expect(v as string).not.toBe("");
      // and not the literal string "undefined" from a stringify mishap
      expect(v).not.toBe("undefined");
      expect(k).not.toBe("EMPLOKE_HOME");
    }
  });
});

describe("SUBPROCESS_ENV_SCRUB_KEYS", () => {
  it("declares EMPLOKE_HOME as scrub-on-headless so server state doesn't leak", () => {
    // The server reads `process.env.EMPLOKE_HOME` to find its own
    // state directory (global.db, runtime.json, logs/), so the value
    // is in the server's env by construction. Every spawned headless
    // task would otherwise inherit it and could reach into
    // service-internal state — exactly what `EMPLOKE_SHARED_DIR` was
    // designed to replace. `CopilotRuntime.launchHeadless` walks
    // this list and emits `undefined` overrides, which `mergeEnv`
    // (launch-headless.ts) interprets as "delete from inherited env".
    expect(SUBPROCESS_ENV_SCRUB_KEYS).toContain("EMPLOKE_HOME");
  });

  it("is frozen so a stray mutation can't silently widen / narrow the scrub set", () => {
    expect(Object.isFrozen(SUBPROCESS_ENV_SCRUB_KEYS)).toBe(true);
    expect(() => {
      (SUBPROCESS_ENV_SCRUB_KEYS as unknown as string[]).push("EVIL");
    }).toThrow();
  });
});
