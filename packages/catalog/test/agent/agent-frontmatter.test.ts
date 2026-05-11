import { describe, expect, it } from "vitest";
import * as AgentFormat from "../../src/agent/agent-frontmatter.js";
import { AgentFrontmatterError, AgentNameInvalidError } from "../../src/agent/errors.js";

const LABEL = "test";

const MIN_VALID = `---
name: researcher
description: Helpful researcher
version: 1.0.0
---
# Body
`;

describe("AgentFormat.parse — happy path", () => {
  it("parses minimum-valid frontmatter with default scope", () => {
    const { meta, body } = AgentFormat.parse(MIN_VALID, LABEL);
    expect(meta.scope).toBe("public");
    expect(meta.description).toBe("Helpful researcher");
    expect(meta.version).toBe("1.0.0");
    expect(body).toBe("# Body\n");
  });

  it("respects explicit scope", () => {
    const src = MIN_VALID.replace("name: researcher", "name: researcher\nscope: io.example");
    const { meta } = AgentFormat.parse(src, LABEL);
    expect(meta.scope).toBe("io.example");
  });

  it("parses skill + mcp deps", () => {
    const src = `---
name: parent
description: x
version: 1.0.0
dependencies:
  skills:
    - "github:o/r/tree/main/skills/web-search"
  mcps:
    - "file:/abs/mcps/azure"
---
`;
    const { meta } = AgentFormat.parse(src, LABEL);
    expect(meta.dependencies?.skills).toEqual(["github:o/r/tree/main/skills/web-search"]);
    expect(meta.dependencies?.mcps).toEqual(["file:/abs/mcps/azure"]);
  });
});

describe("AgentFormat.parse — agent-specific schema", () => {
  it("rejects `prereqs` field (skill-only)", () => {
    const src = `---
name: researcher
description: x
version: 1.0.0
prereqs: 'do something'
---
`;
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(AgentFrontmatterError);
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(/prereqs/);
  });

  it("rejects invalid name", () => {
    const src = MIN_VALID.replace("name: researcher", "name: BadName");
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(AgentNameInvalidError);
  });

  it("throws when frontmatter block is missing", () => {
    expect(() => AgentFormat.parse("# body only", LABEL)).toThrow(AgentFrontmatterError);
  });
});

describe("AgentFormat.writeFrontmatter", () => {
  it("round-trips meta + body", () => {
    const { meta, body } = AgentFormat.parse(MIN_VALID, LABEL);
    const out = AgentFormat.writeFrontmatter(MIN_VALID, meta, LABEL);
    const reparsed = AgentFormat.parse(out, LABEL);
    expect(reparsed.meta).toEqual(meta);
    expect(reparsed.body).toBe(body);
  });
});
