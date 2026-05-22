/**
 * End-to-end integration smoke tests for the `emploke` CLI.
 *
 * One real server boot for the WHOLE file (`beforeAll` / `afterAll`),
 * shared across every case. Serial run. Asserts the small set of
 * happy paths that genuinely require an HTTP round-trip:
 *
 *   - `emploke health` returns 0 + JSON ok
 *   - `emploke runtime list` includes copilot (real `/api/runtimes`)
 *   - workspace add → list → show → current → rm round-trip
 *
 * Everything else moved to `argv-validation.test.ts` or
 * `api-contract.test.ts`. See issue #163 for the design rationale —
 * the old `commands.test.ts` paid 18 cold boots; this file pays one.
 *
 * Skipped (with reason):
 *
 *   - `emploke task dispatch` happy path: requires a registered agent
 *     in the workspace's catalog, which in turn requires either
 *     pre-seeded fixture content or running the catalog install path
 *     against a real upstream. Out of scope for a smoke test — the
 *     argv layer and the API-error contract are both covered already
 *     (see argv-validation `--brief` rejection cases and
 *     api-contract.test.ts `unknown agent` mapping).
 *   - `emploke task activity --limit 5`: needs an existing task id,
 *     which depends on the dispatch happy path above. Same reasoning.
 *
 * Neither case was asserted by the old `commands.test.ts` either —
 * they're listed in issue #163 as "stretch goals", not coverage we
 * have to preserve.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_BIN, pickPort, runBin as run } from "../_helpers/cli-bundle.js";

// Module-scoped because every test shares the boot. Set in
// `beforeAll`, read by every `it(...)`.
let home: string;
let port: number;
let sharedEnv: NodeJS.ProcessEnv;

describe.sequential("integration smoke", () => {
  beforeAll(async () => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `CLI bundle not found at ${CLI_BIN}. Run \`pnpm --filter @emploke/cli build\` first.`,
      );
    }
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-smoke-"));
    port = pickPort();
    sharedEnv = { EMPLOKE_HOME: home };
    const startRes = await run(["start", "--port", String(port), "--no-serve-static"], sharedEnv);
    if (startRes.exitCode !== 0) {
      throw new Error(`server failed to start (exit ${startRes.exitCode}): ${startRes.stderr}`);
    }
  });

  afterAll(async () => {
    try {
      await run(["stop"], sharedEnv);
    } catch {
      // Best-effort: we'd rather report the original test failure than
      // mask it with a teardown error.
    }
    // Windows EBUSY mitigation: the server's graceful shutdown closes
    // SQLite handles before exit, but Windows maps SIGTERM to
    // TerminateProcess which skips the in-process handler entirely.
    // The maxRetries/retryDelay loop in node's rm handles the brief
    // window where the OS hasn't yet reclaimed inherited file
    // descriptors. Belt-and-suspenders to the gracefulShutdown wiring
    // in `@emploke/server`.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("`emploke health` returns 0 + JSON ok", async () => {
    const res = await run(["health", "--json"], sharedEnv);
    expect(res.exitCode, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("`emploke runtime list` includes copilot (real /api/runtimes)", async () => {
    const res = await run(["runtime", "list", "--json"], sharedEnv);
    expect(res.exitCode, res.stderr).toBe(0);
    const runtimes = JSON.parse(res.stdout) as Array<{ kind: string; capabilities: object }>;
    expect(Array.isArray(runtimes)).toBe(true);
    expect(runtimes.map((r) => r.kind)).toContain("copilot");
  });

  it("workspace add → list → show → current → rm round-trip", async () => {
    // Add
    const addRes = await run(
      [
        "workspace",
        "add",
        "--name",
        "Sandbox",
        "--workspace-dir",
        path.join(home, "ws-sandbox"),
        "--json",
      ],
      sharedEnv,
    );
    expect(addRes.exitCode, addRes.stderr).toBe(0);
    const created = JSON.parse(addRes.stdout) as { id: string; name: string };
    expect(created.name).toBe("Sandbox");
    expect(typeof created.id).toBe("string");

    // List
    const listRes = await run(["workspace", "list", "--json"], sharedEnv);
    expect(listRes.exitCode, listRes.stderr).toBe(0);
    const list = JSON.parse(listRes.stdout) as Array<{ id: string }>;
    expect(list.some((w) => w.id === created.id)).toBe(true);

    // Show
    const showRes = await run(["workspace", "show", created.id, "--json"], sharedEnv);
    expect(showRes.exitCode, showRes.stderr).toBe(0);
    expect(JSON.parse(showRes.stdout).id).toBe(created.id);

    // Current — `workspace add` implicitly opens what it registers
    // (MRU). A single-add workspace must therefore be `current`.
    const curRes = await run(["workspace", "current", "--json"], sharedEnv);
    expect(curRes.exitCode, curRes.stderr).toBe(0);
    const cur = JSON.parse(curRes.stdout) as { id: string | null };
    expect(cur.id).toBe(created.id);

    // Rm
    const rmRes = await run(["workspace", "rm", created.id], sharedEnv);
    expect(rmRes.exitCode, rmRes.stderr).toBe(0);
    const list2 = JSON.parse(
      (await run(["workspace", "list", "--json"], sharedEnv)).stdout,
    ) as Array<{ id: string }>;
    expect(list2.some((w) => w.id === created.id)).toBe(false);
  });
});
