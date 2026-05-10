import { describe, expect, it } from "vitest";
import { SkillFrontmatterError, SkillNameInvalidError } from "../../src/skill/errors.js";
import * as SkillFormat from "../../src/skill/skill-frontmatter.js";

const LABEL = "test";

const MIN_VALID = `---
name: tool-use
description: Helpful patterns
version: 1.0.0
---
# Body
`;

describe("SkillFormat.parse — happy path", () => {
  it("parses minimum-valid frontmatter with default scope", () => {
    const { meta, body } = SkillFormat.parse(MIN_VALID, LABEL);
    expect(meta.scope).toBe("public");
    expect(meta.description).toBe("Helpful patterns");
    expect(meta.version).toBe("1.0.0");
    expect(body).toBe("# Body\n");
  });

  it("respects explicit scope", () => {
    const src = MIN_VALID.replace("name: tool-use", "name: tool-use\nscope: io.example");
    const { meta } = SkillFormat.parse(src, LABEL);
    expect(meta.scope).toBe("io.example");
  });

  it("parses prereqs", () => {
    const src = MIN_VALID.replace(
      "version: 1.0.0",
      "version: 1.0.0\nprereqs: 'Run setup.sh first'",
    );
    const { meta } = SkillFormat.parse(src, LABEL);
    expect(meta.prereqs).toBe("Run setup.sh first");
  });

  it("parses skill + mcp deps as origin strings", () => {
    const src = `---
name: parent
description: x
version: 1.0.0
dependencies:
  skills:
    - "github:o/r/tree/main/skills/web-search"
    - "file:/abs/tools"
  mcps:
    - "file:/abs/mcps/azure"
---
`;
    const { meta } = SkillFormat.parse(src, LABEL);
    expect(meta.dependencies?.skills).toEqual([
      "github:o/r/tree/main/skills/web-search",
      "file:/abs/tools",
    ]);
    expect(meta.dependencies?.mcps).toEqual(["file:/abs/mcps/azure"]);
  });

  it("accepts deps in object form { origin: string } as legacy compat", () => {
    const src = `---
name: parent
description: x
version: 1.0.0
dependencies:
  skills:
    - { origin: "file:/abs/web-search" }
---
`;
    const { meta } = SkillFormat.parse(src, LABEL);
    expect(meta.dependencies?.skills).toEqual(["file:/abs/web-search"]);
  });

  it("body preserved verbatim including blank lines", () => {
    const src = `${MIN_VALID}\nMore body\n\n  with whitespace`;
    const { body } = SkillFormat.parse(src, LABEL);
    expect(body).toBe("# Body\n\nMore body\n\n  with whitespace");
  });
});

describe("SkillFormat.parse — schema errors", () => {
  it("throws when frontmatter block is missing", () => {
    expect(() => SkillFormat.parse("# just a body, no frontmatter", LABEL)).toThrow(
      SkillFrontmatterError,
    );
  });

  it("throws on malformed YAML", () => {
    const src = `---
name: tool-use
description: "unclosed string
version: 1.0.0
---
`;
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillFrontmatterError);
  });

  it("throws on missing name", () => {
    const src = `---
description: x
version: 1.0.0
---
`;
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillFrontmatterError);
  });

  it("throws on missing description", () => {
    const src = `---
name: tool-use
version: 1.0.0
---
`;
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillFrontmatterError);
  });

  it("throws on missing version", () => {
    const src = `---
name: tool-use
description: x
---
`;
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillFrontmatterError);
  });

  it("rejects invalid short name (with slash)", () => {
    const src = MIN_VALID.replace("name: tool-use", "name: scope/name");
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillNameInvalidError);
  });

  it("rejects non-kebab short name", () => {
    const src = MIN_VALID.replace("name: tool-use", "name: ToolUse");
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillNameInvalidError);
  });

  it("rejects invalid scope", () => {
    const src = MIN_VALID.replace("name: tool-use", "name: tool-use\nscope: 'Bad Scope!'");
    expect(() => SkillFormat.parse(src, LABEL)).toThrow();
  });

  it("rejects deps with missing origin", () => {
    const src = `---
name: x
description: x
version: 1.0.0
dependencies:
  skills:
    - { name: y }
---
`;
    expect(() => SkillFormat.parse(src, LABEL)).toThrow(SkillFrontmatterError);
  });

  it("accepts dep refs that are bare strings (the new canonical form)", () => {
    const src = `---
name: x
description: x
version: 1.0.0
dependencies:
  skills:
    - "file:/abs/y"
---
`;
    const { meta } = SkillFormat.parse(src, LABEL);
    expect(meta.dependencies?.skills).toEqual(["file:/abs/y"]);
  });
});

describe("SkillFormat.writeFrontmatter", () => {
  it("round-trips meta + body", () => {
    const { meta, body } = SkillFormat.parse(MIN_VALID, LABEL);
    const out = SkillFormat.writeFrontmatter(MIN_VALID, meta, LABEL);
    const reparsed = SkillFormat.parse(out, LABEL);
    expect(reparsed.meta).toEqual(meta);
    expect(reparsed.body).toBe(body);
  });

  it("preserves body bytes verbatim when overwriting frontmatter", () => {
    const original = `---
name: a
description: x
version: 1.0.0
---
# Heading

Some content.
- a
- b
`;
    const newMeta = {
      shortName: "a",
      scope: "public",
      description: "y",
      version: "2.0.0",
    };
    const out = SkillFormat.writeFrontmatter(original, newMeta, LABEL);
    const { body } = SkillFormat.parse(out, LABEL);
    expect(body).toBe("# Heading\n\nSome content.\n- a\n- b\n");
  });

  it("creates frontmatter when input has none (returns same body, prepends frontmatter)", () => {
    const out = SkillFormat.writeFrontmatter(
      "# Body only\n",
      { shortName: "x", scope: "public", description: "x", version: "1.0.0" },
      LABEL,
    );
    expect(out).toContain("---");
    expect(out).toContain("# Body only");
    const { meta } = SkillFormat.parse(out, LABEL);
  });
});
