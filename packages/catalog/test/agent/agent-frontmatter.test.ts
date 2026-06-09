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
  it("accepts `prereqs` field", () => {
    const src = `---
name: researcher
description: x
version: 1.0.0
prereqs: 'do something'
---
`;
    const { meta } = AgentFormat.parse(src, LABEL);
    expect(meta.prereqs).toBe("do something");
  });

  it("rejects non-string `prereqs`", () => {
    const src = `---
name: researcher
description: x
version: 1.0.0
prereqs: 42
---
`;
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(AgentFrontmatterError);
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(/prereqs/);
  });

  it("rejects invalid name", () => {
    const src = MIN_VALID.replace("name: researcher", "name: BadName");
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(AgentNameInvalidError);
  });

  it("parses agent dep (round-trip)", () => {
    const src = `---
name: orchestrator
description: x
version: 1.0.0
dependencies:
  agents:
    - "github:o/r/tree/main/agents/researcher"
    - "file:/abs/agents/writer"
---
`;
    const { meta } = AgentFormat.parse(src, LABEL);
    expect(meta.dependencies?.agents).toEqual([
      "github:o/r/tree/main/agents/researcher",
      "file:/abs/agents/writer",
    ]);
  });

  it("parses skills + mcps + agents together", () => {
    const src = `---
name: mixed
description: x
version: 1.0.0
dependencies:
  skills:
    - "github:o/r/tree/main/skills/web-search"
  mcps:
    - "file:/abs/mcps/azure"
  agents:
    - "github:o/r/tree/main/agents/researcher"
---
`;
    const { meta } = AgentFormat.parse(src, LABEL);
    expect(meta.dependencies?.skills).toEqual(["github:o/r/tree/main/skills/web-search"]);
    expect(meta.dependencies?.mcps).toEqual(["file:/abs/mcps/azure"]);
    expect(meta.dependencies?.agents).toEqual(["github:o/r/tree/main/agents/researcher"]);
  });

  it("rejects unknown dep key with accepted-set in message", () => {
    const src = `---
name: orchestrator
description: x
version: 1.0.0
dependencies:
  plugins:
    - "github:o/r/tree/main/plugins/foo"
---
`;
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(AgentFrontmatterError);
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(/dependencies\.plugins/);
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(/skills.*mcps.*agents/);
  });

  it("rejects non-string item in agents bucket", () => {
    const src = `---
name: orchestrator
description: x
version: 1.0.0
dependencies:
  agents:
    - { origin: "github:o/r/tree/main/agents/researcher" }
---
`;
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(AgentFrontmatterError);
    expect(() => AgentFormat.parse(src, LABEL)).toThrow(/dependencies\.agents\[0\]/);
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
