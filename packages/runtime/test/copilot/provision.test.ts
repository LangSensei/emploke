import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provisionCopilotWorkdir } from "../../src/copilot/provision.js";
import { flattenSkillName, InvalidMcpJson } from "../../src/index.js";
import type { AgentContentSource } from "../../src/types.js";
import { type FakeFixtures, makeFakeContentSource } from "../fixtures/fake-content-source.js";

const TEST_PLACEHOLDERS = { workspaceDir: "/test/workspace", sharedDir: "/test/global" } as const;

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

const targetDir = (): string => path.join(scratch, "target");

/**
 * Helper: build an in-process `AgentContentSource` fake from declarative
 * fixtures and return a tuple ready to pass to `provisionCopilotWorkdir`.
 *
 * `agent.body` defaults to a minimal valid AGENTS.md. `agent.siblings`
 * lets a test stuff sibling files into the agent dir - this is the new
 * multi-file-agent shape. Skill / MCP dependency edges are declared in
 * the fixture's `deps` map rather than via AGENTS.md / SKILL.md
 * frontmatter, because the fake does NOT parse frontmatter (unlike the
 * previous catalog-backed fixture pipeline).
 */
async function setup(opts: {
  agent?: { name?: string; body?: string; siblings?: Record<string, string> };
  skills?: Record<
    string,
    {
      body?: string;
      extras?: Record<string, string>;
      hooks?: Record<string, string>;
      deps?: { skills?: string[]; mcps?: string[] };
    }
  >;
  mcps?: Record<string, string>;
}): Promise<{ source: AgentContentSource; agentName: string }> {
  const agentShortName = opts.agent?.name ?? "demo-agent";
  const skillKeys = Object.keys(opts.skills ?? {});
  const mcpKeys = Object.keys(opts.mcps ?? {});

  const agentBody =
    opts.agent?.body ??
    [
      "---",
      `name: ${agentShortName}`,
      "description: agent for tests",
      "version: 0.0.1",
      "---",
      "",
    ].join("\n");

  const fixtures: {
    -readonly [K in keyof FakeFixtures]-?: NonNullable<FakeFixtures[K]>;
  } = {
    agents: {
      [agentShortName]: {
        files: { "AGENTS.md": agentBody, ...(opts.agent?.siblings ?? {}) },
        deps: { skills: skillKeys, mcps: mcpKeys },
      },
    },
    skills: {},
    mcps: {},
  };
  for (const [name, sk] of Object.entries(opts.skills ?? {})) {
    const skillBody =
      sk.body ??
      ["---", `name: ${name}`, "description: test skill", "version: 0.0.1", "---", ""].join("\n");
    const files: Record<string, string> = { "SKILL.md": skillBody, ...(sk.extras ?? {}) };
    for (const [rel, c] of Object.entries(sk.hooks ?? {})) {
      files[`hooks/copilot/${rel}`] = c;
    }
    fixtures.skills[name] = { files, ...(sk.deps ? { deps: sk.deps } : {}) };
  }
  // MCP fixtures are runtime-shape (parsed JSON, no `_meta`); the fake
  // never injects or strips `_meta`. Tests that previously passed raw
  // catalog-format JSON strings still hand us strings, so we parse here.
  for (const [fqn, json] of Object.entries(opts.mcps ?? {})) {
    fixtures.mcps[fqn] = JSON.parse(json);
  }
  const { source } = makeFakeContentSource(fixtures);
  return { source, agentName: `public/${agentShortName}` };
}

/**
 * Build a fake whose only mcp ("broken") is registered with a
 * `setMcpConfigOverride(_, new Error(...))` so the runtime's
 * `getMcpRuntimeConfig` call rejects - reproducing the corruption
 * scenario the previous fixture simulated by overwriting on-disk
 * SQLite bytes.
 */
async function makeFakeWithBrokenMcp(specName: string): Promise<{
  source: AgentContentSource;
  agentName: string;
  mcpName: string;
}> {
  const agentShortName = "demo-agent";
  const agentBody = [
    "---",
    `name: ${agentShortName}`,
    "description: a",
    "version: 0.0.1",
    "---",
    "",
  ].join("\n");
  const fake = makeFakeContentSource({
    agents: {
      [agentShortName]: {
        files: { "AGENTS.md": agentBody },
        // CRITICAL: declare the MCP dep here. The fake does NOT parse
        // AGENTS.md frontmatter; if deps.mcps is omitted, resolveAgent
        // returns mcps: [] and getMcpRuntimeConfig is never called -
        // the InvalidMcpJson path would NOT fire and the test would
        // pass for the wrong reason.
        deps: { mcps: [specName] },
      },
    },
    // Placeholder body; overridden on the next line via the setter so
    // getMcpRuntimeConfig(specName) rejects with the broken-JSON error.
    mcps: { [specName]: {} },
  });
  fake.setMcpConfigOverride(specName, new Error("invalid MCP JSON"));
  return { source: fake.source, agentName: `public/${agentShortName}`, mcpName: specName };
}

describe("provisionCopilotWorkdir - basics", () => {
  it("creates the target directory if it does not exist", async () => {
    const t = targetDir();
    expect(await exists(t)).toBe(false);
    const { source, agentName } = await setup({});
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await exists(t)).toBe(true);
  });

  it("copies AGENTS.md verbatim from the catalog", async () => {
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
    const { source, agentName } = await setup({ agent: { name: "code-reviewer", body } });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await readFile(path.join(t, "AGENTS.md"), "utf8")).toBe(body);
  });

  it("does NOT touch any settings file (trust handling moved to the buildInteractiveLaunch preflight)", async () => {
    const t = targetDir();
    const configPath = path.join(scratch, "copilot-config.json");
    expect(await exists(configPath)).toBe(false);
    const { source, agentName } = await setup({});
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await exists(configPath)).toBe(false);
  });

  it("copies sibling files the agent installs alongside AGENTS.md", async () => {
    // Regression: the old impl only cp'd AGENTS.md, silently dropping
    // sibling files (templates, scripts) the operator bundled into the
    // agent dir. The streaming impl must materialize the whole tree.
    const t = targetDir();
    const { source, agentName } = await setup({
      agent: {
        name: "rich-agent",
        siblings: {
          "prompt.txt": "extra prompt fragment",
          "scripts/run.sh": "#!/bin/sh\necho hi\n",
        },
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await readFile(path.join(t, "prompt.txt"), "utf8")).toBe("extra prompt fragment");
    expect(await readFile(path.join(t, "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
  });

  it("merges agent-side hooks/copilot/ into .github/hooks/", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      agent: {
        name: "hook-agent",
        siblings: { "hooks/copilot/preTool.js": "// agent hook\n" },
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await readFile(path.join(t, ".github", "hooks", "preTool.js"), "utf8")).toBe(
      "// agent hook\n",
    );
    // The hooks/ tree should NOT also be duplicated at the workdir root.
    expect(await exists(path.join(t, "hooks"))).toBe(false);
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

describe("provisionCopilotWorkdir - path-traversal hardening", () => {
  it("refuses to write a catalog entry whose relPath escapes the workdir", async () => {
    // Catalog walker rejects symlinks and only yields readdir-segment
    // names (no `..` possible), so this is defense-in-depth - but a
    // malicious / corrupted SQLite-backed catalog row could still
    // hand back `relPath: "../escape"`. provision must refuse.
    //
    // Built from the real `makeFakeContentSource` fake so the port
    // shape is enforced by TypeScript; we then override `agentEntries`
    // to inject the adversarial `relPath`. The previous shape declared
    // an inline `as any` stub that drifted from the real
    // `AgentContentSource` port (carrying a stale `getMcpContent`
    // method name) and silently allowed the drift to live.
    const t = targetDir();
    const { source: baseSource } = makeFakeContentSource({
      agents: { demo: { files: { "AGENTS.md": "ok" } } },
    });
    const malicious: AgentContentSource = {
      ...baseSource,
      agentEntries: async function* (_n: string) {
        yield { relPath: "AGENTS.md", content: Buffer.from("ok") };
        yield { relPath: "../escape.txt", content: Buffer.from("PWNED") };
      },
    };
    const resolved = await malicious.resolveAgent("demo");
    await expect(
      provisionCopilotWorkdir(t, resolved, malicious, TEST_PLACEHOLDERS),
    ).rejects.toMatchObject({ message: expect.stringContaining("outside workdir") });
    // No file written outside the workdir.
    expect(await exists(path.join(scratch, "escape.txt"))).toBe(false);
  });
});

describe("provisionCopilotWorkdir - MCP config", () => {
  it("writes .mcp.json with each MCP's parsed JSON nested under mcpServers (spec FQN keys, _meta stripped)", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      mcps: {
        "io.playwright/mcp": JSON.stringify({ command: "npx", args: ["@playwright/mcp"] }),
        "swat/cli": JSON.stringify({ command: "swat" }),
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );

    const written = JSON.parse(await readFile(path.join(t, ".mcp.json"), "utf8"));
    // Keys are the FULL MCP-spec FQN with `/` (Copilot CLI accepts
    // `/` - verified empirically). The `_meta` block is stripped
    // from each MCP body before writing - Copilot CLI shouldn't see
    // emploke's metadata.
    expect(written).toEqual({
      mcpServers: {
        "io.playwright/mcp": { command: "npx", args: ["@playwright/mcp"] },
        "swat/cli": { command: "swat" },
      },
    });
  });

  it("does not write .mcp.json when there are no MCPs", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({});
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await exists(path.join(t, ".mcp.json"))).toBe(false);
  });

  it("throws InvalidMcpJson when an MCP is corrupted between scan and provision", async () => {
    const t = targetDir();
    const dirty = await makeFakeWithBrokenMcp("broken/mcp");
    await expect(
      provisionCopilotWorkdir(
        t,
        await dirty.source.resolveAgent(dirty.agentName),
        dirty.source,
        TEST_PLACEHOLDERS,
      ),
    ).rejects.toBeInstanceOf(InvalidMcpJson);
  });

  it("InvalidMcpJson exposes mcpName and cause", async () => {
    const t = targetDir();
    const dirty = await makeFakeWithBrokenMcp("broken/mcp");
    try {
      await provisionCopilotWorkdir(
        t,
        await dirty.source.resolveAgent(dirty.agentName),
        dirty.source,
        TEST_PLACEHOLDERS,
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMcpJson);
      const err = e as InvalidMcpJson;
      expect(err.mcpName).toBe("broken/mcp");
      expect(err.cause).toBeInstanceOf(Error);
    }
  });
});

describe("provisionCopilotWorkdir - skills copy", () => {
  it("copies SKILL.md to .github/skills/<name>/SKILL.md", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      skills: { foo: { body: "---\nname: foo\ndescription: f\nversion: 0.0.1\n---\n# Foo\n" } },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await readFile(path.join(t, ".github/skills/foo/SKILL.md"), "utf8")).toContain(
      "# Foo\n",
    );
  });

  it("preserves nested files under the skill directory", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      skills: {
        foo: { extras: { "assets/logo.png": "PNG", "templates/main.tmpl": "TMPL" } },
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await readFile(path.join(t, ".github/skills/foo/assets/logo.png"), "utf8")).toBe("PNG");
    expect(await readFile(path.join(t, ".github/skills/foo/templates/main.tmpl"), "utf8")).toBe(
      "TMPL",
    );
  });

  it("excludes the skill's top-level hooks/copilot/ subdirectory from the skills copy", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      skills: { foo: { hooks: { "h.sh": "#!/bin/sh\n" } } },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await exists(path.join(t, ".github/skills/foo/hooks"))).toBe(false);
  });

  it("flattens scoped skill names", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      skills: {
        "langsensei/weather": {
          // Frontmatter `name` is the SHORT name and scope is set
          // explicitly (or auto-derived from origin). Here we override
          // scope so the FQN becomes langsensei/weather even though the
          // synthetic origin would otherwise yield `local`.
          body: "---\nname: weather\nscope: langsensei\ndescription: w\nversion: 0.0.1\n---\n# Weather\n",
        },
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(
      await readFile(path.join(t, ".github/skills/langsensei__weather/SKILL.md"), "utf8"),
    ).toContain("# Weather\n");
    expect(await exists(path.join(t, ".github/skills/langsensei"))).toBe(false);
  });
});

describe("provisionCopilotWorkdir - hooks composition", () => {
  it("merges hooks/copilot/* from each skill into .github/hooks/", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      skills: {
        a: { hooks: { "a.sh": "A\n" } },
        b: { hooks: { "b.sh": "B\n", "shared/cfg.json": '{"x":1}' } },
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    // Skill hooks are prefixed `<flattenedFqn>__` so two skills sharing a
    // short name can't collide on a hook filename. The implicit `local/`
    // scope is stripped, so `local/a` flattens to `a`.
    expect(await readFile(path.join(t, ".github/hooks/a__a.sh"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(t, ".github/hooks/b__b.sh"), "utf8")).toBe("B\n");
    expect(await readFile(path.join(t, ".github/hooks/shared/b__cfg.json"), "utf8")).toBe(
      '{"x":1}',
    );
  });

  it("does not create .github/hooks/ when no skill contributes copilot hooks", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({ skills: { foo: {} } });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await exists(path.join(t, ".github/hooks"))).toBe(false);
  });

  it("on file conflict, the later skill in topological order wins", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      skills: {
        // `later` depends on `earlier` so the topological order is
        // [earlier, later] in the resolve result. Hook filenames are
        // prefixed per-skill, so a true cross-skill collision is
        // impossible by construction - but if `later` were authored to
        // ship a hook that overrode `earlier`'s contribution, the
        // prefixed names ensure the writer rewrites only its own slot.
        earlier: { hooks: { "shared.sh": "first\n" } },
        later: { deps: { skills: ["earlier"] }, hooks: { "shared.sh": "second\n" } },
      },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await readFile(path.join(t, ".github/hooks/earlier__shared.sh"), "utf8")).toBe(
      "first\n",
    );
    expect(await readFile(path.join(t, ".github/hooks/later__shared.sh"), "utf8")).toBe("second\n");
  });
});

describe("provisionCopilotWorkdir - workdir prep", () => {
  // Pin the contract that we do NOT plant a .git/ directory. Copilot CLI
  // loads hooks from <cwd>/.github/hooks/*.json directly (per the
  // official hooks reference) - no git repo required. Skipping `git
  // init` removes a hard dependency on the host's `git` binary and
  // keeps purge cheap.
  it("does NOT initialise a git repository in the target directory", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({});
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );
    expect(await exists(path.join(t, ".git"))).toBe(false);
  });
});

describe("provisionCopilotWorkdir - end-to-end shape", () => {
  it("produces the documented layout for a full agent definition", async () => {
    const t = targetDir();
    const { source, agentName } = await setup({
      agent: { name: "demo", siblings: { "prompt.md": "## extra\n" } },
      skills: {
        "dev/lint": {
          body: "---\nname: lint\nscope: dev\ndescription: lint\nversion: 0.0.1\n---\n",
          extras: { "rules.json": "{}" },
          hooks: { "post-write.sh": "echo done\n" },
        },
      },
      mcps: { "hello/world": JSON.stringify({ command: "hello" }) },
    });
    await provisionCopilotWorkdir(
      t,
      await source.resolveAgent(agentName),
      source,
      TEST_PLACEHOLDERS,
    );

    expect(await exists(path.join(t, "AGENTS.md"))).toBe(true);
    expect(await exists(path.join(t, "prompt.md"))).toBe(true);
    expect(await exists(path.join(t, ".mcp.json"))).toBe(true);
    expect(await exists(path.join(t, ".github/skills/dev__lint/SKILL.md"))).toBe(true);
    expect(await exists(path.join(t, ".github/skills/dev__lint/rules.json"))).toBe(true);
    // dev__lint__post-write.sh - skill hooks ARE prefixed (cross-skill
    // collision-prevention); see provision.ts SCOPE_FLATTEN_SEP doc.
    expect(await exists(path.join(t, ".github/hooks/dev__lint__post-write.sh"))).toBe(true);
    // No .git/ - see the workdir-prep describe block above.
    expect(await exists(path.join(t, ".git"))).toBe(false);
  });
});
