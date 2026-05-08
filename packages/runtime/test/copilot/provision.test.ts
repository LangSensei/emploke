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
const settingsPath = (): string => path.join(scratch, "copilot-settings.json");

const provisionOpts = (): { copilotSettingsPath: string } => ({
  copilotSettingsPath: settingsPath(),
});

describe("provisionCopilotWorkdir — basics", () => {
  it("creates the target directory if it does not exist", async () => {
    const t = targetDir();
    expect(await exists(t)).toBe(false);
    await provisionCopilotWorkdir(t, await buildResolveResult([], []), provisionOpts());
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
    await provisionCopilotWorkdir(
      t,
      await buildResolveResult([], [], fakeAgent(), body),
      provisionOpts(),
    );
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

    await provisionCopilotWorkdir(
      t,
      await buildResolveResult([], [playwright, swat]),
      provisionOpts(),
    );

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
    await provisionCopilotWorkdir(t, await buildResolveResult([], []), provisionOpts());
    expect(await exists(path.join(t, ".mcp.json"))).toBe(false);
  });

  it("throws InvalidMcpJson when an MCP file fails JSON parse", async () => {
    const t = targetDir();
    const broken = await makeMcpFixture("broken", "{not-json");
    await expect(
      provisionCopilotWorkdir(t, await buildResolveResult([], [broken]), provisionOpts()),
    ).rejects.toBeInstanceOf(InvalidMcpJson);
  });

  it("InvalidMcpJson exposes mcpName, path, and cause", async () => {
    const t = targetDir();
    const broken = await makeMcpFixture("broken", "{not-json");
    try {
      await provisionCopilotWorkdir(t, await buildResolveResult([], [broken]), provisionOpts());
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
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []), provisionOpts());
    expect(await readFile(path.join(t, ".github/skills/foo/SKILL.md"), "utf8")).toBe("# Foo\n");
  });

  it("preserves nested files under the skill directory", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", {
      extraFiles: { "assets/logo.png": "PNG", "templates/main.tmpl": "TMPL" },
    });
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []), provisionOpts());
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
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []), provisionOpts());
    expect(await exists(path.join(t, ".github/skills/foo/hooks"))).toBe(false);
  });

  it("flattens scoped skill names", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("langsensei/weather", { skillBody: "# Weather\n" });
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []), provisionOpts());
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
    await provisionCopilotWorkdir(t, await buildResolveResult([a, b], []), provisionOpts());
    expect(await readFile(path.join(t, ".github/hooks/a.sh"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(t, ".github/hooks/b.sh"), "utf8")).toBe("B\n");
    expect(await readFile(path.join(t, ".github/hooks/shared/cfg.json"), "utf8")).toBe('{"x":1}');
  });

  it("does not create .github/hooks/ when no skill contributes copilot hooks", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo");
    await provisionCopilotWorkdir(t, await buildResolveResult([skill], []), provisionOpts());
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
    await provisionCopilotWorkdir(
      t,
      await buildResolveResult([earlier, later], []),
      provisionOpts(),
    );
    expect(await readFile(path.join(t, ".github/hooks/shared.sh"), "utf8")).toBe("second\n");
  });
});

describe("provisionCopilotWorkdir — workspace prep", () => {
  it("runs git init in the target directory", async () => {
    const t = targetDir();
    await provisionCopilotWorkdir(t, await buildResolveResult([], []), provisionOpts());
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

describe("provisionCopilotWorkdir — trusted folders", () => {
  // The Copilot CLI prompts on every untrusted folder before allowing tool
  // use; that prompt is fatal for emploke's "open a terminal and start
  // copilot" UX. So at provision time we must ensure the workdir (or any
  // ancestor) is listed in `<settings>.trustedFolders`.

  it("creates the settings file with the workdir trusted when it is missing", async () => {
    const t = targetDir();
    const sp = settingsPath();
    expect(await exists(sp)).toBe(false);
    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });

  it("appends the workdir to existing trustedFolders without disturbing other keys", async () => {
    const t = targetDir();
    const sp = settingsPath();
    const previous = {
      logLevel: "info",
      trustedFolders: ["/already/trusted"],
      lastLoggedInUser: { host: "https://github.com", login: "alice" },
    };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.logLevel).toBe("info");
    expect(written.lastLoggedInUser).toEqual(previous.lastLoggedInUser);
    expect(written.trustedFolders).toEqual(["/already/trusted", path.resolve(t)]);
  });

  it("does not duplicate the entry when the workdir is already trusted", async () => {
    const t = targetDir();
    const sp = settingsPath();
    const previous = { trustedFolders: [path.resolve(t)] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });

  it("treats a parent of the workdir as covering, leaving settings unchanged", async () => {
    // Common emploke layout: every session lives under ~/.emploke, so once
    // ~/.emploke is trusted we should never re-add per-session entries.
    const ancestor = scratch;
    const t = path.join(ancestor, "deep", "nested", "session");
    await mkdir(t, { recursive: true });
    const sp = settingsPath();
    const previous = { trustedFolders: [ancestor] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([ancestor]);
  });

  it("does NOT confuse a sibling-prefix string for a parent (e.g. /foo vs /foobar)", async () => {
    const t = path.join(scratch, "foobar", "session");
    await mkdir(t, { recursive: true });
    const sp = settingsPath();
    const sibling = path.join(scratch, "foo");
    const previous = { trustedFolders: [sibling] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([sibling, path.resolve(t)]);
  });

  it("recovers when settings.json is malformed by starting fresh", async () => {
    const t = targetDir();
    const sp = settingsPath();
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, "{not valid json", "utf8");

    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });

  it("ignores non-string entries in an existing trustedFolders array", async () => {
    const t = targetDir();
    const sp = settingsPath();
    const previous = { trustedFolders: [42, null, "/already", { not: "a string" }] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous), "utf8");

    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual(["/already", path.resolve(t)]);
  });

  // Concurrency hardening: the read-modify-write cycle on settings.json
  // is protected by an O_EXCL lock file. Without the lock, two parallel
  // provisions would both pass `isPathCovered` before either wrote, then
  // the second `rename()` would clobber the first writer's entries (and
  // any unrelated keys the user happened to have between the two reads).
  // These tests pin the lock behavior.

  it("serialises concurrent provisions: every workdir ends up trusted exactly once", async () => {
    const sp = settingsPath();
    // 8 distinct workdirs sharing the same settings file. Run all
    // provisions in parallel — any lost-update race will leave at least
    // one workdir absent from the final trustedFolders array.
    const workdirs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const w = path.join(scratch, `concurrent-${i}`);
      workdirs.push(w);
    }
    const resolves = await Promise.all(workdirs.map(() => buildResolveResult([], [])));
    await Promise.all(
      workdirs.map((w, i) => provisionCopilotWorkdir(w, resolves[i]!, { copilotSettingsPath: sp })),
    );

    const written = JSON.parse(await readFile(sp, "utf8"));
    const trusted: string[] = written.trustedFolders;
    // Every workdir must appear (no lost updates).
    for (const w of workdirs) {
      expect(trusted).toContain(path.resolve(w));
    }
    // No duplicates — `isPathCovered` short-circuits inside the lock.
    const uniq = new Set(trusted);
    expect(uniq.size).toBe(trusted.length);
  });

  it("preserves unrelated keys across concurrent provisions (no lost-update on logLevel)", async () => {
    const sp = settingsPath();
    // Seed a settings file with a non-trustedFolders key. Concurrent
    // provisions must not silently drop it on a stale read.
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(
      sp,
      `${JSON.stringify({ logLevel: "info", lastLoggedInUser: { login: "alice" } }, null, 2)}\n`,
      "utf8",
    );

    const workdirs = Array.from({ length: 6 }, (_, i) => path.join(scratch, `co-${i}`));
    const resolves = await Promise.all(workdirs.map(() => buildResolveResult([], [])));
    await Promise.all(
      workdirs.map((w, i) => provisionCopilotWorkdir(w, resolves[i]!, { copilotSettingsPath: sp })),
    );

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.logLevel).toBe("info");
    expect(written.lastLoggedInUser).toEqual({ login: "alice" });
    for (const w of workdirs) {
      expect(written.trustedFolders).toContain(path.resolve(w));
    }
  });

  it("releases the lock file when provision succeeds (no zombie lock)", async () => {
    const t = targetDir();
    const sp = settingsPath();
    await provisionCopilotWorkdir(t, await buildResolveResult([], []), { copilotSettingsPath: sp });
    expect(await exists(`${sp}.lock`)).toBe(false);
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

    await provisionCopilotWorkdir(t, await buildResolveResult([skill], [mcp]), provisionOpts());

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
