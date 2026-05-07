import { describe, expect, it } from "vitest";
import { NameInvalid } from "../src/errors.js";
import { validateName } from "../src/validate.js";

describe("validateName (kebab-case)", () => {
  it.each([
    "a",
    "abc",
    "git-pr",
    "squad-lint",
    "a1b2",
    "foo-bar-baz",
    "x-2-y",
  ])("accepts %s", (name) => {
    expect(() => validateName(name)).not.toThrow();
  });

  it.each([
    "",
    "Foo",
    "foo_bar",
    "foo bar",
    "-foo",
    "foo-",
    "foo--bar",
    "1foo",
    "FOO",
  ])("rejects %j", (name) => {
    expect(() => validateName(name)).toThrow(NameInvalid);
  });

  it("rejects non-string", () => {
    // @ts-expect-error: deliberately passing wrong type
    expect(() => validateName(123)).toThrow(NameInvalid);
    // @ts-expect-error: deliberately passing wrong type
    expect(() => validateName(undefined)).toThrow(NameInvalid);
  });
});

import { validateMcpName } from "../src/validate.js";

describe("validateMcpName (scoped)", () => {
  it.each([
    "github",
    "io.playwright/mcp",
    "com.example.team/my-server",
    "langsensei/weather",
  ])("accepts %j", (name) => {
    expect(() => validateMcpName(name)).not.toThrow();
  });

  it.each(["io.playwright/mcp/extra", ".bad/name", "scope/Bad"])("rejects %j", (name) => {
    expect(() => validateMcpName(name)).toThrow(NameInvalid);
  });
});

describe("validateName (dots in scope)", () => {
  it.each(["io.playwright/browser", "com.example/tool"])("accepts %j", (name) => {
    expect(() => validateName(name)).not.toThrow();
  });

  it("rejects dots in name segment", () => {
    expect(() => validateName("scope/na.me")).toThrow(NameInvalid);
  });
});
