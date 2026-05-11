/**
 * End-to-end integration test for the Phase 2 API-mapping commands.
 * Boots a real server in a tmpdir, then runs a handful of CLI
 * subcommands that go all the way through:
 *   commander → parseFlags → makeClient (→ runtime.json fallback) →
 *   ApiClient.call → real HTTP → server → real HTTP response → format → stdout.
 *
 * Picks a small surface (`health`, `config`, `runtime list`,
 * `workspace add`, `workspace list`, `workspace show`, `workspace use`,
 * `workspace current`, `workspace rm`) to keep runtime bounded — the
 * apiClient.test.ts unit tests cover URL building / errors / 204 paths
 * for every other route mechanically.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(HERE, "..", "dist", "bin.js");

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function pickPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

describe("API commands (integration)", () => {
  beforeAll(() => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `CLI bundle not found at ${CLI_BIN}. Run \`pnpm --filter @emploke/cli build\` first.`,
      );
    }
  });

  let home: string;
  let port: number;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-api-"));
    port = pickPort();
    env = { EMPLOKE_HOME: home };
    // Boot a server detached, like a real user would.
    const startRes = await run(["start", "--port", String(port), "--no-serve-static"], env);
    if (startRes.exitCode !== 0) {
      throw new Error(`server failed to start (exit ${startRes.exitCode}): ${startRes.stderr}`);
    }
  });
  afterEach(async () => {
    try {
      await run(["stop"], env);
    } catch {}
    await rm(home, { recursive: true, force: true });
  });

  it("`emploke health` returns 0 + JSON ok", async () => {
    const res = await run(["health", "--json"], env);
    expect(res.exitCode, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("`emploke config` surfaces the resolved EMPLOKE_HOME", async () => {
    const res = await run(["config", "--json"], env);
    expect(res.exitCode, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout);
    // The server normalises the path; just assert the tmpdir basename
    // appears somewhere in the resolved home.
    expect(body.emplokeHome).toContain(path.basename(home));
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(port);
  });

  it("`emploke runtime list` includes copilot", async () => {
    const res = await run(["runtime", "list", "--json"], env);
    expect(res.exitCode, res.stderr).toBe(0);
    const runtimes = JSON.parse(res.stdout) as Array<{ kind: string; capabilities: object }>;
    expect(Array.isArray(runtimes)).toBe(true);
    // Wire shape was bumped from `string[]` to `{kind, capabilities}[]` in
    // server PR #55. Assert on the kind field.
    expect(runtimes.map((r) => r.kind)).toContain("copilot");
  });

  it("workspace add → list → show → use → current → rm round-trip", async () => {
    // Add
    const addRes = await run(
      [
        "workspace",
        "add",
        "--name",
        "Sandbox",
        "--workdir",
        path.join(home, "ws-sandbox"),
        "--json",
      ],
      env,
    );
    expect(addRes.exitCode, addRes.stderr).toBe(0);
    const created = JSON.parse(addRes.stdout) as { id: string; name: string };
    expect(created.name).toBe("Sandbox");
    expect(typeof created.id).toBe("string");

    // List
    const listRes = await run(["workspace", "list", "--json"], env);
    expect(listRes.exitCode, listRes.stderr).toBe(0);
    const list = JSON.parse(listRes.stdout) as Array<{ id: string }>;
    expect(list.some((w) => w.id === created.id)).toBe(true);

    // Show
    const showRes = await run(["workspace", "show", created.id, "--json"], env);
    expect(showRes.exitCode, showRes.stderr).toBe(0);
    expect(JSON.parse(showRes.stdout).id).toBe(created.id);

    // Use → Current
    const useRes = await run(["workspace", "use", created.id], env);
    expect(useRes.exitCode, useRes.stderr).toBe(0);
    const curRes = await run(["workspace", "current", "--json"], env);
    expect(curRes.exitCode, curRes.stderr).toBe(0);
    expect(JSON.parse(curRes.stdout).id).toBe(created.id);

    // Rm
    const rmRes = await run(["workspace", "rm", created.id], env);
    expect(rmRes.exitCode, rmRes.stderr).toBe(0);
    const list2 = JSON.parse((await run(["workspace", "list", "--json"], env)).stdout) as Array<{
      id: string;
    }>;
    expect(list2.some((w) => w.id === created.id)).toBe(false);
  });

  it("`workspace add` without --name fails with usage exit 2", async () => {
    const res = await run(["workspace", "add", "--workdir", "/tmp/x"], env);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toLowerCase()).toContain("required");
  });

  it("workspace-scoped command fails clearly when no workspace is set", async () => {
    // Use a fresh tmpdir for runtime.json but the server has zero workspaces;
    // sessions list resolves currentWorkspace → null and surfaces a usage error.
    const res = await run(["session", "list"], env);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("workspace");
  });

  it("`emploke task dispatch` errors clearly when agent is missing", async () => {
    const res = await run(["task", "dispatch", "--instructions", "noop"], env);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toLowerCase()).toContain("agent");
  });
});
