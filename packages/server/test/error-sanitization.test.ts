import {
  AgentFrontmatterError,
  AgentNameInvalidError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
  HasDependentsError,
  ImmutableOriginError,
  McpInvalidJsonError,
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
  OriginParseError,
  PlanStaleError,
  SkillFrontmatterError,
  SkillNameInvalidError,
  SkillNotFoundError,
  SkillOriginConflictError,
} from "@emploke/catalog";
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
//
// The `statusForCatalogError` block below MUST instantiate REAL catalog
// errors (not `new Error(); err.name = "..."`). The catalog's abstract
// base class sets `this.name = new.target.name`, so an instance carries
// `.name === "SkillNotFoundError"` not `"NotFound"`. Earlier versions
// of this suite faked the name and silently passed while production
// fell through every case to 500 — see #52 review.

describe("errorBody", () => {
  it("exposes message + code for known typed catalog errors", () => {
    const notFound = new SkillNotFoundError("public/foo");
    expect(errorBody(notFound)).toEqual({
      error: notFound.message,
      code: "SkillNotFoundError",
    });

    const nameInvalid = new SkillNameInvalidError("bad/name", "must be kebab-case");
    expect(errorBody(nameInvalid)).toEqual({
      error: nameInvalid.message,
      code: "SkillNameInvalidError",
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
      // catalog (real per-entity class names; aliases like
      // "NotFound"/"NameInvalid"/"FrontmatterError" are intentionally
      // absent — the catalog never emits instances with those names.
      // `CatalogError` itself is abstract; speculative names from
      // earlier drafts (`CatalogStateError`, `CycleDetected`,
      // `MissingDependencies`, `UnsupportedCatalogVersionError`) were
      // dropped because they don't correspond to any real class — the
      // allowlist is grep-able via `^export class \w+Error` in
      // `packages/catalog/src/**`.)
      "AgentFrontmatterError",
      "SkillFrontmatterError",
      "HasDependentsError",
      "ImmutableOriginError",
      "McpInvalidJsonError",
      "McpNameInvalidError",
      "SkillNameInvalidError",
      "AgentNameInvalidError",
      "SkillNotFoundError",
      "McpNotFoundError",
      "SkillOriginConflictError",
      "AgentOriginConflictError",
      "McpOriginConflictError",
      "OriginParseError",
      "PlanStaleError",
      "AgentPlanStaleError",
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
  // Real instances only — mapping must work against `err.name` as set by
  // the catalog's abstract base class (`this.name = new.target.name`).
  // Tests that fake `err.name` would silently pass while production fell
  // through every case to 500 — that's exactly the regression this suite
  // is here to catch.
  const cases: Array<[label: string, err: Error, status: number]> = [
    ["SkillNameInvalidError", new SkillNameInvalidError("bad", "must be kebab"), 400],
    ["AgentNameInvalidError", new AgentNameInvalidError("bad", "must be kebab"), 400],
    ["McpNameInvalidError", new McpNameInvalidError("bad", "must be kebab"), 400],
    ["SkillFrontmatterError", new SkillFrontmatterError("source", "missing version"), 400],
    ["AgentFrontmatterError", new AgentFrontmatterError("source", "missing version"), 400],
    ["McpInvalidJsonError", new McpInvalidJsonError("source", "trailing comma"), 400],
    ["OriginParseError", new OriginParseError("garbage://x", "unsupported scheme"), 400],
    ["PlanStaleError", new PlanStaleError("public/foo", "file:/x", "abc", "def"), 400],
    ["AgentPlanStaleError", new AgentPlanStaleError("public/foo", "file:/x", "abc", "def"), 400],

    ["SkillNotFoundError", new SkillNotFoundError("public/foo"), 404],
    ["AgentNotFoundError", new AgentNotFoundError("public/foo"), 404],
    ["McpNotFoundError", new McpNotFoundError("a/b"), 404],

    ["ImmutableOriginError", new ImmutableOriginError("public/foo", "github://x"), 405],

    [
      "HasDependentsError",
      new HasDependentsError("public/foo", [{ kind: "skill", name: "public/bar" }]),
      409,
    ],
    [
      "SkillOriginConflictError",
      new SkillOriginConflictError("public/foo", "file:/old", "file:/new"),
      409,
    ],
    [
      "AgentOriginConflictError",
      new AgentOriginConflictError("public/foo", "file:/old", "file:/new"),
      409,
    ],
    ["McpOriginConflictError", new McpOriginConflictError("a/b", "file:/old", "file:/new"), 409],
  ];

  it.each(cases)("maps real %s to %d", (_label, err, status) => {
    expect(statusForCatalogError(err)).toBe(status);
  });

  it("maps FetchError name to 502", () => {
    // FetchError is exported from @emploke/catalog-fetcher (via the
    // catalog re-export); we synthesize one to keep the test isolated
    // from the network.
    const e = new Error("connect ECONNREFUSED");
    e.name = "FetchError";
    expect(statusForCatalogError(e)).toBe(502);
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

  it("returns null for legacy phantom names that no real class ever produces", () => {
    // These names lived in the switch from earlier drafts but no class
    // in the catalog actually carries them at runtime. Keeping the
    // switch keyed off them risked masking the addition of a new real
    // class with one of those names without operators noticing the
    // mapping was already silently in place. Pin that they fall
    // through to null (→ 500) so a future contributor wiring up a new
    // class has to make a deliberate decision.
    for (const name of [
      "CatalogError",
      "CatalogStateError",
      "CycleDetected",
      "MissingDependencies",
      "UnsupportedCatalogVersionError",
    ]) {
      const e = new Error("x");
      e.name = name;
      expect(statusForCatalogError(e)).toBeNull();
    }
  });

  it("rejects legacy alias names (regression guard for #52 review)", () => {
    // Pre-#52 the switch keyed off these aliases. Real instances never
    // matched. Pin that we do NOT accept them so nobody silently brings
    // the bug back.
    for (const alias of [
      "NotFound",
      "NameInvalid",
      "FrontmatterError",
      "OriginConflictError",
      "InvalidMcpJsonError",
      "HasDependents",
    ]) {
      const e = new Error("x");
      e.name = alias;
      expect(statusForCatalogError(e)).toBeNull();
    }
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
