import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as AgentFormat from "../src/agent/agent-frontmatter.js";
import * as SkillFormat from "../src/skill/skill-frontmatter.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const FIRST_PARTY = join(REPO_ROOT, "first-party");

function listEntries(kind: "agents" | "skills"): string[] {
  const dir = join(FIRST_PARTY, kind);
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

function isOriginShape(url: string): boolean {
  // Either file:<abs-path> or https://github.com/<owner>/<repo>/tree/<ref>[/path]
  if (url.startsWith("file:")) return url.length > "file:".length;
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+(\/.+)?$/.test(url);
}

describe("first-party catalog — scope resolution", () => {
  it("has at least one agent and one skill", () => {
    expect(listEntries("agents").length).toBeGreaterThan(0);
    expect(listEntries("skills").length).toBeGreaterThan(0);
  });

  for (const shortName of listEntries("agents")) {
    describe(`agent emploke/${shortName}`, () => {
      const path = join(FIRST_PARTY, "agents", shortName, "AGENTS.md");
      const raw = readFileSync(path, "utf8");
      const { meta } = AgentFormat.parse(raw, `first-party/agents/${shortName}`);

      it("uses scope=emploke", () => {
        expect(meta.scope).toBe("emploke");
      });

      it(`renders FQN as emploke/${shortName}`, () => {
        expect(`${meta.scope}/${meta.shortName}`).toBe(`emploke/${shortName}`);
      });

      it("folder name matches frontmatter.name", () => {
        expect(meta.shortName).toBe(shortName);
      });

      it("all skill dep URLs are well-formed origin strings", () => {
        for (const dep of meta.dependencies?.skills ?? []) {
          expect(isOriginShape(dep), `bad skill dep: ${dep}`).toBe(true);
        }
      });

      it("all mcp dep URLs are well-formed origin strings", () => {
        for (const dep of meta.dependencies?.mcps ?? []) {
          expect(isOriginShape(dep), `bad mcp dep: ${dep}`).toBe(true);
        }
      });
    });
  }

  for (const shortName of listEntries("skills")) {
    describe(`skill emploke/${shortName}`, () => {
      const path = join(FIRST_PARTY, "skills", shortName, "SKILL.md");
      const raw = readFileSync(path, "utf8");
      const { meta } = SkillFormat.parse(raw, `first-party/skills/${shortName}`);

      it("uses scope=emploke", () => {
        expect(meta.scope).toBe("emploke");
      });

      it(`renders FQN as emploke/${shortName}`, () => {
        expect(`${meta.scope}/${meta.shortName}`).toBe(`emploke/${shortName}`);
      });

      it("folder name matches frontmatter.name", () => {
        expect(meta.shortName).toBe(shortName);
      });

      it("all skill dep URLs are well-formed origin strings", () => {
        for (const dep of meta.dependencies?.skills ?? []) {
          expect(isOriginShape(dep), `bad skill dep: ${dep}`).toBe(true);
        }
      });

      it("all mcp dep URLs are well-formed origin strings", () => {
        for (const dep of meta.dependencies?.mcps ?? []) {
          expect(isOriginShape(dep), `bad mcp dep: ${dep}`).toBe(true);
        }
      });
    });
  }
});
