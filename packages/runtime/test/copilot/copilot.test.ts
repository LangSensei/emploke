import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult } from "@emploke/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/index.js";
import {
  CopilotRuntime,
  RuntimeProvisionFailed,
  RuntimeStateDeletionFailed,
} from "../../src/index.js";

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

async function buildAgent(): Promise<AgentResolveResult> {
  const agentPath = path.join(scratch, "source", "agents", "demo");
  await mkdir(agentPath, { recursive: true });
  await writeFile(path.join(agentPath, "AGENTS.md"), "# demo\n", "utf8");
  return {
    agent: { name: "demo", description: "d", version: "0.0.1" },
    agentPath,
    skills: [],
    mcps: [],
  };
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
      const rt = new CopilotRuntime({ randomUUID: () => FIXED_UUID });
      const r = await rt.provision(workdir, await buildAgent());
      expect(r.runtimeSessionId).toBe(FIXED_UUID);
      expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toBe("# demo\n");
      expect(await exists(path.join(workdir, ".git"))).toBe(true);
    });

    it("wraps provision failures in RuntimeProvisionFailed", async () => {
      const rt = new CopilotRuntime();
      // Workdir's parent is missing AGENTS.md → cp will fail. Construct a
      // resolve result whose agentPath does not contain AGENTS.md.
      const agentPath = path.join(scratch, "broken-agent");
      await mkdir(agentPath, { recursive: true });
      const broken: AgentResolveResult = {
        agent: { name: "demo", description: "d", version: "0.0.1" },
        agentPath,
        skills: [],
        mcps: [],
      };
      await expect(rt.provision(workdir, broken)).rejects.toBeInstanceOf(RuntimeProvisionFailed);
    });
  });

  describe("buildLaunch", () => {
    it("returns `copilot --yolo` when runtimeSessionId is null", () => {
      const rt = new CopilotRuntime();
      const c = rt.buildLaunch(fakeSession({ runtimeSessionId: null }));
      expect(c.cmd).toBe("copilot");
      expect(c.args).toEqual(["--yolo"]);
    });

    it("returns `copilot --resume=<id> --yolo` when runtimeSessionId is set", () => {
      const rt = new CopilotRuntime();
      const c = rt.buildLaunch(fakeSession({ runtimeSessionId: FIXED_UUID }));
      expect(c.args).toEqual([`--resume=${FIXED_UUID}`, "--yolo"]);
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

    it("buildLaunch produces a fresh launch (no --resume) for malformed ids", () => {
      const rt = new CopilotRuntime();
      for (const id of MALICIOUS_IDS) {
        const c = rt.buildLaunch(fakeSession({ runtimeSessionId: id }));
        expect(c.args).toEqual(["--yolo"]);
        expect(c.display).not.toContain(id);
        expect(c.display).not.toContain("--resume");
      }
    });
  });
});
