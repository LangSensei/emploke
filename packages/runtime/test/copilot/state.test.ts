import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCopilotSessionState } from "../../src/copilot/state.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "emploke-rt-state-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function writeState(sid: string, body: string): Promise<void> {
  const dir = path.join(stateDir, sid);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "workspace.yaml"), body, "utf8");
}

const SID = "11111111-1111-1111-1111-111111111111";

describe("readCopilotSessionState", () => {
  it("returns null when the dir does not exist", async () => {
    expect(await readCopilotSessionState(stateDir, SID)).toBeNull();
  });

  it("returns null when the dir exists but workspace.yaml is missing", async () => {
    await mkdir(path.join(stateDir, SID), { recursive: true });
    expect(await readCopilotSessionState(stateDir, SID)).toBeNull();
  });

  it("returns null when workspace.yaml is malformed", async () => {
    await writeState(SID, `cwd:\n  - not\n  -valid: : :\n`);
    expect(await readCopilotSessionState(stateDir, SID)).toBeNull();
  });

  it("returns null when no usable timestamp is present", async () => {
    await writeState(SID, `name: noop\n`);
    expect(await readCopilotSessionState(stateDir, SID)).toBeNull();
  });

  it("parses a fully-populated workspace.yaml", async () => {
    await writeState(
      SID,
      [
        "name: my-session",
        "summary: a thing",
        "created_at: 2026-05-08T01:00:00Z",
        "updated_at: 2026-05-08T01:05:00Z",
      ].join("\n"),
    );
    const s = await readCopilotSessionState(stateDir, SID);
    expect(s).toEqual({
      runtimeSessionId: SID,
      lastActiveAt: "2026-05-08T01:05:00.000Z",
      preview: "a thing",
    });
  });

  it("falls back to created_at when updated_at is missing", async () => {
    await writeState(SID, ["name: only-created", "created_at: 2026-05-08T01:00:00Z"].join("\n"));
    const s = await readCopilotSessionState(stateDir, SID);
    expect(s?.lastActiveAt).toBe("2026-05-08T01:00:00.000Z");
  });

  it("preview prefers summary over name", async () => {
    await writeState(
      SID,
      ["name: a-name", "summary: a-summary", "updated_at: 2026-05-08T01:05:00Z"].join("\n"),
    );
    const s = await readCopilotSessionState(stateDir, SID);
    expect(s?.preview).toBe("a-summary");
  });

  it("preview falls back to name when summary is missing", async () => {
    await writeState(SID, ["name: just-name", "updated_at: 2026-05-08T01:05:00Z"].join("\n"));
    const s = await readCopilotSessionState(stateDir, SID);
    expect(s?.preview).toBe("just-name");
  });

  it("preview is null when neither summary nor name is present", async () => {
    await writeState(SID, "updated_at: 2026-05-08T01:05:00Z\n");
    const s = await readCopilotSessionState(stateDir, SID);
    expect(s?.preview).toBeNull();
  });
});
