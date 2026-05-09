import {
  RuntimeDispatchTaskFailed,
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
} from "@emploke/runtime";
import { describe, expect, it } from "vitest";
import { errorBody, statusForCatalogError } from "../src/routes/_shared.js";

// These tests pin the security-critical behavior of `errorBody`: only
// emploke's own typed errors leak their `.message` to the client. Any
// other error (generic Error, FS errors, third-party library errors)
// flattens to the opaque "internal error" so host paths and stack
// traces never reach the dashboard.

class FakeNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

class FakeNameInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameInvalid";
  }
}

describe("errorBody", () => {
  it("exposes message + code for known typed catalog errors", () => {
    expect(errorBody(new FakeNotFound('skill not found: "foo"'))).toEqual({
      error: 'skill not found: "foo"',
      code: "NotFound",
    });
    expect(errorBody(new FakeNameInvalid("invalid name: bad/.."))).toEqual({
      error: "invalid name: bad/..",
      code: "NameInvalid",
    });
  });

  it("flattens generic Error to 'internal error' (no leak)", () => {
    expect(errorBody(new Error("EACCES: permission denied, open '/etc/shadow'"))).toEqual({
      error: "internal error",
    });
  });

  it("flattens unknown error class to 'internal error'", () => {
    class FromSomeLib extends Error {
      constructor() {
        super("library secret message with internal path /var/lib/secret");
        this.name = "SomeLibError";
      }
    }
    expect(errorBody(new FromSomeLib())).toEqual({ error: "internal error" });
  });

  it("flattens non-Error throwables (string, object) to 'internal error'", () => {
    expect(errorBody("a string thrown by accident")).toEqual({ error: "internal error" });
    expect(errorBody({ secret: "shhh" })).toEqual({ error: "internal error" });
    expect(errorBody(null)).toEqual({ error: "internal error" });
    expect(errorBody(undefined)).toEqual({ error: "internal error" });
  });

  it("handles all session/runtime/terminal known names", () => {
    const safeNames = [
      // session
      "AgentNotFoundError",
      "InvalidSessionIdError",
      "SessionCorruptedError",
      "SessionIdAllocationFailedError",
      "SessionNotFoundError",
      "SessionsError",
      // runtime
      "InvalidMcpJson",
      "RuntimeDispatchTaskFailed",
      "RuntimeProvisionFailed",
      "RuntimeRefreshFailed",
      "RuntimeStateDeletionFailed",
      "UnknownRuntimeError",
      "TrustRegistrationFailed",
      // terminal
      "NoTerminalFoundError",
      "TerminalSpawnFailedError",
      "UnsupportedPlatformError",
      // catalog
      "CatalogError",
      "CatalogStateError",
      "CycleDetected",
      "FrontmatterError",
      "HasDependents",
      "MissingDependencies",
      "NameInvalid",
      "NotFound",
      // workspace
      "RegistryCorruptedError",
      "RegistryError",
      "WorkspaceAlreadyExistsError",
      "WorkspaceCorruptedError",
      "WorkspaceError",
      "WorkspaceIdConflictError",
      "WorkspaceIdInvalidError",
      "WorkspaceNameInvalidError",
      "WorkspaceNotFoundError",
      "WorkspaceNotRegisteredError",
      "WorkspacePathConflictError",
      "WorkspaceSchemaMismatchError",
      // server
      "WorkspaceHasLiveTasksError",
    ];
    for (const name of safeNames) {
      const err = new Error(`canonical message for ${name}`);
      err.name = name;
      expect(errorBody(err)).toEqual({
        error: `canonical message for ${name}`,
        code: name,
      });
    }
  });
});

describe("statusForCatalogError", () => {
  it.each([
    ["NameInvalid", 400],
    ["FrontmatterError", 400],
    ["MissingDependencies", 400],
    ["CycleDetected", 400],
    ["NotFound", 404],
    ["HasDependents", 409],
  ])("maps %s to %d", (name, status) => {
    const e = new Error("x");
    e.name = name;
    expect(statusForCatalogError(e)).toBe(status);
  });

  it("returns null for unknown error class names", () => {
    const e = new Error("x");
    e.name = "WeirdoError";
    expect(statusForCatalogError(e)).toBeNull();
  });

  it("returns null for non-Error values", () => {
    expect(statusForCatalogError("string")).toBeNull();
    expect(statusForCatalogError(null)).toBeNull();
    expect(statusForCatalogError(undefined)).toBeNull();
  });
});

// Pin the contract for issue #24: every Runtime*Failed `.message` (the
// piece that lands in the JSON `error` field) must contain the runtime
// kind ONLY — no on-disk paths, no caller-controlled identifiers
// (sessionId / taskDir), no underlying `cause.message` (which is
// typically a Node `fs` error like `EACCES: permission denied,
// open '/etc/...'`). The full diagnostic stays accessible via instance
// fields + `cause` for server-side `console.error` logging.
describe("RuntimeXxxFailed message sanitization (#24)", () => {
  const fsCause = Object.assign(new Error("EACCES: permission denied, open '/etc/shadow'"), {
    code: "EACCES",
  });

  const cases: Array<{ name: string; err: Error; forbidden: string[] }> = [
    {
      name: "RuntimeRefreshFailed",
      err: new RuntimeRefreshFailed("copilot", "20260509-deadbeef-cafef00d-aaaa-bbbb", fsCause),
      forbidden: [
        "20260509-deadbeef-cafef00d-aaaa-bbbb",
        "EACCES",
        "/etc/shadow",
        "permission denied",
      ],
    },
    {
      name: "RuntimeStateDeletionFailed",
      err: new RuntimeStateDeletionFailed(
        "copilot",
        "20260509-deadbeef-cafef00d-aaaa-bbbb",
        fsCause,
      ),
      forbidden: [
        "20260509-deadbeef-cafef00d-aaaa-bbbb",
        "EACCES",
        "/etc/shadow",
        "permission denied",
      ],
    },
    {
      name: "RuntimeProvisionFailed",
      err: new RuntimeProvisionFailed(
        "copilot",
        "C:\\Users\\langcheng\\.emploke\\workspaces\\foo",
        fsCause,
      ),
      forbidden: [
        "C:\\Users\\langcheng",
        ".emploke\\workspaces",
        "EACCES",
        "/etc/shadow",
        "permission denied",
      ],
    },
    {
      name: "RuntimeDispatchTaskFailed",
      err: new RuntimeDispatchTaskFailed(
        "copilot",
        "C:\\Users\\langcheng\\.emploke\\workspaces\\foo\\tasks\\20260509-cafef00d",
        fsCause,
      ),
      forbidden: [
        "C:\\Users\\langcheng",
        "20260509-cafef00d",
        "EACCES",
        "/etc/shadow",
        "permission denied",
      ],
    },
  ];

  it.each(cases)("$name body contains kind only", ({ name, err, forbidden }) => {
    const body = errorBody(err);
    expect(body.code).toBe(name);
    expect(body.error).toContain("copilot");
    for (const banned of forbidden) {
      expect(body.error).not.toContain(banned);
    }
    // Sanity: the typed instance still preserves the full diagnostic so
    // the server-side log path can recover it.
    expect(err.cause).toBe(fsCause);
  });

  it("preserves public diagnostic fields on the instance", () => {
    const r = new RuntimeRefreshFailed("copilot", "sid-123", fsCause);
    expect(r.kind).toBe("copilot");
    expect(r.sessionId).toBe("sid-123");

    const p = new RuntimeProvisionFailed("copilot", "/abs/wd", fsCause);
    expect(p.workdir).toBe("/abs/wd");

    const d = new RuntimeDispatchTaskFailed("copilot", "/abs/td", fsCause);
    expect(d.taskDir).toBe("/abs/td");
  });
});
