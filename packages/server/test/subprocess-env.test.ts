import { describe, expect, it } from "vitest";
import { buildSubprocessEnvBase } from "../src/subprocess-env.js";

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
    // TaskManager (via WorkspaceContextCache). Concurrency-safety
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

  it("includes EMPLOKE_HOME as `undefined` so mergeEnv strips inherited value from spawn", () => {
    // The server reads `process.env.EMPLOKE_HOME` to find its own
    // state directory, so the value is in the parent env by
    // construction. If we leave it inherited, every spawned task
    // would see the service-internal path and could reach into
    // `global.db`, `runtime.json`, `logs/`, etc. — exactly what
    // `EMPLOKE_SHARED_DIR` was designed to replace.
    //
    // The fix relies on `mergeEnv` (in the runtime layer) treating an
    // `undefined` value as "delete this key from base before spawn".
    // We therefore include the key with value `undefined` rather than
    // omit it: omitting would leave the parent's value in place.
    const env = buildSubprocessEnvBase({
      hostname: "127.0.0.1",
      port: 8787,
      sharedDir: "/h/shared",
    });
    expect("EMPLOKE_HOME" in env).toBe(true);
    expect(env.EMPLOKE_HOME).toBeUndefined();
  });
});
