import { describe, expect, it } from "vitest";
import { NameInvalid } from "../src/errors.js";
import { validateFqn, validateScope, validateShortName } from "../src/validate.js";

describe("validateShortName (kebab-case, no slash)", () => {
  it.each([
    "a",
    "abc",
    "git-pr",
    "squad-lint",
    "a1b2",
    "foo-bar-baz",
    "x-2-y",
  ])("accepts %s", (name) => {
    expect(() => validateShortName(name)).not.toThrow();
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
    "scope/name", // short names must NOT contain slashes (#39)
    "io.playwright/mcp",
  ])("rejects %j", (name) => {
    expect(() => validateShortName(name)).toThrow(NameInvalid);
  });

  it("rejects non-string", () => {
    // @ts-expect-error: deliberately passing wrong type
    expect(() => validateShortName(123)).toThrow(NameInvalid);
    // @ts-expect-error: deliberately passing wrong type
    expect(() => validateShortName(undefined)).toThrow(NameInvalid);
  });
});

describe("validateScope (kebab-case, dots OK for reverse-DNS)", () => {
  it.each(["local", "anthropic", "io.playwright", "com.example.team"])("accepts %j", (s) => {
    expect(() => validateScope(s)).not.toThrow();
  });

  it.each(["", "Foo", "scope/name", "-bad", ".bad"])("rejects %j", (s) => {
    expect(() => validateScope(s)).toThrow(NameInvalid);
  });
});

describe("validateFqn (must be `<scope>/<name>`)", () => {
  it.each([
    "local/foo",
    "io.playwright/mcp",
    "com.example.team/my-server",
    "langsensei/weather",
  ])("accepts %j", (fqn) => {
    expect(() => validateFqn(fqn)).not.toThrow();
  });

  it.each([
    "foo", // bare short name
    "io.playwright/mcp/extra", // multiple slashes
    ".bad/name",
    "scope/Bad",
    "/leading-slash",
    "trailing/", // empty short name segment
    "",
  ])("rejects %j", (fqn) => {
    expect(() => validateFqn(fqn)).toThrow(NameInvalid);
  });
});
