/**
 * Compile-time public API guard for `@emploke/catalog`. The catalog
 * package is a hard contract for `server`, `runtime`, `core`,
 * `session`, `task`, `schedule`, and `dashboard` (indirectly via HTTP).
 * This file asserts the public surface in a form the type-checker
 * verifies — any silent rename, dropped export, or DTO-field drift in
 * `_shared/` or per-kind shadows trips `pnpm --filter @emploke/catalog
 * typecheck`.
 *
 * The runtime side is verified by `describe(...) { it(...) {...} }`
 * blocks below: smoke-instantiating each concrete error class with
 * its canonical signature; making sure constructors don't drift.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  type Agent,
  type AgentEntry,
  AgentFrontmatterError,
  type AgentMetadataPatch,
  AgentNameInvalidError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
  type AgentResolveResult,
  type CatalogKind,
  type CatalogPlanNode,
  type CatalogService,
  CyclicDependencyError,
  DEFAULT_SCOPE,
  type DependencyKind,
  type DependencyRef,
  type EntryStatus,
  HasDependentsError,
  type Mcp,
  McpInvalidJsonError,
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
  makeFqn,
  PlanStaleError,
  type Skill,
  type SkillEntry,
  SkillFrontmatterError,
  type SkillMetadataPatch,
  SkillNameInvalidError,
  SkillNotFoundError,
  SkillOriginConflictError,
  type SkillResolveResult,
  splitFqn,
  validateFqn,
  validateScope,
  validateShortName,
} from "../src/index.js";

describe("@emploke/catalog public API guard", () => {
  it("exports the 15 concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new AgentFrontmatterError("src", "reason"),
      new AgentFrontmatterError("src", "reason", { cause: new Error("upstream") }),
      new AgentNameInvalidError("name", "reason"),
      new AgentNotFoundError("name"),
      new AgentOriginConflictError("name", "existing", "attempted"),
      new AgentPlanStaleError("name", "origin", "1.0.0", "1.0.1"),
      new SkillFrontmatterError("src", "reason"),
      new SkillFrontmatterError("src", "reason", { cause: new Error("upstream") }),
      new SkillNameInvalidError("name", "reason"),
      new SkillNotFoundError("name"),
      new SkillOriginConflictError("name", "existing", "attempted"),
      new PlanStaleError("name", "origin", "1.0.0", "1.0.1"),
      new CyclicDependencyError(["a", "b", "a"]),
      new McpInvalidJsonError("src", "reason"),
      new McpInvalidJsonError("src", "reason", { cause: new Error("upstream") }),
      new McpNameInvalidError("name", "reason"),
      new McpNotFoundError("name"),
      new McpOriginConflictError("name", "existing", "attempted"),
      new HasDependentsError("target", []),
    ];
    expectTypeOf(errs[0]).toExtend<Error>();
  });

  it("preserves the kind-indexed DTO shapes (Skill / Agent / Mcp)", () => {
    // Skill DTO MUST NOT have disabledByUser (only agents can be user-disabled).
    expectTypeOf<Skill>().not.toHaveProperty("disabledByUser");
    // Agent DTO MUST have disabledByUser as a required boolean.
    expectTypeOf<Agent>().toHaveProperty("disabledByUser");
    // Mcp DTO MUST NOT have prereqs / dependencies / description.
    expectTypeOf<Mcp>().not.toHaveProperty("prereqs");
    expectTypeOf<Mcp>().not.toHaveProperty("dependencies");
    expectTypeOf<Mcp>().not.toHaveProperty("description");
    // Skill / Agent MUST have orphaned semantics:
    expectTypeOf<Skill>().toHaveProperty("orphaned");
    expectTypeOf<Agent>().not.toHaveProperty("orphaned");
    expectTypeOf<Mcp>().toHaveProperty("orphaned");
  });

  it("narrows CatalogPlanNode by kind", () => {
    const fn = (node: CatalogPlanNode): string => {
      if (node.kind === "skill") return node.node.fqn;
      if (node.kind === "agent") return node.node.fqn;
      return node.node.fqn;
    };
    expectTypeOf(fn).toBeFunction();
  });

  it("preserves the FQN helpers + DEFAULT_SCOPE", () => {
    expectTypeOf(DEFAULT_SCOPE).toBeString();
    expectTypeOf(makeFqn).parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf(makeFqn).returns.toBeString();
    expectTypeOf(splitFqn).returns.toEqualTypeOf<{ scope: string; shortName: string }>();
    // Assertion signature preserved (asserts the named param is string).
    const v: unknown = "public/test";
    validateFqn(v);
    expectTypeOf(v).toBeString();
    const s: unknown = "scope";
    validateScope(s);
    expectTypeOf(s).toBeString();
    const n: unknown = "name";
    validateShortName(n);
    expectTypeOf(n).toBeString();
  });

  it("preserves the cross-cutting type aliases (CatalogKind / EntryStatus / DependencyKind / DependencyRef)", () => {
    const k: CatalogKind = "skill";
    expectTypeOf<CatalogKind>().toEqualTypeOf<"skill" | "agent" | "mcp">();
    expectTypeOf<EntryStatus>().toEqualTypeOf<"ready" | "blocked">();
    expectTypeOf<DependencyKind>().toEqualTypeOf<"skill" | "mcp">();
    expectTypeOf<DependencyRef>().toHaveProperty("fqn");
    void k;
  });

  it("preserves the metadata-patch + entry + resolve-result shapes", () => {
    expectTypeOf<SkillMetadataPatch>().toHaveProperty("description");
    expectTypeOf<AgentMetadataPatch>().toHaveProperty("description");
    expectTypeOf<SkillEntry>().toHaveProperty("skill");
    expectTypeOf<AgentEntry>().toHaveProperty("agent");
    expectTypeOf<SkillResolveResult>().toHaveProperty("skill");
    expectTypeOf<AgentResolveResult>().toHaveProperty("agent");
  });

  it("preserves the CatalogService class and its per-kind dispatcher names", () => {
    // Method-name preservation: the per-kind dispatchers MUST stay as
    // public methods on CatalogService — server / runtime / core /
    // session / task / schedule / dashboard call these by name.
    expectTypeOf<CatalogService>().toHaveProperty("installSkill");
    expectTypeOf<CatalogService>().toHaveProperty("installAgent");
    expectTypeOf<CatalogService>().toHaveProperty("installMcpFromOrigin");
    expectTypeOf<CatalogService>().toHaveProperty("resolveSkill");
    expectTypeOf<CatalogService>().toHaveProperty("resolveAgentFromOrigin");
    expectTypeOf<CatalogService>().toHaveProperty("resolveMcp");
    expectTypeOf<CatalogService>().toHaveProperty("resolveSyncSkill");
    expectTypeOf<CatalogService>().toHaveProperty("resolveSyncAgent");
    expectTypeOf<CatalogService>().toHaveProperty("resolveSyncMcp");
    expectTypeOf<CatalogService>().toHaveProperty("deleteSkill");
    expectTypeOf<CatalogService>().toHaveProperty("deleteAgent");
    expectTypeOf<CatalogService>().toHaveProperty("deleteMcp");
    expectTypeOf<CatalogService>().toHaveProperty("getSkill");
    expectTypeOf<CatalogService>().toHaveProperty("getAgent");
    expectTypeOf<CatalogService>().toHaveProperty("getMcp");
    expectTypeOf<CatalogService>().toHaveProperty("getSkillContent");
    expectTypeOf<CatalogService>().toHaveProperty("getAgentContent");
    expectTypeOf<CatalogService>().toHaveProperty("getMcpContent");
    expectTypeOf<CatalogService>().toHaveProperty("updateSkillContent");
    expectTypeOf<CatalogService>().toHaveProperty("updateAgentContent");
    expectTypeOf<CatalogService>().toHaveProperty("updateMcpContent");
    expectTypeOf<CatalogService>().toHaveProperty("updateSkillMetadata");
    expectTypeOf<CatalogService>().toHaveProperty("updateAgentMetadata");
    expectTypeOf<CatalogService>().toHaveProperty("resolveAgent");
    expectTypeOf<CatalogService>().toHaveProperty("resolveSkillFromCatalog");
    // New polymorphic methods (also public — direct callers may use either).
    expectTypeOf<CatalogService>().toHaveProperty("installEntry");
    expectTypeOf<CatalogService>().toHaveProperty("resolveEntry");
    expectTypeOf<CatalogService>().toHaveProperty("resolveEntrySync");
    expectTypeOf<CatalogService>().toHaveProperty("deleteEntry");
    expectTypeOf<CatalogService>().toHaveProperty("getEntry");
    expectTypeOf<CatalogService>().toHaveProperty("getEntryContent");
    expectTypeOf<CatalogService>().toHaveProperty("updateEntryContent");
    expectTypeOf<CatalogService>().toHaveProperty("updateEntryMetadata");
  });
});
