import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCopilotWorkspaceYaml } from "../../src/copilot/state.js";

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

describe("readCopilotWorkspaceYaml", () => {
  it("returns null when the dir does not exist", async () => {
    expect(await readCopilotWorkspaceYaml(stateDir, SID)).toBeNull();
  });

  it("returns null when the dir exists but workspace.yaml is missing", async () => {
    await mkdir(path.join(stateDir, SID), { recursive: true });
    expect(await readCopilotWorkspaceYaml(stateDir, SID)).toBeNull();
  });

  it("returns null when workspace.yaml is malformed", async () => {
    await writeState(SID, `cwd:\n  - not\n  -valid: : :\n`);
    expect(await readCopilotWorkspaceYaml(stateDir, SID)).toBeNull();
  });

  it("returns null when the file parses but is not an object", async () => {
    await writeState(SID, "- one\n- two\n");
    expect(await readCopilotWorkspaceYaml(stateDir, SID)).toBeNull();
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
    expect(await readCopilotWorkspaceYaml(stateDir, SID)).toEqual({
      title: "a thing",
      userTitled: false,
      lastActiveAt: "2026-05-08T01:05:00.000Z",
    });
  });

  it("falls back to created_at when updated_at is missing", async () => {
    await writeState(SID, ["name: only-created", "created_at: 2026-05-08T01:00:00Z"].join("\n"));
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m?.lastActiveAt).toBe("2026-05-08T01:00:00.000Z");
  });

  it("title prefers summary over name", async () => {
    await writeState(
      SID,
      ["name: a-name", "summary: a-summary", "updated_at: 2026-05-08T01:05:00Z"].join("\n"),
    );
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m?.title).toBe("a-summary");
  });

  it("title falls back to name when summary is missing", async () => {
    await writeState(SID, ["name: just-name", "updated_at: 2026-05-08T01:05:00Z"].join("\n"));
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m?.title).toBe("just-name");
  });

  it("title is null when neither summary nor name is present", async () => {
    await writeState(SID, "updated_at: 2026-05-08T01:05:00Z\n");
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m?.title).toBeNull();
  });

  it("returns null lastActiveAt when no usable timestamp is present", async () => {
    await writeState(SID, "name: noop\n");
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m).toEqual({ title: "noop", userTitled: false, lastActiveAt: null });
  });

  it("userTitled reflects the Copilot user_named flag", async () => {
    await writeState(
      SID,
      ["name: pinned", "user_named: true", "updated_at: 2026-05-08T01:05:00Z"].join("\n"),
    );
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m?.userTitled).toBe(true);
  });

  it("accepts string-form ISO timestamps as well as YAML-parsed Date values", async () => {
    await writeState(SID, ["name: stringy", 'updated_at: "2026-05-08T01:05:00Z"'].join("\n"));
    const m = await readCopilotWorkspaceYaml(stateDir, SID);
    expect(m?.lastActiveAt).toBe("2026-05-08T01:05:00.000Z");
  });
});
