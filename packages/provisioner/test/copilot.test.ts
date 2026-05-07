import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Agent,
  AgentResolveResult,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
} from "@emploke/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CopilotProvisioner,
  flattenSkillName,
  InvalidMcpJson,
  WorkspacePrepFailed,
} from "../src/index.js";

const execFile = promisify(execFileCb);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "provisioner-copilot-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────

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

/**
 * Lay out a skill dir on disk under `scratch/source/<name>` with optional
 * extra files and per-provider hook content. Returns a ResolvedSkill for
 * use in a fake AgentResolveResult.
 */
async function makeSkillFixture(
  name: string,
  opts: {
    skillBody?: string;
    extraFiles?: Record<string, string>;
    hooks?: { copilot?: Record<string, string> };
  } = {},
): Promise<ResolvedSkill> {
  const skillDir = join(scratch, "source", "skills", ...name.split("/"));
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), opts.skillBody ?? `# ${name}\n`, "utf8");

  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const p = join(skillDir, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, content, "utf8");
  }

  if (opts.hooks?.copilot) {
    const hooksDir = join(skillDir, "hooks", "copilot");
    await mkdir(hooksDir, { recursive: true });
    for (const [rel, content] of Object.entries(opts.hooks.copilot)) {
      const p = join(hooksDir, rel);
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, content, "utf8");
    }
  }

  return { skill: fakeSkill(name), path: skillDir };
}

async function makeMcpFixture(name: string, contents: string): Promise<ResolvedMcp> {
  const fname = name.includes("/") ? `${name.split("/").join("-")}.json` : `${name}.json`;
  const path = join(scratch, "source", "mcps", fname);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
  return { name, path };
}

/**
 * Builds an AgentResolveResult AND lays out the agent dir on disk with an
 * `AGENTS.md` so the provisioner can copy it. Pass `agentBody` to control
 * the file content (defaults to a minimal placeholder).
 */
async function buildResolveResult(
  skills: ResolvedSkill[],
  mcps: ResolvedMcp[],
  agent: Agent = fakeAgent(),
  agentBody = "# fake agent\n",
): Promise<AgentResolveResult> {
  const agentPath = join(scratch, "source", "agents", agent.name);
  await mkdir(agentPath, { recursive: true });
  await writeFile(join(agentPath, "AGENTS.md"), agentBody, "utf8");
  return { agent, agentPath, skills, mcps };
}

const targetDir = (): string => join(scratch, "target");

// ─── Tests ────────────────────────────────────────────────

describe("CopilotProvisioner — basics", () => {
  it("name is 'copilot'", () => {
    expect(new CopilotProvisioner().name).toBe("copilot");
  });

  it("creates the target directory if it does not exist", async () => {
    const t = targetDir();
    expect(await exists(t)).toBe(false);
    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([], []),
      targetDir: t,
    });
    expect(await exists(t)).toBe(true);
  });
});

describe("CopilotProvisioner — agent file (AGENTS.md)", () => {
  it("copies AGENTS.md verbatim from the resolved agent path (incl. frontmatter)", async () => {
    const t = targetDir();
    const body = [
      "---",
      "name: code-reviewer",
      "description: Reviews code",
      "version: 1.0.0",
      "---",
      "",
      "You are a senior code reviewer.",
      "Focus on security and correctness.",
      "",
    ].join("\n");

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([], [], fakeAgent(), body),
      targetDir: t,
    });

    expect(await readFile(join(t, "AGENTS.md"), "utf8")).toBe(body);
  });

  it("overwrites an existing AGENTS.md on re-provision", async () => {
    const t = targetDir();
    const provisioner = new CopilotProvisioner();
    const agent = fakeAgent();

    await provisioner.provision({
      resolveResult: await buildResolveResult([], [], agent, "first\n"),
      targetDir: t,
    });
    expect(await readFile(join(t, "AGENTS.md"), "utf8")).toBe("first\n");

    // Mutate the source AGENTS.md and re-provision — copy must reflect new content.
    const agentPath = join(scratch, "source", "agents", agent.name);
    await writeFile(join(agentPath, "AGENTS.md"), "second\n", "utf8");
    await provisioner.provision({
      resolveResult: { agent, agentPath, skills: [], mcps: [] },
      targetDir: t,
    });
    expect(await readFile(join(t, "AGENTS.md"), "utf8")).toBe("second\n");
  });
});

describe("flattenSkillName", () => {
  it("leaves unscoped names unchanged", () => {
    expect(flattenSkillName("weather")).toBe("weather");
    expect(flattenSkillName("kebab-case-name")).toBe("kebab-case-name");
  });

  it("flattens scoped names with double underscore", () => {
    expect(flattenSkillName("langsensei/weather")).toBe("langsensei__weather");
  });

  it("preserves dots in reverse-DNS scopes", () => {
    expect(flattenSkillName("io.playwright/mcp")).toBe("io.playwright__mcp");
    expect(flattenSkillName("com.example.foo/bar-baz")).toBe("com.example.foo__bar-baz");
  });

  it("is reversible via split('__')", () => {
    const original = "langsensei/weather";
    const flat = flattenSkillName(original);
    expect(flat.split("__").join("/")).toBe(original);
  });
});

describe("CopilotProvisioner — MCP config", () => {
  it("writes .mcp.json with each MCP's parsed JSON nested under mcpServers", async () => {
    const t = targetDir();
    const playwright = await makeMcpFixture(
      "io.playwright/mcp",
      JSON.stringify({ command: "npx", args: ["@playwright/mcp"] }),
    );
    const swat = await makeMcpFixture("swat", JSON.stringify({ command: "swat" }));

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([], [playwright, swat]),
      targetDir: t,
    });

    const written = JSON.parse(await readFile(join(t, ".mcp.json"), "utf8"));
    expect(written).toEqual({
      mcpServers: {
        "io.playwright/mcp": { command: "npx", args: ["@playwright/mcp"] },
        swat: { command: "swat" },
      },
    });
  });

  it("does not write .mcp.json when there are no MCPs", async () => {
    const t = targetDir();
    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([], []),
      targetDir: t,
    });
    expect(await exists(join(t, ".mcp.json"))).toBe(false);
  });

  it("throws InvalidMcpJson when an MCP file fails JSON parse", async () => {
    const t = targetDir();
    const broken = await makeMcpFixture("broken", "{not-json");

    const provisioner = new CopilotProvisioner();
    await expect(
      provisioner.provision({
        resolveResult: await buildResolveResult([], [broken]),
        targetDir: t,
      }),
    ).rejects.toBeInstanceOf(InvalidMcpJson);
  });

  it("InvalidMcpJson exposes mcpName, path, and cause", async () => {
    const t = targetDir();
    const broken = await makeMcpFixture("broken", "{not-json");

    try {
      await new CopilotProvisioner().provision({
        resolveResult: await buildResolveResult([], [broken]),
        targetDir: t,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMcpJson);
      const err = e as InvalidMcpJson;
      expect(err.mcpName).toBe("broken");
      expect(err.path).toBe(broken.path);
      expect(err.cause).toBeInstanceOf(Error);
    }
  });
});

describe("CopilotProvisioner — skills copy", () => {
  it("copies SKILL.md to .github/skills/<name>/SKILL.md", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", { skillBody: "# Foo skill\n" });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/skills/foo/SKILL.md"), "utf8")).toBe("# Foo skill\n");
  });

  it("preserves nested files under the skill directory", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", {
      extraFiles: {
        "assets/logo.png": "PNG",
        "templates/main.tmpl": "TMPL",
      },
    });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/skills/foo/assets/logo.png"), "utf8")).toBe("PNG");
    expect(await readFile(join(t, ".github/skills/foo/templates/main.tmpl"), "utf8")).toBe("TMPL");
  });

  it("excludes the skill's top-level hooks/ subdirectory", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", {
      hooks: { copilot: { "pre-commit.sh": "#!/bin/sh\necho hi\n" } },
    });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await exists(join(t, ".github/skills/foo/hooks"))).toBe(false);
  });

  it("flattens scoped skill names into a single dir (langsensei/weather → langsensei__weather)", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("langsensei/weather", {
      skillBody: "# Weather\n",
    });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/skills/langsensei__weather/SKILL.md"), "utf8")).toBe(
      "# Weather\n",
    );
    // Negative: no nested scope dir should be created.
    expect(await exists(join(t, ".github/skills/langsensei"))).toBe(false);
  });

  it("flattens reverse-DNS scopes while preserving dots (io.playwright/mcp)", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("io.playwright/mcp", {
      skillBody: "# Playwright\n",
    });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/skills/io.playwright__mcp/SKILL.md"), "utf8")).toBe(
      "# Playwright\n",
    );
  });

  it("leaves unscoped skill names untouched", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("plain-name", { skillBody: "# Plain\n" });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/skills/plain-name/SKILL.md"), "utf8")).toBe("# Plain\n");
  });
});

describe("CopilotProvisioner — hooks composition", () => {
  it("merges hooks/copilot/* from each skill into .github/hooks/", async () => {
    const t = targetDir();
    const a = await makeSkillFixture("a", {
      hooks: { copilot: { "a.sh": "A\n" } },
    });
    const b = await makeSkillFixture("b", {
      hooks: { copilot: { "b.sh": "B\n", "shared/cfg.json": '{"x":1}' } },
    });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([a, b], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/hooks/a.sh"), "utf8")).toBe("A\n");
    expect(await readFile(join(t, ".github/hooks/b.sh"), "utf8")).toBe("B\n");
    expect(await readFile(join(t, ".github/hooks/shared/cfg.json"), "utf8")).toBe('{"x":1}');
  });

  it("does not create .github/hooks/ when no skill contributes copilot hooks", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo");

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], []),
      targetDir: t,
    });

    expect(await exists(join(t, ".github/hooks"))).toBe(false);
  });

  it("on file conflict, the later skill in topological order wins", async () => {
    const t = targetDir();
    const earlier = await makeSkillFixture("earlier", {
      hooks: { copilot: { "shared.sh": "first\n" } },
    });
    const later = await makeSkillFixture("later", {
      hooks: { copilot: { "shared.sh": "second\n" } },
    });

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([earlier, later], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/hooks/shared.sh"), "utf8")).toBe("second\n");
  });

  it("skips skills whose hooks/copilot/ does not exist", async () => {
    const t = targetDir();
    const withHooks = await makeSkillFixture("with", {
      hooks: { copilot: { "h.sh": "H\n" } },
    });
    const without = await makeSkillFixture("without");

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([withHooks, without], []),
      targetDir: t,
    });

    expect(await readFile(join(t, ".github/hooks/h.sh"), "utf8")).toBe("H\n");
  });
});

describe("CopilotProvisioner — workspace prep", () => {
  it("runs git init in the target directory", async () => {
    const t = targetDir();
    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([], []),
      targetDir: t,
    });
    expect(await exists(join(t, ".git"))).toBe(true);
  });

  it("WorkspacePrepFailed wraps the underlying cause and exposes step + targetDir", () => {
    // The error path is triggered when `git init` fails (e.g. git missing
    // from PATH). Exercising that in a unit test would require manipulating
    // the parent process PATH or stubbing child_process, both of which are
    // worse than asserting the error class shape directly.
    const wrapped = new WorkspacePrepFailed(
      "git init",
      "/some/dir",
      new Error("ENOENT: git not found"),
    );
    expect(wrapped).toBeInstanceOf(WorkspacePrepFailed);
    expect(wrapped.step).toBe("git init");
    expect(wrapped.targetDir).toBe("/some/dir");
    expect(wrapped.cause.message).toBe("ENOENT: git not found");
    expect(wrapped.message).toContain("git init");
  });
});

describe("CopilotProvisioner — idempotency", () => {
  it("calling provision twice on the same target dir succeeds and keeps content correct", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("foo", {
      hooks: { copilot: { "h.sh": "H1\n" } },
    });
    const mcp = await makeMcpFixture("m", '{"command":"m"}');

    const params = {
      resolveResult: await buildResolveResult([skill], [mcp]),
      targetDir: t,
    };

    const provisioner = new CopilotProvisioner();
    await provisioner.provision(params);
    await provisioner.provision(params);

    expect(await readFile(join(t, "AGENTS.md"), "utf8")).toBe("# fake agent\n");
    expect(await readFile(join(t, ".github/skills/foo/SKILL.md"), "utf8")).toBe("# foo\n");
    expect(await readFile(join(t, ".github/hooks/h.sh"), "utf8")).toBe("H1\n");
    expect(await exists(join(t, ".git"))).toBe(true);
  });
});

describe("CopilotProvisioner — end-to-end shape", () => {
  it("produces the documented layout for a full agent definition", async () => {
    const t = targetDir();
    const skill = await makeSkillFixture("dev/lint", {
      skillBody: "# Lint\n",
      extraFiles: { "rules.json": "{}" },
      hooks: { copilot: { "post-write.sh": "echo done\n" } },
    });
    const mcp = await makeMcpFixture("playwright", '{"command":"npx"}');

    await new CopilotProvisioner().provision({
      resolveResult: await buildResolveResult([skill], [mcp]),
      targetDir: t,
    });

    const checks = await Promise.all([
      exists(join(t, "AGENTS.md")),
      exists(join(t, ".mcp.json")),
      exists(join(t, ".github/skills/dev__lint/SKILL.md")),
      exists(join(t, ".github/skills/dev__lint/rules.json")),
      exists(join(t, ".github/hooks/post-write.sh")),
      exists(join(t, ".git")),
      exists(join(t, ".github/skills/dev__lint/hooks")),
    ]);

    expect(checks.slice(0, 6).every(Boolean)).toBe(true);
    expect(checks[6]).toBe(false); // hooks/ excluded from skills copy

    // Sanity-check git can read the repo we initialised.
    const { stdout } = await execFile("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: t,
    });
    expect(stdout.trim()).toBe("true");
  });

  /**
   * Kitchen-sink demo: a realistic agent with three skills (one unscoped,
   * one scoped, one reverse-DNS scoped), two MCPs (one unscoped, one scoped),
   * and hooks contributed by two of the skills.
   *
   * This test serves as a runnable specification — read it to see exactly
   * what input AgentResolveResult shape produces what on-disk layout.
   */
  it("kitchen sink: agent + 3 skills + 2 MCPs + hooks → full documented layout", async () => {
    const t = targetDir();

    // ─── 1. Build skill fixtures on disk ────────────────────
    //
    // Each fixture writes a directory under scratch/source/skills/<name>/
    // and returns the ResolvedSkill { skill, path } that the resolver
    // would have produced.

    const formatting = await makeSkillFixture("formatting", {
      skillBody: "# Formatting\n\nFormat code consistently.\n",
    });

    const security = await makeSkillFixture("langsensei/security-audit", {
      skillBody: "# Security Audit\n\nAudit dependencies for CVEs.\n",
      extraFiles: { "rules.json": '{"strict":true}' },
      hooks: { copilot: { "pre-commit.sh": "#!/bin/sh\necho audit\n" } },
    });

    const browser = await makeSkillFixture("io.playwright/browser", {
      skillBody: "# Browser\n",
      extraFiles: { "assets/launch.json": '{"headless":true}' },
      hooks: { copilot: { "screenshot.sh": "#!/bin/sh\necho shoot\n" } },
    });

    // ─── 2. Build MCP fixtures on disk ──────────────────────

    const playwrightMcp = await makeMcpFixture(
      "playwright",
      JSON.stringify({ command: "npx", args: ["@playwright/mcp"] }),
    );
    const notesMcp = await makeMcpFixture(
      "langsensei/notes",
      JSON.stringify({ command: "notes-mcp" }),
    );

    // ─── 3. Construct the full AgentResolveResult INLINE ────
    //
    // This is exactly what `catalog.resolveAgent("code-reviewer")` would
    // return in production. Provisioner only depends on this shape.

    const codeReviewer: Agent = {
      name: "code-reviewer",
      description: "Reviews code with focus on security and style.",
      version: "1.0.0",
      dependencies: {
        skills: ["formatting", "langsensei/security-audit", "io.playwright/browser"],
        mcps: ["playwright", "langsensei/notes"],
      },
    };

    // The agent's directory contains its AGENTS.md (the persona file);
    // provisioner copies it verbatim into the workdir. Per-task instructions
    // are not part of this file — they're passed by the runtime via `-p`.
    const agentPath = join(scratch, "source", "agents", "code-reviewer");
    await mkdir(agentPath, { recursive: true });
    const agentMdContent = [
      "---",
      "name: code-reviewer",
      "description: Reviews code with focus on security and style.",
      "version: 1.0.0",
      "---",
      "",
      "You are a senior code reviewer.",
      "Focus on security, correctness, and maintainability.",
      "",
    ].join("\n");
    await writeFile(join(agentPath, "AGENTS.md"), agentMdContent, "utf8");

    const resolveResult: AgentResolveResult = {
      agent: codeReviewer,
      agentPath,
      // Topological order: independent skills first; provisioner copies in order
      // so later entries overwrite earlier ones on file conflicts.
      skills: [formatting, security, browser],
      mcps: [playwrightMcp, notesMcp],
    };

    // ─── 4. Provision ───────────────────────────────────────

    await new CopilotProvisioner().provision({
      resolveResult,
      targetDir: t,
    });

    // ─── 5. Assert the full produced layout ─────────────────
    //
    // Expected on-disk tree:
    //
    //   <targetDir>/
    //   ├── AGENTS.md                                 (copied from agentPath)
    //   ├── .mcp.json
    //   ├── .git/                                     (from `git init`)
    //   └── .github/
    //       ├── skills/
    //       │   ├── formatting/
    //       │   │   └── SKILL.md
    //       │   ├── langsensei__security-audit/       ← scoped, flattened with __
    //       │   │   ├── SKILL.md
    //       │   │   └── rules.json
    //       │   └── io.playwright__browser/           ← reverse-DNS, dots preserved
    //       │       ├── SKILL.md
    //       │       └── assets/launch.json
    //       └── hooks/                                ← merged from each skill
    //           ├── pre-commit.sh                       (from security-audit)
    //           └── screenshot.sh                       (from browser)

    // 5a. AGENTS.md is copied verbatim from agentPath/AGENTS.md
    //     (frontmatter included — provisioner does not interpret it).
    expect(await readFile(join(t, "AGENTS.md"), "utf8")).toBe(agentMdContent);

    // 5b. .mcp.json wraps each MCP under its catalog name (scoped names
    //     stay scoped — they're JSON keys, not directory names).
    const mcpJson = JSON.parse(await readFile(join(t, ".mcp.json"), "utf8"));
    expect(mcpJson).toEqual({
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp"] },
        "langsensei/notes": { command: "notes-mcp" },
      },
    });

    // 5c. Unscoped skill: plain dir.
    expect(await readFile(join(t, ".github/skills/formatting/SKILL.md"), "utf8")).toBe(
      "# Formatting\n\nFormat code consistently.\n",
    );

    // 5d. Scoped skill: flattened to single dir, hooks/ excluded from skills copy.
    expect(
      await readFile(join(t, ".github/skills/langsensei__security-audit/SKILL.md"), "utf8"),
    ).toBe("# Security Audit\n\nAudit dependencies for CVEs.\n");
    expect(
      await readFile(join(t, ".github/skills/langsensei__security-audit/rules.json"), "utf8"),
    ).toBe('{"strict":true}');
    expect(await exists(join(t, ".github/skills/langsensei__security-audit/hooks"))).toBe(false);
    // Negative: scope segment is NOT a directory of its own.
    expect(await exists(join(t, ".github/skills/langsensei"))).toBe(false);

    // 5e. Reverse-DNS scoped skill: dots preserved in the flat segment;
    //     nested non-`hooks` dirs are copied through.
    expect(await readFile(join(t, ".github/skills/io.playwright__browser/SKILL.md"), "utf8")).toBe(
      "# Browser\n",
    );
    expect(
      await readFile(join(t, ".github/skills/io.playwright__browser/assets/launch.json"), "utf8"),
    ).toBe('{"headless":true}');

    // 5f. Hooks: merged into a single .github/hooks/ regardless of which
    //     skill contributed them.
    expect(await readFile(join(t, ".github/hooks/pre-commit.sh"), "utf8")).toBe(
      "#!/bin/sh\necho audit\n",
    );
    expect(await readFile(join(t, ".github/hooks/screenshot.sh"), "utf8")).toBe(
      "#!/bin/sh\necho shoot\n",
    );

    // 5g. Git repo initialised so Copilot's hook scanner finds .github/hooks.
    expect(await exists(join(t, ".git"))).toBe(true);
    const { stdout } = await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: t });
    expect(stdout.trim()).toBe("true");

    // 5h. Nothing leaked outside the documented surface.
    const skillsRoot = join(t, ".github", "skills");
    const skillDirs = (await readdir(skillsRoot)).sort();
    expect(skillDirs).toEqual([
      "formatting",
      "io.playwright__browser",
      "langsensei__security-audit",
    ]);
    const hooksFiles = (await readdir(join(t, ".github", "hooks"))).sort();
    expect(hooksFiles).toEqual(["pre-commit.sh", "screenshot.sh"]);
  });
});
