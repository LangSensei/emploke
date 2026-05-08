import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  Agent,
  AgentResolveResult,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
} from "@emploke/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provisionCopilotWorkdir } from "../../src/copilot/provision.js";
import { flattenSkillName, InvalidMcpJson, WorkspacePrepFailed } from "../../src/index.js";

const execFile = promisify(execFileCb);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "rt-copilot-prov-"));
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

const fakeAgent = (name = "demo-agent"): Agent => ({
  name,
  description: "agent for tests",
  version: "0.0.1",
});

const fakeSkill = (name: string): Skill => ({
  name,
  description: `${name} skill`,
  version: "0.0.1",
});

async function makeSkillFixture(
  name: string,
  opts: {
    skillBody?: string;
    extraFiles?: Record<string, string>;
    hooks?: { copilot?: Record<string, string> };
  } = {},
): Promise<ResolvedSkill> {
  const skillDir = path.join(scratch, "source", "skills", ...name.split("/"));
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), opts.skillBody ?? `# ${name}\n`, "utf8");

  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const p = path.join(skillDir, rel);
    await mkdir(path.join(p, ".."), { recursive: true });
    await writeFile(p, content, "utf8");
  }

  if (opts.hooks?.copilot) {
    const hooksDir = path.join(skillDir, "hooks", "copilot");
    await mkdir(hooksDir, { recursive: true });
    for (const [rel, content] of Object.entries(opts.hooks.copilot)) {
      const p = path.join(hooksDir, rel);
      await mkdir(path.join(p, ".."), { recursive: true });
      await writeFile(p, content, "utf8");
    }
  }

  return { skill: fakeSkill(name), path: skillDir };
}

async function makeMcpFixture(name: string, contents: string): Promise<ResolvedMcp> {
  const fname = name.includes("/") ? `${name.split("/").join("-")}.json` : `${name}.json`;
  const p = path.join(scratch, "source", "mcps", fname);
  await mkdir(path.join(p, ".."), { recursive: true });
  await writeFile(p, contents, "utf8");
  return { name, path: p };
}

async function buildResolveResult(
  skills: ResolvedSkill[],
  mcps: ResolvedMcp[],
  agent: Agent = fakeAgent(),
  agentBody = "# fake agent\n",
): Promise<AgentResolveResult> {
  const agentPath = path.join(scratch, "source", "agents", agent.name);
  await mkdir(agentPath, { recursive: true });
  await writeFile(path.join(agentPath, "AGENTS.md"), agentBody, "utf8");
  return { agent, agentPath, skills, mcps };
}

const targetDir = (): string => path.join(scratch, "target");

describe("provisionCopilotWorkdir — basics", () => {
  it("creates the target directory if it does not exist", async () => {
    const t = targetDir();
    expect(await exists(t)).toBe(false);
    await provisionCopilotWorkdir(t, await buildResolveResult([], []));
    expect(await exists(t)).toBe(true);
  });

  it("copies AGENTS.md verbatim from the resolved agent path", async () => {
    const t = targetDir();
    const body = [
      "---",
      "name: code-reviewer",
      "description: Reviews code",
      "version: 1.0.0",
      "---",
      "",
      "Be a good reviewer.",
      "",
    ].join("\n");
    await provisionCopilotWorkdir(t, await buildResolveResult([], [], fakeAgent(), body));
    expect(await readFile(path.join(t, "AGENTS.md"), "utf8")).toBe(body);
  });
});

describe("flattenSkillName", () => {
  it("leaves unscoped names unchanged", () => {
    expect(flattenSkillName("weather")).toBe("weather");
  });
  it("flattens scoped names with double underscore", () => {
    expect(flattenSkillName("langsensei/weather")).toBe("langsensei__weather");
  });
  it("preserves dots in reverse-DNS scopes", () => {
    expect(flattenSkillName("io.playwright/mcp")).toBe("io.playwright__mcp");
  });
});

describe("provisionCopilotWorkdir — MCP config", () => {
  it("writes .mcp.json with each MCP's parsed JSON nested under mcpServers", async () => {
    const t = targetDir();
    const playwright = await makeMcpFixture(
      "io.playwright/mcp",
      JSON.stringify({ command: "npx", args: ["@playwright/mcp"] }),
    );
    const swat = await makeMcpFixture("swat", JSON.stringify({ command: "swat" }));

    await provisionCopilotWorkdir(t, await buildResolveResult([], [playwright, swat]));

    const written = JSON.parse(await readFile(path.join(t, ".mcp.json"), "utf8"));
    expect(written).toEqual({
      mcpServers: {
        "io.playwright/mcp": { command: "npx", args: ["@playwright/mcp"] },
        swat: { command: "swat" },
      },
    });
  });

  it("does not write .mcp.json when there are no MCPs", async () => {
    const t = targetDir();
    await provisionCopilotWorkdir(t, await buildResolveResult([], []));
    expect(await exists(path.join(t, ".mcp.json"))).toBe(false);
  });

  it("throws InvalidMcpJson when an MCP file fails JSON parse", async () => {
    const t = targetDir();
    const broken = await makeMcpFixture("broken", "{not-json");
    await expect(
      provisionCopilotWorkdir(t, await buildResolveResult([], [broken])),
    ).rejects.toBeInstanceOf(InvalidMcpJson);
  });

  it("InvalidMcpJson exposes mcpName, path, and cause", async () => {
    const t = targetDir();
    const broken = await makeMcpFixture("broken", "{not-json");
    try {
      await provisionCopilotWorkdir(t, await buildResolveResult([], [broken]));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMcpJson);
      const err = e as InvalidMcpJson;
      expect(err.mcpName).toBe("broken");
      expect(err.mcpPath).toBe(broken.path);
      expect(err.cause).toBeInstanceOf(Error);
    }
  });
});

describe("provisionCopilotWorkdir — skills copy", () => {
  it("copies SKILL.md to .github/skills/<name>/SKILL.md", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", { skillBody: "# Foo\n" });
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []));
    expect(await readFile(path.join(t, ".github/skills/foo/SKILL.md"), "utf8")).toBe("# Foo\n");
  });

  it("preserves nested files under the skill directory", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", {
      extraFiles: { "assets/logo.png": "PNG", "templates/main.tmpl": "TMPL" },
    });
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []));
    expect(await readFile(path.join(t, ".github/skills/foo/assets/logo.png"), "utf8")).toBe("PNG");
    expect(await readFile(path.join(t, ".github/skills/foo/templates/main.tmpl"), "utf8")).toBe(
      "TMPL",
    );
  });

  it("excludes the skill's top-level hooks/ subdirectory from the skills copy", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", {
      hooks: { copilot: { "h.sh": "#!/bin/sh\n" } },
    });
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []));
    expect(await exists(path.join(t, ".github/skills/foo/hooks"))).toBe(false);
  });

  it("flattens scoped skill names", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("langsensei/weather", { skillBody: "# Weather\n" });
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []));
    expect(
      await readFile(path.join(t, ".github/skills/langsensei__weather/SKILL.md"), "utf8"),
    ).toBe("# Weather\n");
    expect(await exists(path.join(t, ".github/skills/langsensei"))).toBe(false);
  });
});

describe("provisionCopilotWorkdir — hooks composition", () => {
  it("merges hooks/copilot/* from each skill into .github/hooks/", async () => {
    const t = targetDir();
    const a = await makeSkillFixture("a", { hooks: { copilot: { "a.sh": "A\n" } } });
    const b = await makeSkillFixture("b", {
      hooks: { copilot: { "b.sh": "B\n", "shared/cfg.json": '{"x":1}' } },
    });
    await provisionCopilotWorkdir(t, await buildResolveResult([a, b], []));
    expect(await readFile(path.join(t, ".github/hooks/a.sh"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(t, ".github/hooks/b.sh"), "utf8")).toBe("B\n");
    expect(await readFile(path.join(t, ".github/hooks/shared/cfg.json"), "utf8")).toBe('{"x":1}');
  });

  it("does not create .github/hooks/ when no skill contributes copilot hooks", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo");
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []));
    expect(await exists(path.join(t, ".github/hooks"))).toBe(false);
  });

  it("on file conflict, the later skill in topological order wins", async () => {
    const t = targetDir();
    const earlier = await makeSkillFixture("earlier", {
      hooks: { copilot: { "shared.sh": "first\n" } },
    });
    const later = await makeSkillFixture("later", {
      hooks: { copilot: { "shared.sh": "second\n" } },
    });
    await provisionCopilotWorkdir(t, await buildResolveResult([earlier, later], []));
    expect(await readFile(path.join(t, ".github/hooks/shared.sh"), "utf8")).toBe("second\n");
  });
});

describe("provisionCopilotWorkdir — workspace prep", () => {
  it("runs git init in the target directory", async () => {
    const t = targetDir();
    await provisionCopilotWorkdir(t, await buildResolveResult([], []));
    expect(await exists(path.join(t, ".git"))).toBe(true);
    const { stdout } = await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: t });
    expect(stdout.trim()).toBe("true");
  });

  it("WorkspacePrepFailed exposes step + targetDir + cause", () => {
    const wrapped = new WorkspacePrepFailed(
      "git init",
      "/some/dir",
      new Error("ENOENT: git not found"),
    );
    expect(wrapped).toBeInstanceOf(WorkspacePrepFailed);
    expect(wrapped.step).toBe("git init");
    expect(wrapped.targetDir).toBe("/some/dir");
    expect((wrapped.cause as Error).message).toBe("ENOENT: git not found");
    expect(wrapped.message).toContain("git init");
  });
});

describe("provisionCopilotWorkdir — end-to-end shape", () => {
  it("produces the documented layout for a full agent definition", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("dev/lint", {
      skillBody: "# Lint\n",
      extraFiles: { "rules.json": "{}" },
      hooks: { copilot: { "post-write.sh": "echo done\n" } },
    });
    const mcp = await makeMcpFixture("playwright", '{"command":"npx"}');

    await provisionCopilotWorkdir(t, await buildResolveResult([skill], [mcp]));

    const checks = await Promise.all([
      exists(path.join(t, "AGENTS.md")),
      exists(path.join(t, ".mcp.json")),
      exists(path.join(t, ".github/skills/dev__lint/SKILL.md")),
      exists(path.join(t, ".github/skills/dev__lint/rules.json")),
      exists(path.join(t, ".github/hooks/post-write.sh")),
      exists(path.join(t, ".git")),
      exists(path.join(t, ".github/skills/dev__lint/hooks")),
    ]);
    expect(checks.slice(0, 6).every(Boolean)).toBe(true);
    expect(checks[6]).toBe(false);
  });
});
