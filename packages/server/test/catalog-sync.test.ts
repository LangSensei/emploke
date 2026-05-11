import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogManager, ResolvedSkill, Skill } from "@emploke/catalog";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { FsWorkspaceRepository, type Workspace, WorkspaceManager } from "@emploke/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogRoutes } from "../src/routes/catalog/index.js";
import { WorkspaceContextCache } from "../src/workspace-context.js";

/**
 * End-to-end tests for the sync / acknowledge / enable / disable
 * routes added in PR #57. Drives the real CatalogManager + SQLite
 * stack via a real Hono mount so the wire shapes (`ResolveManifest`,
 * status enums, etc.) are exercised top-to-bottom.
 */

let scratch: string;
let workspaces: WorkspaceManager;
let cache: WorkspaceContextCache;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-server-sync-"));
  workspaces = new WorkspaceManager(
    new FsWorkspaceRepository({ indexFile: path.join(scratch, ".emploke", "workspaces.json") }),
  );
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(scratch, "copilot-config.json") }),
  );
  cache = new WorkspaceContextCache({ runtimeRegistry, workspaces });
});

afterEach(async () => {
  cache.closeAll();
  await rm(scratch, { recursive: true, force: true });
});

async function ensureWorkspace(name: string): Promise<Workspace> {
  return workspaces.init({ name, workdir: path.join(scratch, name) });
}

function mountApp() {
  const app = new Hono<{ Variables: { catalog: CatalogManager } }>();
  app.use("/api/workspaces/:id/catalog/*", async (c, next) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing workspace id" }, 400);
    const ctx = await cache.get(id);
    if (!ctx) return c.json({ error: "not registered", code: "WorkspaceNotRegisteredError" }, 404);
    c.set("catalog", ctx.catalog);
    await next();
  });
  app.route(
    "/api/workspaces/:id/catalog",
    catalogRoutes((c) => c.get("catalog")),
  );
  return app;
}

/**
 * Write a SKILL.md fixture under `<scratch>/fixtures/<name>/SKILL.md`.
 * Returns the file:// origin URL the install endpoint expects, with
 * forward-slash separators so the same string can be embedded
 * verbatim into another fixture's `dependencies` ref (Windows
 * `path.join` returns backslashes, which the file-URI parser rejects
 * when it sees them downstream).
 */
async function writeSkillFixture(name: string, body: string): Promise<string> {
  const dir = path.join(scratch, "fixtures", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  return `file:${dir.replaceAll("\\", "/")}`;
}

const SKILL_MD = (name: string, version = "1.0.0", extra = "") => `---
name: ${name}
description: x
version: ${version}
${extra}
---
# Body
`;

describe("server: catalog sync + acknowledge + enable/disable routes", () => {
  it("POST /catalog/skills/:fqn/sync/resolve returns up-to-date manifest", async () => {
    const ws = await ensureWorkspace("alpha");
    const origin = await writeSkillFixture("tool", SKILL_MD("tool"));
    const app = mountApp();

    // Install first so sync has a local row to compare against.
    const install = await app.request(`/api/workspaces/${ws.id}/catalog/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "file", location: origin.slice("file:".length) }),
    });
    expect(install.status).toBe(201);

    const res = await app.request(
      `/api/workspaces/${ws.id}/catalog/skills/${encodeURIComponent("public/tool")}/sync/resolve`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      isSync: boolean;
      upToDate: boolean;
      orphans: unknown[];
    };
    expect(manifest.isSync).toBe(true);
    expect(manifest.upToDate).toBe(true);
    expect(manifest.orphans).toEqual([]);
  });

  it("POST /catalog/skills/:fqn/acknowledge-prereqs flips prereqsAck", async () => {
    const ws = await ensureWorkspace("alpha");
    const toolOrigin = await writeSkillFixture(
      "tool",
      SKILL_MD("tool", "1.0.0", "prereqs: 'do something'"),
    );
    // Install a PARENT skill that depends on the tool skill so the
    // tool has a reverse-dep — without this it would be orphaned
    // (zero refs in the catalog) and stay blocked even after ack.
    // Orphan is now derived live from the dep graph rather than
    // stored on the row, so any standalone-installed entry is
    // by definition orphan; an ack alone can't make it ready.
    const parentOrigin = await writeSkillFixture(
      "parent",
      SKILL_MD("parent", "1.0.0", `dependencies:\n  skills:\n    - "${toolOrigin}"`),
    );
    const app = mountApp();
    const installRes = await app.request(`/api/workspaces/${ws.id}/catalog/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "file", location: parentOrigin.slice("file:".length) }),
    });
    expect(installRes.status).toBe(201);

    // Before ack: prereqsAck=false, status=blocked (needsPrereqsAck).
    const before = await app.request(
      `/api/workspaces/${ws.id}/catalog/skills/${encodeURIComponent("public/tool")}`,
    );
    const beforeBody = (await before.json()) as { skill: Skill; status: string };
    expect(beforeBody.skill.prereqsAck).toBe(false);
    expect(beforeBody.status).toBe("blocked");
    expect(beforeBody.skill.orphaned).toBe(false);

    const ack = await app.request(
      `/api/workspaces/${ws.id}/catalog/skills/${encodeURIComponent("public/tool")}/acknowledge-prereqs`,
      { method: "POST" },
    );
    expect(ack.status).toBe(200);

    const after = await app.request(
      `/api/workspaces/${ws.id}/catalog/skills/${encodeURIComponent("public/tool")}`,
    );
    const afterBody = (await after.json()) as { skill: Skill; status: string };
    expect(afterBody.skill.prereqsAck).toBe(true);
    expect(afterBody.status).toBe("ready");
  });

  it("POST /catalog/agents/:fqn/disable then /enable round-trips disabledByUser", async () => {
    const ws = await ensureWorkspace("alpha");
    // Need an agent fixture; reuse the SKILL_MD shape but as AGENTS.md.
    const dir = path.join(scratch, "fixtures", "agent");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "AGENTS.md"),
      `---\nname: writer\ndescription: x\nversion: 1.0.0\n---\n# Body\n`,
      "utf8",
    );
    const app = mountApp();
    await app.request(`/api/workspaces/${ws.id}/catalog/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "file", location: dir }),
    });

    const disableRes = await app.request(
      `/api/workspaces/${ws.id}/catalog/agents/${encodeURIComponent("public/writer")}/disable`,
      { method: "POST" },
    );
    expect(disableRes.status).toBe(200);
    let entry = (await (
      await app.request(
        `/api/workspaces/${ws.id}/catalog/agents/${encodeURIComponent("public/writer")}`,
      )
    ).json()) as { agent: { disabledByUser: boolean }; status: string };
    expect(entry.agent.disabledByUser).toBe(true);
    expect(entry.status).toBe("blocked");

    const enableRes = await app.request(
      `/api/workspaces/${ws.id}/catalog/agents/${encodeURIComponent("public/writer")}/enable`,
      { method: "POST" },
    );
    expect(enableRes.status).toBe(200);
    entry = (await (
      await app.request(
        `/api/workspaces/${ws.id}/catalog/agents/${encodeURIComponent("public/writer")}`,
      )
    ).json()) as { agent: { disabledByUser: boolean }; status: string };
    expect(entry.agent.disabledByUser).toBe(false);
    expect(entry.status).toBe("ready");
  });

  it("overview counts include orphaned entries after a dropped-dep sync", async () => {
    const ws = await ensureWorkspace("alpha");
    // Install via an agent that depends on a skill that depends on
    // an MCP. Agents are roots that are never orphan, so the only
    // entries that can drop to orphan after the sync are the MCP
    // (which loses its only ref when the dep is removed) — the skill
    // itself stays referenced by the agent.
    //
    // Without an agent root, every standalone-installed skill /
    // mcp would also count as orphan in the new derived-orphan model
    // (zero reverse-deps), inflating the count past what this test
    // is exercising.
    const mcpDir = path.join(scratch, "fixtures", "mcp-x");
    await mkdir(mcpDir, { recursive: true });
    const mcpUri = `file:${mcpDir.replaceAll("\\", "/")}`;
    await writeFile(
      path.join(mcpDir, "mcp.json"),
      JSON.stringify({ _meta: { name: "vendor/x", origin: mcpUri } }),
      "utf8",
    );
    const toolOrigin = await writeSkillFixture(
      "tool",
      SKILL_MD("tool", "1.0.0", `dependencies:\n  mcps:\n    - "${mcpUri}"`),
    );
    const agentDir = path.join(scratch, "fixtures", "uses-tool-2");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "AGENTS.md"),
      `---\nname: uses-tool-2\ndescription: x\nversion: 1.0.0\ndependencies:\n  skills:\n    - "${toolOrigin}"\n---\n# Body\n`,
      "utf8",
    );
    const app = mountApp();
    const installRes = await app.request(`/api/workspaces/${ws.id}/catalog/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "file", location: agentDir }),
    });
    expect(installRes.status).toBe(201);

    // Drop the dep + bump the version, then sync the inner tool.
    await writeFile(
      path.join(scratch, "fixtures", "tool", "SKILL.md"),
      SKILL_MD("tool", "1.1.0"),
      "utf8",
    );
    const syncRes = await app.request(
      `/api/workspaces/${ws.id}/catalog/skills/${encodeURIComponent("public/tool")}/sync`,
      { method: "POST" },
    );
    expect(syncRes.status).toBe(200);

    const overviewRes = await app.request(`/api/workspaces/${ws.id}/catalog/overview`);
    const overview = (await overviewRes.json()) as { counts: Record<string, number> };
    expect(overview.counts.orphaned).toBe(1);
  });
});
