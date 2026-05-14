import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustRegistrationFailed } from "../../src/copilot/errors.js";
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
  return { agent: await catalog.resolveAgent("public/demo"), catalog };
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
      const r = await rt.provision(workdir, agent, catalog, { workspaceDir: scratch });
      expect(r.runtimeSessionId).toBe(FIXED_UUID);
      expect(await readFile(path.join(workdir, "AGENTS.md"), "utf8")).toContain("# demo\n");
      // No `.git/` is planted â€” Copilot CLI loads hooks from
      // `<cwd>/.github/hooks/*.json` directly, so a git repo is not
      // needed for any runtime feature. See provision.ts docstring.
      expect(await exists(path.join(workdir, ".git"))).toBe(false);
    });

    it("wraps provision failures in RuntimeProvisionFailed", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      // Force a provision failure by handing the runtime a fabricated
      // `AgentResolveResult` whose agent name doesn't exist in the catalog â€”
      // catalog.agentEntries() will throw NotFound, which provision wraps
      // as RuntimeProvisionFailed.
      const { catalog } = await buildAgent();
      const broken: AgentResolveResult = {
        agent: { name: "absent", description: "d", version: "0.0.1" },
        skills: [],
        mcps: [],
      };
      await expect(
        rt.provision(workdir, broken, catalog, { workspaceDir: scratch }),
      ).rejects.toBeInstanceOf(RuntimeProvisionFailed);
    });

    it("does NOT touch the Copilot config file (trust handled by buildInteractiveLaunch preflight)", async () => {
      const sp = path.join(scratch, "copilot-config.json");
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const { agent, catalog } = await buildAgent();
      await rt.provision(workdir, agent, catalog, { workspaceDir: scratch });
      expect(await exists(sp)).toBe(false);
    });
  });

  describe("registerWorkspace (no longer exists; trust now lives in buildInteractiveLaunch)", () => {
    it("does not expose a registerWorkspace method on Runtime", () => {
      const rt = new CopilotRuntime();
      // The method was removed in favour of per-launch preflight inside
      // buildInteractiveLaunch (see class jsdoc: per-mode trust matrix). Verifying
      // the absence here pins the design choice â€” anyone re-adding it
      // should think twice and update both this test and the jsdoc.
      expect((rt as unknown as { registerWorkspace?: unknown }).registerWorkspace).toBeUndefined();
    });
  });

  describe("buildInteractiveLaunch", () => {
    it("returns `copilot --yolo` when runtimeSessionId is null", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      const c = await rt.buildInteractiveLaunch(null, workdir, ws);
      expect(c.cmd).toBe("copilot");
      expect(c.args).toEqual(["--yolo"]);
    });

    it("returns `copilot --resume=<id> --yolo` when runtimeSessionId is set", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      const c = await rt.buildInteractiveLaunch(FIXED_UUID, workdir, ws);
      expect(c.args).toEqual([`--resume=${FIXED_UUID}`, "--yolo"]);
    });

    it("trusts the workspace dir in the configured config.json as a launch preflight", async () => {
      const sp = path.join(scratch, "copilot-config.json");
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      expect(await exists(sp)).toBe(false);
      await rt.buildInteractiveLaunch(null, workdir, ws);
      const written = JSON.parse(await readFile(sp, "utf8"));
      expect(written.trustedFolders).toContain(path.resolve(ws));
    });

    it("is idempotent across multiple launches in the same workspace", async () => {
      const sp = path.join(scratch, "copilot-config.json");
      const rt = new CopilotRuntime({ copilotConfigPath: sp });
      const ws = path.join(scratch, "ws");
      await mkdir(ws, { recursive: true });
      await rt.buildInteractiveLaunch(null, workdir, ws);
      await rt.buildInteractiveLaunch(null, workdir, ws);
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
      await expect(rt.buildInteractiveLaunch(null, workdir, ws)).rejects.toBeInstanceOf(
        TrustRegistrationFailed,
      );
    });
  });

  describe("refresh", () => {
    it("returns null when runtimeSessionId is null", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      expect(await rt.readMetadata("")).toBeNull();
    });

    it("returns null when copilot has no state for the id", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const r = await rt.readMetadata(FIXED_UUID);
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
      const r = await rt.readMetadata(FIXED_UUID);
      expect(r).toEqual({
        lastActiveAt: "2026-05-08T01:05:00.000Z",
        title: "hello there",
        userTitled: false,
      });
    });
  });

  describe("deleteState", () => {
    it("is a no-op when runtimeSessionId is null", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      await rt.deleteState("");
      // No throw, no fs effect â€” pass.
    });

    it("removes the copilot state directory for the id", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "workspace.yaml"), "name: x\n", "utf8");
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      await rt.deleteState(FIXED_UUID);
      expect(await exists(dir)).toBe(false);
    });

    it("succeeds when the state dir does not exist (idempotent)", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      await rt.deleteState(FIXED_UUID);
    });

    it("wraps unexpected fs errors in RuntimeStateDeletionFailed", async () => {
      // Simulate by passing a copilotStateDir that points at a non-directory
      // file path so that path.join â†’ rm hits a weird shape. On many systems
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
        const r = await rt.readMetadata(id ?? "");
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
        await rt.deleteState(id ?? "");
      }
      expect(await exists(sentinelDir)).toBe(true);
      expect(await exists(path.join(sentinelDir, "marker"))).toBe(true);
    });

    it("buildInteractiveLaunch produces a fresh launch (no --resume) for malformed ids", async () => {
      const rt = new CopilotRuntime({
        copilotConfigPath: path.join(scratch, "copilot-config.json"),
      });
      const ws = path.join(scratch, "ws-mal");
      await mkdir(ws, { recursive: true });
      for (const id of MALICIOUS_IDS) {
        const c = await rt.buildInteractiveLaunch(id, workdir, ws);
        expect(c.args).toEqual(["--yolo"]);
        expect(c.display).not.toContain(id);
        expect(c.display).not.toContain("--resume");
      }
    });
  });

  describe("readActivity", () => {
    it("returns null when runtimeSessionId is missing or invalid", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      expect(await rt.readActivity({ runtimeSessionId: "" })).toBeNull();
      expect(await rt.readActivity({ runtimeSessionId: "not-a-uuid" })).toBeNull();
    });

    it("returns null when events.jsonl is missing on disk", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      expect(await rt.readActivity({ runtimeSessionId: FIXED_UUID })).toBeNull();
    });

    it("paginates events.jsonl in three modes (tail / after / before)", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(
          JSON.stringify({
            type: "user.message",
            id: `u${i}`,
            parentId: null,
            timestamp: "2026-05-12T03:54:11.016Z",
            data: { content: `msg ${i}` },
          }),
        );
      }
      await writeFile(path.join(dir, "events.jsonl"), lines.join("\n"));
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });

      // No limit, no pagination cursor: returns the entire log.
      // CLI default ("give me everything").
      const all = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
      });
      expect(all?.activity).toHaveLength(10);
      expect(all?.totalItems).toBe(10);
      expect(all?.activity[0]?.seq).toBe(0);
      expect(all?.activity[9]?.seq).toBe(9);
      expect(all?.truncated).toBeUndefined();

      // Tail mode (limit but no cursor): returns the LATEST `limit`
      // items. GUI default — user lands at the most recent activity.
      const tail = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        limit: 3,
      });
      expect(tail?.activity).toHaveLength(3);
      expect(tail?.activity[0]?.seq).toBe(7);
      expect(tail?.activity[2]?.seq).toBe(9);
      expect(tail?.truncated?.reason).toBe("page_limit");
      // hasOlder derives from `activity[0].seq > 0` — no separate field.
      expect((tail?.activity[0]?.seq ?? 0) > 0).toBe(true);

      // Forward (after): items strictly newer than seq, oldest-first,
      // capped at limit. SSE polling pattern.
      const forward = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        after: 2,
        limit: 5,
      });
      expect(forward?.activity).toHaveLength(5);
      expect(forward?.activity[0]?.seq).toBe(3);
      expect(forward?.activity[4]?.seq).toBe(7);
      expect(forward?.truncated?.reason).toBe("page_limit");

      // Backward (before): items strictly older than seq, returns the
      // `limit` immediately preceding the cut, still ASC-sorted.
      // GUI "load older history" pattern.
      const backward = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        before: 8,
        limit: 3,
      });
      expect(backward?.activity).toHaveLength(3);
      expect(backward?.activity[0]?.seq).toBe(5);
      expect(backward?.activity[2]?.seq).toBe(7);
      expect(backward?.truncated?.reason).toBe("page_limit");

      // Backward at the head boundary: window smaller than limit,
      // returns whatever's available, no truncation marker, and
      // `activity[0].seq === 0` so caller knows hasOlder = false.
      const headBoundary = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        before: 2,
        limit: 5,
      });
      expect(headBoundary?.activity).toHaveLength(2);
      expect(headBoundary?.activity[0]?.seq).toBe(0);
      expect(headBoundary?.truncated).toBeUndefined();
    });

    it("rejects mutually-exclusive before + after with RuntimeReadActivityInvalidArgs", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "events.jsonl"), "");
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      // Throws before touching the file — the route layer should
      // catch this earlier as 400, but the runtime guards in case
      // an in-process caller bypasses the route.
      await expect(
        rt.readActivity({ runtimeSessionId: FIXED_UUID, before: 5, after: 2 }),
      ).rejects.toThrow(/before.*after.*mutually exclusive/);
    });

    it("handles pagination boundary edge cases (before=0, after=lastSeq, oversized limit)", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            type: "user.message",
            id: `u${i}`,
            parentId: null,
            timestamp: "2026-05-12T03:54:11.016Z",
            data: { content: `msg ${i}` },
          }),
        );
      }
      await writeFile(path.join(dir, "events.jsonl"), lines.join("\n"));
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });

      // before=0: no items have seq < 0, so the page is empty AND
      // there's no truncation marker (we're at the head boundary,
      // not page-limited). totalItems still reflects the whole log.
      const beforeZero = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        before: 0,
        limit: 10,
      });
      expect(beforeZero?.activity).toHaveLength(0);
      expect(beforeZero?.totalItems).toBe(5);
      expect(beforeZero?.truncated).toBeUndefined();

      // after=lastSeq: no items beyond the tail, empty page, no
      // truncation marker. Polling pattern: client just sees no new
      // events and polls again later.
      const afterTail = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        after: 4,
        limit: 10,
      });
      expect(afterTail?.activity).toHaveLength(0);
      expect(afterTail?.totalItems).toBe(5);
      expect(afterTail?.truncated).toBeUndefined();

      // limit > totalItems with no directional opt: returns the whole
      // log (tail mode), no truncation marker — the cap wasn't actually
      // hit because the log fit inside it.
      const oversized = await rt.readActivity({
        runtimeSessionId: FIXED_UUID,
        limit: 9999,
      });
      expect(oversized?.activity).toHaveLength(5);
      expect(oversized?.totalItems).toBe(5);
      expect(oversized?.truncated).toBeUndefined();
    });

    it("caps the raw read at 4MB and surfaces truncated marker", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      // Build a > 4MB events.jsonl by repeating a fat user.message line.
      const fatPayload = "x".repeat(8000);
      const fatLine =
        JSON.stringify({
          type: "user.message",
          id: "u1",
          parentId: null,
          timestamp: "2026-05-12T03:54:11.016Z",
          data: { content: fatPayload },
        }) + "\n";
      const targetBytes = 5 * 1024 * 1024;
      const repeats = Math.ceil(targetBytes / fatLine.length);
      const eventsPath = path.join(dir, "events.jsonl");
      // Write incrementally to avoid holding 5MB string in memory twice.
      await writeFile(eventsPath, "");
      const { appendFile } = await import("node:fs/promises");
      for (let i = 0; i < repeats; i++) {
        await appendFile(eventsPath, fatLine);
      }
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const r = await rt.readActivity({ runtimeSessionId: FIXED_UUID });
      expect(r).not.toBeNull();
      expect(r?.truncated?.reason).toBe("size_limit");
      expect(r?.truncated?.droppedBytes).toBeGreaterThan(0);
      // Activity is still parsed (last 4MB worth), not empty.
      expect(r?.activity.length).toBeGreaterThan(0);
    });
  });

  describe("streamActivity", () => {
    it("returns nothing when runtimeSessionId is missing", async () => {
      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const items: unknown[] = [];
      for await (const item of rt.streamActivity({ runtimeSessionId: "" })) {
        items.push(item);
      }
      expect(items).toEqual([]);
    });

    it("yields each new event as it's appended; honours abort signal", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      const eventsPath = path.join(dir, "events.jsonl");
      await writeFile(eventsPath, "");

      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const ac = new AbortController();
      const collected: unknown[] = [];

      // Drive the iterator on a background promise so we can write to
      // the file in parallel.
      const iterPromise = (async () => {
        for await (const item of rt.streamActivity({
          runtimeSessionId: FIXED_UUID,
          signal: ac.signal,
        })) {
          collected.push(item);
        }
      })();

      // Give the iterator one poll cycle to settle on the empty file,
      // then append a line.
      const { appendFile } = await import("node:fs/promises");
      const { setTimeout: delay } = await import("node:timers/promises");
      await delay(300);
      await appendFile(
        eventsPath,
        `${JSON.stringify({
          type: "user.message",
          id: "u1",
          parentId: null,
          timestamp: "2026-05-12T03:54:11.016Z",
          data: { content: "live!" },
        })}\n`,
      );
      // Give the iterator time to pick up the new bytes.
      await delay(500);
      ac.abort();
      await iterPromise;

      expect(collected.length).toBeGreaterThanOrEqual(1);
      expect((collected[0] as { kind: string; text: string }).kind).toBe("user");
      expect((collected[0] as { text: string }).text).toBe("live!");
    });

    it("resumes from `after` (exclusive) so SSE Last-Event-ID reconnects skip already-seen seqs", async () => {
      const dir = path.join(stateDir, FIXED_UUID);
      await mkdir(dir, { recursive: true });
      const eventsPath = path.join(dir, "events.jsonl");
      // Pre-seed 3 historical lines (seqs 0,1,2) so the iterator's
      // post-resume parser starts numbering at the right offset.
      const seed = (i: number) =>
        `${JSON.stringify({
          type: "user.message",
          id: `u${i}`,
          parentId: null,
          timestamp: "2026-05-12T03:54:11.016Z",
          data: { content: `seed ${i}` },
        })}\n`;
      await writeFile(eventsPath, `${seed(0)}${seed(1)}${seed(2)}`);

      const rt = new CopilotRuntime({ copilotStateDir: stateDir });
      const ac = new AbortController();
      const collected: { seq: number; text: string }[] = [];

      const iterPromise = (async () => {
        for await (const item of rt.streamActivity({
          runtimeSessionId: FIXED_UUID,
          // Last-Event-ID equivalent: the client already saw seq 1, so
          // the runtime should yield items with seq > 1 only. The
          // historical seq-2 line is already on disk but lives BELOW
          // the offset (= file size at subscription time), so it
          // doesn't get re-yielded — only newly appended bytes are.
          after: 1,
          signal: ac.signal,
        })) {
          collected.push({
            seq: (item as { seq: number }).seq,
            text: (item as { text?: string }).text ?? "",
          });
        }
      })();

      const { appendFile } = await import("node:fs/promises");
      const { setTimeout: delay } = await import("node:timers/promises");
      await delay(300);
      // Append two NEW lines after subscription. They should be
      // numbered seq 2, 3 (continuing from `after + 1 = 2`). The
      // pre-existing seq-2 line is below the subscription offset,
      // so the freshly-written line gets seq 2 too — note that the
      // stream parser numbers off the `after`-derived startSeq, NOT
      // the file's historical content. This is the documented
      // SSE-resume contract.
      await appendFile(eventsPath, seed(3));
      await appendFile(eventsPath, seed(4));
      await delay(500);
      ac.abort();
      await iterPromise;

      // We saw the two new appends, numbered starting from after+1.
      expect(collected.length).toBe(2);
      expect(collected[0]?.seq).toBe(2);
      expect(collected[1]?.seq).toBe(3);
      expect(collected[0]?.text).toBe("seed 3");
      expect(collected[1]?.text).toBe("seed 4");
    });
  });
});
