/**
 * Unit tests for `resolveWorkspace` — the CLI's workspace-id resolver.
 *
 * The contract that earlier escaped review (and which this PR
 * tightens):
 *  - Only PROCESS-LOCAL sources count: the `--workspace` flag and
 *    the `EMPLOKE_WORKSPACE` env. Both are race-free because no
 *    other client of the emploke server can mutate them.
 *  - There is NO third-tier fallback to the server's
 *    `currentWorkspace` value. That fallback was removed because the
 *    server-side current workspace is shared mutable global state
 *    across every CLI process / dashboard tab / external client; using
 *    it to scope commands races with any other writer (see the docstring
 *    in `connect.ts`).
 *
 * The error message is part of the contract too — it must point users
 * at the new flow so AI agents copying stale recipes are auto-corrected.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspace } from "../src/connect.js";

describe("resolveWorkspace", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.EMPLOKE_WORKSPACE;
    delete process.env.EMPLOKE_WORKSPACE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.EMPLOKE_WORKSPACE;
    else process.env.EMPLOKE_WORKSPACE = savedEnv;
  });

  it("returns the --workspace flag when present", async () => {
    const id = await resolveWorkspace({ workspace: "ws-flag-1" });
    expect(id).toBe("ws-flag-1");
  });

  it("returns EMPLOKE_WORKSPACE env when no flag", async () => {
    process.env.EMPLOKE_WORKSPACE = "ws-env-1";
    const id = await resolveWorkspace({});
    expect(id).toBe("ws-env-1");
  });

  it("flag wins over env", async () => {
    process.env.EMPLOKE_WORKSPACE = "ws-env-loses";
    const id = await resolveWorkspace({ workspace: "ws-flag-wins" });
    expect(id).toBe("ws-flag-wins");
  });

  it("trims whitespace from both sources", async () => {
    expect(await resolveWorkspace({ workspace: "  ws-trim-1  " })).toBe("ws-trim-1");
    process.env.EMPLOKE_WORKSPACE = "  ws-trim-2  ";
    expect(await resolveWorkspace({})).toBe("ws-trim-2");
  });

  it("treats empty string as absent (flag)", async () => {
    process.env.EMPLOKE_WORKSPACE = "ws-from-env";
    const id = await resolveWorkspace({ workspace: "" });
    expect(id).toBe("ws-from-env");
  });

  it("treats empty string as absent (env)", async () => {
    process.env.EMPLOKE_WORKSPACE = "";
    await expect(resolveWorkspace({})).rejects.toThrow(/no workspace selected/);
  });

  it("throws a usage error when neither source is set", async () => {
    await expect(resolveWorkspace({})).rejects.toThrow(/no workspace selected/);
  });

  it("error message references both --workspace and EMPLOKE_WORKSPACE", async () => {
    // The message is contract — AI agents and humans coming from the
    // old `workspace use` flow must be auto-corrected by reading it.
    try {
      await resolveWorkspace({});
      expect.fail("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("--workspace");
      expect(msg).toContain("EMPLOKE_WORKSPACE");
      expect(msg).toContain("workspace list");
      expect(msg).toContain("`emploke workspace use` was removed");
    }
  });

  it("does NOT consult any HTTP source — no client param accepted", async () => {
    // The old signature was `resolveWorkspace(flags, client)` with
    // a third-tier `client.call("config.get")` fallback. That has
    // been removed; passing a stray second argument is now a
    // type error at compile time, and at runtime the resolver does
    // not touch the network. We assert behaviour: with no flag, no
    // env, the function throws synchronously without any I/O.
    const start = Date.now();
    await expect(resolveWorkspace({})).rejects.toThrow();
    // Tight bound — we should NOT be waiting for any network round
    // trip. 50ms is generous; a real `client.call` would be much
    // slower even on localhost.
    expect(Date.now() - start).toBeLessThan(50);
  });
});
