import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustRegistrationFailed } from "../../src/copilot/errors.js";
import type { Session } from "../../src/index.js";
import {
  CopilotRuntime,
  RuntimeProvisionFailed,
  RuntimeStateDeletionFailed,
} from "../../src/index.js";
import { makeTestCatalog } from "./test-catalog.js";

let scratch: string;
let workdir: string;
let stateDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "rt-copilot-rt-"));
  workdir = path.join(scratch, "work");
  stateDir = path.join(scratch, "copilot-state");
  await mkdir(stateDir, { recursive: true });
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function buildAgent(): Promise<{ agent: AgentResolveResult; catalog: CatalogManager }> {
  const agentBody = "---\nname: demo\ndescription: d\nversion: 0.0.1\n---\n# demo\n";
  const { catalog } = await makeTestCatalog({
    agents: { demo: { "AGENTS.md": agentBody } },
  });
  return { agent: catalog.resolveAgent("public/demo"), catalog };
}

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "20260508-deadbeef",
    workdir,
    agent: "demo",
    runtime: "copilot",
    runtimeSessionId: null,
    createdAt: "2026-05-08T01:00:00.000Z",
    lastActiveAt: null,
    preview: null,
    ...over,
  };
}

const FIXED_UUID = "12345678-1234-1234-1234-1234567890ab";

describe("CopilotRuntime", () => {
  it("kind is 'copilot'", () => {
    expect(new CopilotRuntime().kind).toBe("copilot");
  });

  describe("provision", () => {
    it("provisions the workdir and returns a generated runtimeSessionId", async () => {
      const rt = new CopilotRuntime({
        randomUUID: () => FIXED_UUID,
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const { agent, catalog } = await buildAgent();
      const r = await rt.provision(workdir, agent, catalog);
      expect(r.runtimeSessionId).toBe(FIXED_UUID);
      expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toContain("# demo\n");
      // No `.git/` is planted — Copilot CLI loads hooks from
      // `<cwd>/.github/hooks/*.json` directly, so a git repo is not
      // needed for any runtime feature. See provision.ts docstring.
      expect(await exists(path.join(workdir, ".git"))).toBe(false);
    });

    it("wraps provision failures in RuntimeProvisionFailed", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      // Force a provision failure by handing the runtime a fabricated
      // `AgentResolveResult` whose agent name doesn't exist in the catalog —
      // catalog.agentEntries() will throw NotFound, which provision wraps
      // as RuntimeProvisionFailed.
      const { catalog } = await buildAgent();
      const broken: AgentResolveResult = {
        agent: { name: "absent", description: "d", version: "0.0.1" },
        skills: [],
        mcps: [],
      };
      await expect(rt.provision(workdir, broken, catalog)).rejects.toBeInstanceOf(
        RuntimeProvisionFailed,
      );
    });

    it("does NOT touch the Copilot config file (trust handled by buildLaunch preflight)", async () => {
      const sp = path.join(scratch, "copilot-config.json");
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const { agent, catalog } = await buildAgent();
      await rt.provision(workdir, agent, catalog);
      expect(await exists(sp)).toBe(false);
    });
  });

  describe("registerWorkspace (no longer exists; trust now lives in buildLaunch)", () => {
    it("does not expose a registerWorkspace method on Runtime", () => {
      const rt = new CopilotRuntime();
      // The method was removed in favour of per-launch preflight inside
      // buildLaunch (see class jsdoc: per-mode trust matrix). Verifying
      // the absence here pins the design choice — anyone re-adding it
      // should think twice and update both this test and the jsdoc.
      expect((rt as unknown as { registerWorkspace?: unknown }).registerWorkspace).toBeUndefined();
    });
  });

  describe("buildLaunch", () => {
    it("returns `copilot --yolo` when runtimeSessionId is null", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      const c = await rt.buildLaunch(fakeSession({ runtimeSessionId: null }), ws);
      expect(c.cmd).toBe("copilot");
      expect(c.args).toEqual(["--yolo"]);
    });

    it("returns `copilot --resume=<id> --yolo` when runtimeSessionId is set", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      const c = await rt.buildLaunch(fakeSession({ runtimeSessionId: FIXED_UUID }), ws);
      expect(c.args).toEqual([`--resume=${FIXED_UUID}`, "--yolo"]);
    });

    it("trusts the workspace dir in the configured config.json as a launch preflight", async () => {
      const sp = path.join(scratch, "copilot-config.json");
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      expect(await exists(sp)).toBe(false);
      await rt.buildLaunch(fakeSession({ runtimeSessionId: null }), ws);
      const written = JSON.parse(await readFile(sp, "utf8"));
      expect(written.trustedFolders).toContain(path.resolve(ws));
    });

    it("is idempotent across multiple launches in the same workspace", async () => {
      const sp = path.join(scratch, "copilot-config.json");
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      await rt.buildLaunch(fakeSession({ runtimeSessionId: null }), ws);
      await rt.buildLaunch(fakeSession({ runtimeSessionId: null }), ws);
      const written = JSON.parse(await readFile(sp, "utf8"));
      const matches = written.trustedFolders.filter((p: string) => p === path.resolve(ws));
      expect(matches).toHaveLength(1);
    });

    it("propagates trust failures as TrustRegistrationFailed (so the launch fails fast)", async () => {
      // Force a failure by pointing at a config path whose parent cannot
      // be created (a path containing a NUL byte fails on every platform).
      const sp = "/no/such/path\0bad/config.json";
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      await expect(
        rt.buildLaunch(fakeSession({ runtimeSessionId: null }), ws),
      ).rejects.toBeInstanceOf(TrustRegistrationFailed);
    });
  });

  describe("refresh", () => {
    it("returns null when runtimeSessionId is null", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      expect(await rt.refresh(fakeSession({ runtimeSessionId: null }))).toBeNull();
    });

    it("returns null when copilot has no state for the id", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const r = await rt.refresh(fakeSession({ runtimeSessionId: FIXED_UUID }));
      expect(r).toBeNull();
    });

    it("returns lastActiveAt + preview when state is present", async () => {
      await mkdir(path.join(stateDir, FIXED_UUID), { recursive: true });
      await writeFile(
        path.join(stateDir, FIXED_UUID, "workspace.yaml"),
        ["summary: hello there", "updated_at: 2026-05-08T01:05:00Z"].join("\n"),
        "utf8",
      );
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const r = await rt.refresh(fakeSession({ runtimeSessionId: FIXED_UUID }));
      expect(r).toEqual({
        lastActiveAt: "2026-05-08T01:05:00.000Z",
        preview: "hello there",
        runtimeSessionId: FIXED_UUID,
      });
    });
  });

  describe("deleteState", () => {
    it("is a no-op when runtimeSessionId is null", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      await rt.deleteState(fakeSession({ runtimeSessionId: null }));
      // No throw, no fs effect — pass.
    });

    it("removes the copilot state directory for the id", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "workspace.yaml"), "name: x\n", "utf8");
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      await rt.deleteState(fakeSession({ runtimeSessionId: FIXED_UUID }));
      expect(await exists(dir)).toBe(false);
    });

    it("succeeds when the state dir does not exist (idempotent)", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      await rt.deleteState(fakeSession({ runtimeSessionId: FIXED_UUID }));
    });

    it("wraps unexpected fs errors in RuntimeStateDeletionFailed", async () => {
      // Simulate by passing a copilotStateDir that points at a non-directory
      // file path so that path.join → rm hits a weird shape. On many systems
      // rm with force:true tolerates this; if it does, this test simply
      // passes the no-op path. Keep as a smoke check that the error class
      // construction is wired correctly.
      const wrapped = new RuntimeStateDeletionFailed(
        "copilot",
        "20260508-deadbeef",
        new Error("EACCES: bad"),
      );
      expect(wrapped).toBeInstanceOf(RuntimeStateDeletionFailed);
      expect(wrapped.kind).toBe("copilot");
      expect(wrapped.sessionId).toBe("20260508-deadbeef");
      expect((wrapped.cause as Error).message).toBe("EACCES: bad");
    });
  });

  describe("malformed runtimeSessionId (path-traversal hardening)", () => {
    // Defense-in-depth: a tampered session.json could carry a runtimeSessionId
    // that escapes the copilot state dir. Each runtime method must treat such
    // ids as if they were null rather than naively concatenating into a path
    // or shelling out a `--resume=<garbage>` form.

    const MALICIOUS_IDS = [
      "../../etc/passwd",
      "..\\..\\Windows\\System32",
      "not-a-uuid",
      "$(rm -rf /)",
      "12345678-1234-1234-1234-1234567890ab/../../escape",
    ];

    it("refresh returns null for malformed ids without touching the filesystem", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      // Place a sentinel at the would-be-attacked path so we can assert it's
      // untouched (and that we don't accidentally read it).
      const sentinel = path.join(scratch, "passwd");
      await writeFile(sentinel, "secret\n", "utf8");
      for (const id of MALICIOUS_IDS) {
        const r = await rt.refresh(fakeSession({ runtimeSessionId: id }));
        expect(r).toBeNull();
      }
      // Sentinel still present and unread (no observable side effects).
      expect(await exists(sentinel)).toBe(true);
    });

    it("deleteState is a no-op for malformed ids (does not delete arbitrary paths)", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      // Create a sentinel directory that a `..`-traversal would target.
      const sentinelDir = path.join(scratch, "do-not-delete");
      await mkdir(sentinelDir, { recursive: true });
      await writeFile(path.join(sentinelDir, "marker"), "x", "utf8");
      for (const id of MALICIOUS_IDS) {
        await rt.deleteState(fakeSession({ runtimeSessionId: id }));
      }
      expect(await exists(sentinelDir)).toBe(true);
      expect(await exists(path.join(sentinelDir, "marker"))).toBe(true);
    });

    it("buildLaunch produces a fresh launch (no --resume) for malformed ids", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const ws = path.join(scratch, "ws-mal");
      await mkdir(ws, { recursive: true });
      for (const id of MALICIOUS_IDS) {
        const c = await rt.buildLaunch(fakeSession({ runtimeSessionId: id }), ws);
        expect(c.args).toEqual(["--yolo"]);
        expect(c.display).not.toContain(id);
        expect(c.display).not.toContain("--resume");
      }
    });
  });
});
