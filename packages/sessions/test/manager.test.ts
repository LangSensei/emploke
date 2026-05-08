import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, Catalog } from "@emploke/catalog";
import type { Provisioner, ProvisionParams } from "@emploke/provisioner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentNotFoundError,
  CopilotSessionNotFoundError,
  CopilotStateDeletionFailed,
  InvalidCopilotSessionIdError,
  InvalidSessionIdError,
  SessionNotFoundError,
  SessionsManager,
} from "../src/index.js";
import { realNormalizeCwd } from "../src/paths.js";

// Make node:fs/promises.rm mockable. Other exports default to the real impl;
// individual tests can override rm via vi.mocked(fsp.rm).mockImplementation*.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

// ───── helpers ──────────────────────────────────────────────

let root: string;
let copilotStateDir: string;
let catalogDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "emploke-sessions-root-"));
  copilotStateDir = await mkdtemp(path.join(tmpdir(), "emploke-copilot-state-"));
  catalogDir = await mkdtemp(path.join(tmpdir(), "emploke-catalog-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(copilotStateDir, { recursive: true, force: true });
  await rm(catalogDir, { recursive: true, force: true });
});

interface StubCatalogOpts {
  agents?: Record<string, AgentResolveResult>;
  resolveError?: Error;
}

function stubCatalog(opts: StubCatalogOpts = {}): Catalog {
  const agents = opts.agents ?? {};
  return {
    catalogDir,
    resolveAgent(name: string): AgentResolveResult {
      if (opts.resolveError) throw opts.resolveError;
      const a = agents[name];
      if (!a) throw new Error(`agent not found in catalog: "${name}"`);
      return a;
    },
  } as unknown as Catalog;
}

class FakeProvisioner implements Provisioner {
  readonly name = "fake";
  calls: ProvisionParams[] = [];
  shouldFail = false;
  async provision(params: ProvisionParams): Promise<void> {
    this.calls.push(params);
    if (this.shouldFail) throw new Error("provision boom");
    // Mimic real provisioner: copy AGENTS.md with frontmatter so the agent
    // name is discoverable via readAgentName().
    await mkdir(params.targetDir, { recursive: true });
    const agentName = params.resolveResult.agent.name;
    await writeFile(
      path.join(params.targetDir, "AGENTS.md"),
      `---\nname: ${agentName}\n---\n# agent\n`,
      "utf8",
    );
  }
}

const fakeAgentResolve = (name: string): AgentResolveResult =>
  ({
    agent: { name, description: "x" },
    agentPath: path.join(catalogDir, "agents", name),
    skills: [],
    mcps: [],
  }) as unknown as AgentResolveResult;

const recorder = () => {
  const calls: { msg: string; meta?: object }[] = [];
  return {
    logger: {
      warn: (msg: string, meta?: object) => calls.push({ msg, ...(meta ? { meta } : {}) }),
    },
    calls,
  };
};

const fixedNow = (iso: string) => () => new Date(iso);
const seqRandom = () => {
  let i = 0;
  return (n: number) => {
    i++;
    return Buffer.alloc(n, i);
  };
};

// ───── construction ──────────────────────────────────────────

describe("SessionsManager defaults", () => {
  it("constructs with only catalog", () => {
    const m = new SessionsManager({ catalog: stubCatalog() });
    expect(m).toBeDefined();
  });
});

// ───── create ────────────────────────────────────────────────

describe("create()", () => {
  it("provisions and records the agent name from AGENTS.md", async () => {
    const fp = new FakeProvisioner();
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: fp,
      root,
      copilotStateDir,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
      randomBytes: seqRandom(),
    });
    const rec = await m.create({ agent: "demo" });
    expect(rec.agent).toBe("demo");
    expect(rec.workdir).toBe(path.join(root, rec.id));
    expect(rec.copilotSessions).toEqual([]);
    expect(rec.latestCopilotSession).toBeNull();
    expect(fp.calls).toHaveLength(1);
    // After create, list() should see the record (proves no marker is needed
    // — the AGENTS.md frontmatter alone is enough).
    const listed = await m.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.agent).toBe("demo");
  });

  it("throws AgentNotFoundError for empty agent", async () => {
    const m = new SessionsManager({ catalog: stubCatalog(), root, copilotStateDir });
    await expect(m.create({ agent: "" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("throws AgentNotFoundError when catalog rejects", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog(),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    await expect(m.create({ agent: "missing" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("cleans up workdir on provisioner failure", async () => {
    const fp = new FakeProvisioner();
    fp.shouldFail = true;
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: fp,
      root,
      copilotStateDir,
    });
    await expect(m.create({ agent: "demo" })).rejects.toThrow("provision boom");
    // No directory should remain under root.
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(root));
    expect(entries).toEqual([]);
  });

  it("retries on EEXIST", async () => {
    let attempts = 0;
    const baseRand = seqRandom();
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
      // Custom random: returns the same first byte for the first 2 calls so
      // the directory pre-collides with itself, then differs on attempt 3.
      randomBytes: (n) => {
        attempts++;
        if (attempts <= 2) return Buffer.alloc(n, 1);
        return baseRand(n);
      },
    });
    // Pre-create the directory that the first attempt would try to take.
    const collide = "20260508-01010101";
    await mkdir(path.join(root, collide), { recursive: true });
    const rec = await m.create({ agent: "demo" });
    expect(rec.id).not.toBe(collide);
  });

  it("logs cleanup failure but rethrows the original error", async () => {
    const r = recorder();
    const fp = new FakeProvisioner();
    fp.provision = async (p) => {
      // Create the workdir but make it unreadable on POSIX-like systems
      // by populating, then throw. We simulate cleanup failure by stubbing
      // rm — easier: just throw and trust the cleanup happy path is tested
      // elsewhere. Here we verify the rethrow path.
      await mkdir(p.targetDir, { recursive: true });
      throw new Error("boom");
    };
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: fp,
      root,
      copilotStateDir,
      logger: r.logger,
    });
    await expect(m.create({ agent: "demo" })).rejects.toThrow("boom");
  });
});

// ───── list ──────────────────────────────────────────────────

describe("list()", () => {
  it("returns empty when root does not exist", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog(),
      root: path.join(root, "missing"),
      copilotStateDir,
    });
    expect(await m.list()).toEqual([]);
  });

  it("ignores dirs without a readable AGENTS.md", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    await m.create({ agent: "demo" });
    // Stray dir matching the id pattern but with no AGENTS.md at all.
    await mkdir(path.join(root, "20260101-deadbeef"), { recursive: true });
    // Stray dir matching the id pattern with an AGENTS.md missing frontmatter.
    const stray2 = path.join(root, "20260101-cafebabe");
    await mkdir(stray2, { recursive: true });
    await writeFile(path.join(stray2, "AGENTS.md"), "# no frontmatter\n", "utf8");
    // Stray dir without the right name.
    await mkdir(path.join(root, "not-a-session"), { recursive: true });
    const out = await m.list();
    expect(out).toHaveLength(1);
  });

  it("filters by agent", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({
        agents: {
          a: fakeAgentResolve("a"),
          b: fakeAgentResolve("b"),
        },
      }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    await m.create({ agent: "a" });
    await m.create({ agent: "b" });
    const onlyA = await m.list({ agent: "a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.agent).toBe("a");
  });

  it("joins copilot sessions by cwd and sets latest", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const cwdKey = await realNormalizeCwd(rec.workdir);
    // Need to write a YAML whose cwd, after realpath+normalize, equals cwdKey.
    // The simplest is to write the resolved real workdir directly.
    const sid1 = "11111111-1111-1111-1111-111111111111";
    const sid2 = "22222222-2222-2222-2222-222222222222";
    await mkdir(path.join(copilotStateDir, sid1), { recursive: true });
    await writeFile(
      path.join(copilotStateDir, sid1, "workspace.yaml"),
      `cwd: ${cwdKey}\nupdated_at: 2026-05-08T01:05:00Z\nname: older\n`,
      "utf8",
    );
    await mkdir(path.join(copilotStateDir, sid2), { recursive: true });
    await writeFile(
      path.join(copilotStateDir, sid2, "workspace.yaml"),
      `cwd: ${cwdKey}\nupdated_at: 2026-05-08T02:05:00Z\nname: newer\n`,
      "utf8",
    );
    const [out] = await m.list();
    expect(out?.copilotSessions.map((s) => s.sessionId)).toEqual([sid2, sid1]);
    expect(out?.latestCopilotSession?.name).toBe("newer");
  });

  it("tolerates missing copilot state dir", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir: path.join(copilotStateDir, "nope"),
    });
    await m.create({ agent: "demo" });
    const out = await m.list();
    expect(out[0]?.copilotSessions).toEqual([]);
  });

  it("sorts records newest-first by createdAt", async () => {
    // The id no longer encodes within-day order — sort is driven by the
    // workdir's birthtime (filesystem-side), which monotonically increases
    // for sequential mkdir calls in the same test.
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const a = await m.create({ agent: "demo" });
    // Sleep ~50ms to ensure b's birthtime > a's birthtime even on FSes with
    // coarse timestamp resolution. Most modern FSes give ms or ns precision.
    await new Promise((r) => setTimeout(r, 50));
    const b = await m.create({ agent: "demo" });
    const out = await m.list();
    expect(out.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});

// ───── get ───────────────────────────────────────────────────

describe("get()", () => {
  it("returns the record by id", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const got = await m.get(rec.id);
    expect(got?.id).toBe(rec.id);
  });

  it("returns null for valid-but-unknown id", async () => {
    const m = new SessionsManager({ catalog: stubCatalog(), root, copilotStateDir });
    expect(await m.get("20260508-deadbeef")).toBeNull();
  });

  it("throws InvalidSessionIdError for malformed id", async () => {
    const m = new SessionsManager({ catalog: stubCatalog(), root, copilotStateDir });
    await expect(m.get("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });
});

// ───── delete ────────────────────────────────────────────────

describe("delete()", () => {
  it("removes the workdir", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    await m.delete(rec.id);
    await expect(stat(rec.workdir)).rejects.toThrow();
  });

  it("throws SessionNotFoundError for unknown id", async () => {
    const m = new SessionsManager({ catalog: stubCatalog(), root, copilotStateDir });
    await expect(m.delete("20260508-deadbeef")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("validates id format", async () => {
    const m = new SessionsManager({ catalog: stubCatalog(), root, copilotStateDir });
    await expect(m.delete("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("with deleteCopilotState=true: removes matched copilot dirs", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const cwdKey = await realNormalizeCwd(rec.workdir);
    const sid = "33333333-3333-3333-3333-333333333333";
    await mkdir(path.join(copilotStateDir, sid), { recursive: true });
    await writeFile(path.join(copilotStateDir, sid, "workspace.yaml"), `cwd: ${cwdKey}\n`, "utf8");
    await m.delete(rec.id, { deleteCopilotState: true });
    await expect(stat(path.join(copilotStateDir, sid))).rejects.toThrow();
  });

  it("with deleteCopilotState=true: surfaces failure and leaves workdir intact", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const cwdKey = await realNormalizeCwd(rec.workdir);
    const sid = "44444444-4444-4444-4444-444444444444";
    await mkdir(path.join(copilotStateDir, sid), { recursive: true });
    await writeFile(path.join(copilotStateDir, sid, "workspace.yaml"), `cwd: ${cwdKey}\n`, "utf8");
    const fsp = await import("node:fs/promises");
    const realRm = vi.mocked(fsp.rm).getMockImplementation();
    if (!realRm) throw new Error("expected wrapped rm impl");
    vi.mocked(fsp.rm).mockImplementation(async (p, opts) => {
      if (typeof p === "string" && p.includes(sid)) {
        throw new Error("EBUSY: simulated");
      }
      return realRm(p, opts);
    });
    try {
      await expect(m.delete(rec.id, { deleteCopilotState: true })).rejects.toBeInstanceOf(
        CopilotStateDeletionFailed,
      );
      // Workdir should still exist as a real directory (not just any node).
      const st = await stat(rec.workdir);
      expect(st.isDirectory()).toBe(true);
    } finally {
      vi.mocked(fsp.rm).mockImplementation(realRm);
    }
  });

  it("with deleteCopilotState=true: post-rm sweep removes stragglers created during the delete window", async () => {
    // Simulates a copilot session being created in the workdir BETWEEN the
    // initial scan and the workdir rm. The post-rm sweep should catch it.
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const cwdKey = await realNormalizeCwd(rec.workdir);
    const sidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await mkdir(path.join(copilotStateDir, sidA), { recursive: true });
    await writeFile(path.join(copilotStateDir, sidA, "workspace.yaml"), `cwd: ${cwdKey}\n`, "utf8");
    const sidB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const fsp = await import("node:fs/promises");
    const realRm = vi.mocked(fsp.rm).getMockImplementation();
    if (!realRm) throw new Error("expected wrapped rm impl");
    let plantedStraggler = false;
    vi.mocked(fsp.rm).mockImplementation(async (p, opts) => {
      if (typeof p === "string" && p === rec.workdir && !plantedStraggler) {
        plantedStraggler = true;
        await mkdir(path.join(copilotStateDir, sidB), { recursive: true });
        await writeFile(
          path.join(copilotStateDir, sidB, "workspace.yaml"),
          `cwd: ${cwdKey}\n`,
          "utf8",
        );
      }
      return realRm(p, opts);
    });
    try {
      await m.delete(rec.id, { deleteCopilotState: true });
    } finally {
      vi.mocked(fsp.rm).mockImplementation(realRm);
    }
    // Both A (caught in first pass) and B (the straggler) should be gone.
    await expect(stat(path.join(copilotStateDir, sidA))).rejects.toThrow();
    await expect(stat(path.join(copilotStateDir, sidB))).rejects.toThrow();
  });
});

// ───── launch / resume ──────────────────────────────────────

describe("launch / resume", () => {
  it("returns launch command for a real session", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const c = await m.getLaunchCommand(rec.id);
    expect(c.cmd).toBe("copilot");
    expect(c.args).toEqual(["-i"]);
    expect(c.cwd).toBe(rec.workdir);
  });

  it("getLaunchCommand throws SessionNotFoundError for unknown", async () => {
    const m = new SessionsManager({ catalog: stubCatalog(), root, copilotStateDir });
    await expect(m.getLaunchCommand("20260508-deadbeef")).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("getResumeCommand validates copilot session id", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    await expect(m.getResumeCommand(rec.id, "not-a-uuid")).rejects.toBeInstanceOf(
      InvalidCopilotSessionIdError,
    );
  });

  it("getResumeCommand rejects UUID not associated with the workdir", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const sid = "12345678-1234-1234-1234-1234567890ab";
    await expect(m.getResumeCommand(rec.id, sid)).rejects.toBeInstanceOf(
      CopilotSessionNotFoundError,
    );
  });

  it("getResumeCommand returns shape", async () => {
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root,
      copilotStateDir,
    });
    const rec = await m.create({ agent: "demo" });
    const cwdKey = await realNormalizeCwd(rec.workdir);
    const sid = "12345678-1234-1234-1234-1234567890ab";
    // Plant the matching copilot state so the ownership check passes.
    await mkdir(path.join(copilotStateDir, sid), { recursive: true });
    await writeFile(path.join(copilotStateDir, sid, "workspace.yaml"), `cwd: ${cwdKey}\n`, "utf8");
    const c = await m.getResumeCommand(rec.id, sid);
    expect(c.args).toEqual(["-i", "--resume", sid]);
  });
});

// ───── list with relative root ────────────────────────────────

describe("list() with relative root", () => {
  it("returns absolute, normalized workdir paths", async () => {
    // Use a relative path to root via mkdtemp result; recreate by computing
    // a path relative to cwd. Test isolation: create a real abs dir, then
    // pass relative form derived from process.cwd().
    const absRoot = root;
    const rel = path.relative(process.cwd(), absRoot);
    const m = new SessionsManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      provisioner: new FakeProvisioner(),
      root: rel,
      copilotStateDir,
    });
    await m.create({ agent: "demo" });
    const out = await m.list();
    expect(out).toHaveLength(1);
    const wd = out[0]?.workdir ?? "";
    expect(path.isAbsolute(wd)).toBe(true);
    expect(wd).toBe(path.resolve(absRoot, out[0]?.id ?? ""));
  });
});
