import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexByCwd, scanCopilotSessions } from "../src/copilot-state.js";
import { normalizeCwd } from "../src/paths.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "emploke-copilot-state-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const recorder = () => {
  const calls: { msg: string; meta?: object }[] = [];
  return {
    logger: {
      warn: (msg: string, meta?: object) => calls.push({ msg, ...(meta ? { meta } : {}) }),
    },
    calls,
  };
};

async function writeSession(sid: string, yamlBody: string): Promise<void> {
  const dir = path.join(stateDir, sid);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "workspace.yaml"), yamlBody, "utf8");
}

describe("scanCopilotSessions", () => {
  it("returns empty when state dir does not exist", async () => {
    const fake = path.join(stateDir, "does-not-exist");
    const r = recorder();
    expect(await scanCopilotSessions(fake, r.logger)).toEqual([]);
  });

  it("yields valid entries", async () => {
    await writeSession(
      "11111111-1111-1111-1111-111111111111",
      `cwd: /repo/foo\nname: my-session\nsummary: a thing\ncreated_at: 2026-05-08T01:00:00Z\nupdated_at: 2026-05-08T01:05:00Z\n`,
    );
    const r = recorder();
    const out = await scanCopilotSessions(stateDir, r.logger);
    expect(out).toHaveLength(1);
    const e = out[0];
    if (!e) throw new Error("expected one entry");
    expect(e.info.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(e.info.name).toBe("my-session");
    expect(e.info.summary).toBe("a thing");
    expect(e.info.createdAt?.toISOString()).toBe("2026-05-08T01:00:00.000Z");
    expect(e.info.updatedAt?.toISOString()).toBe("2026-05-08T01:05:00.000Z");
    expect(e.cwdKey).toBe(normalizeCwd("/repo/foo"));
  });

  it("treats missing optional fields as undefined", async () => {
    await writeSession("22222222-2222-2222-2222-222222222222", `cwd: /repo/bar\n`);
    const r = recorder();
    const [e] = await scanCopilotSessions(stateDir, r.logger);
    if (!e) throw new Error("expected one entry");
    expect(e.info.name).toBeUndefined();
    expect(e.info.summary).toBeUndefined();
    expect(e.info.updatedAt).toBeUndefined();
  });

  it("skips entries with no cwd or non-string cwd", async () => {
    await writeSession("33333333-3333-3333-3333-333333333333", `name: nope\n`);
    await writeSession("44444444-4444-4444-4444-444444444444", `cwd: 12345\n`);
    const r = recorder();
    expect(await scanCopilotSessions(stateDir, r.logger)).toEqual([]);
  });

  it("skips entries with relative cwd (only absolute paths are accepted)", async () => {
    // A relative cwd like "." would otherwise resolve against process.cwd()
    // and could falsely match an unrelated workdir.
    await writeSession("66666666-6666-6666-6666-666666666666", `cwd: .\n`);
    await writeSession("77777777-7777-7777-7777-777777777777", `cwd: ./relative/path\n`);
    const r = recorder();
    expect(await scanCopilotSessions(stateDir, r.logger)).toEqual([]);
  });

  it("skips and logs malformed YAML", async () => {
    await writeSession("55555555-5555-5555-5555-555555555555", `cwd:\n  - not\n  -valid: : :\n`);
    const r = recorder();
    const out = await scanCopilotSessions(stateDir, r.logger);
    expect(out).toEqual([]);
    expect(r.calls.length).toBeGreaterThan(0);
  });

  it("ignores files at top level (only dirs are sessions)", async () => {
    await writeFile(path.join(stateDir, "stray.txt"), "junk", "utf8");
    const r = recorder();
    expect(await scanCopilotSessions(stateDir, r.logger)).toEqual([]);
  });
});

describe("indexByCwd", () => {
  it("groups and sorts by updatedAt desc", () => {
    const map = indexByCwd([
      {
        cwdKey: "/a",
        info: { sessionId: "s1", updatedAt: new Date("2026-05-08T01:00:00Z") },
      },
      {
        cwdKey: "/a",
        info: { sessionId: "s2", updatedAt: new Date("2026-05-08T02:00:00Z") },
      },
      { cwdKey: "/b", info: { sessionId: "s3" } },
    ]);
    expect(map.get("/a")?.map((s) => s.sessionId)).toEqual(["s2", "s1"]);
    expect(map.get("/b")?.map((s) => s.sessionId)).toEqual(["s3"]);
  });

  it("places entries with no updatedAt at the end", () => {
    const map = indexByCwd([
      { cwdKey: "/a", info: { sessionId: "s1" } },
      {
        cwdKey: "/a",
        info: { sessionId: "s2", updatedAt: new Date("2026-05-08T02:00:00Z") },
      },
    ]);
    expect(map.get("/a")?.map((s) => s.sessionId)).toEqual(["s2", "s1"]);
  });
});
