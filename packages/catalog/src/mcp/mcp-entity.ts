import type { AggregateRoot } from "../domain/seedwork/aggregate-root.js";
import { Entity } from "../domain/seedwork/entity.js";
import { McpName } from "../domain/value-objects/mcp-name.js";
import * as McpFormat from "./mcp-format.js";

/**
 * Rich domain entity representing a single installed MCP.
 *
 * Identity = `fqn` (the MCP-spec name); `origin` is provenance, not
 * identity. Schema v2 (issue #122): the storage column was renamed
 * `name` → `fqn` and `content` → `spec` for catalog-wide terminology
 * consistency. The MCP spec's `_meta.name` wire field is unaffected
 * — only the storage/API surface uses `fqn`.
 *
 *   - `fqn` is the MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`).
 *     MCP spec names ARE globally unique-by-convention; emploke does not
 *     add a separate `scope:` segment for them. Renames are modelled as
 *     delete + reinstall, never as identity mutation.
 *   - `spec` carries the raw JSON spec bytes (renamed from `content`).
 *   - `installedAt` / `updatedAt` ISO 8601 UTC timestamps surface here so
 *     DTO projections can include them.
 *
 * ## Aggregate root + seedwork integration
 *
 * `Mcp` extends `Entity` (catalog seedwork) and implements
 * `AggregateRoot` so the type system answers "may this type have a
 * repository?" with a yes. {@link McpName} is the single
 * construction-time invariant gate for the `fqn`: every factory call
 * routes identity through `McpName.parse(...)` before the entity sees
 * it. The internal storage stays a string for minimal churn and
 * unchanged repo wire-compat; PR-2+ will lift the VO to be the
 * entity's stored identity once repos and mappers are ready to
 * round-trip it.
 *
 * `origin` is intentionally NOT yet wrapped in the {@link Origin} VO:
 * `Origin.parse` would tighten install-time validation by routing
 * through `parseOrigin` (which rejects unsupported schemes), but
 * existing tests and call sites pass synthetic origin strings that
 * pre-date the parseOrigin grammar. Tightening validation here would
 * be a silent behaviour change disguised as a "foundation" PR; the
 * deliberate tightening lives in PR-2+ alongside the install workflow
 * redesign.
 *
 * Domain events are NOT raised from this aggregate yet: the existing
 * copy-returning transition methods (`withContent`) would drop a
 * non-empty `_domainEvents` buffer onto the floor. PR-2+ will redesign
 * the transition style before any handler is allowed to add events.
 */
export class Mcp extends Entity implements AggregateRoot {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _spec: string,
    private readonly _installedAt: string,
    private readonly _updatedAt: string,
  ) {
    super();
  }

  static create(name: string, origin: string, rawContent: string): Mcp {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Mcp.create requires a non-empty origin string");
    }
    const canonicalName = McpName.parse(name).toCanonical();
    const sourceLabel = `mcps:${canonicalName}`;
    const merged = McpFormat.writeMeta(rawContent, { name: canonicalName }, sourceLabel);
    McpFormat.parse(merged, sourceLabel);
    const now = new Date().toISOString();
    return new Mcp(canonicalName, origin, merged, now, now);
  }

  static fromStored(
    fqn: string,
    origin: string,
    spec: string,
    installedAt: string,
    updatedAt: string,
  ): Mcp {
    return new Mcp(McpName.parse(fqn).toCanonical(), origin, spec, installedAt, updatedAt);
  }

  /** Inherited `Entity.id` → canonical FQN string. */
  override get id(): string {
    return this._fqn;
  }
  override set id(_value: string) {
    throw new TypeError("Mcp.id is derived from McpName and is immutable");
  }
  get fqn(): string {
    return this._fqn;
  }
  get origin(): string {
    return this._origin;
  }
  get spec(): string {
    return this._spec;
  }
  get installedAt(): string {
    return this._installedAt;
  }
  get updatedAt(): string {
    return this._updatedAt;
  }

  /** Plain JSON projection. */
  toJSON(): Record<string, unknown> {
    return {
      fqn: this._fqn,
      origin: this._origin,
      installedAt: this._installedAt,
      updatedAt: this._updatedAt,
    };
  }

  /**
   * Return a new entity with replaced spec bytes; identity preserved,
   * `updatedAt` bumped. Callers cannot change identity via this method.
   */
  withContent(rawContent: string): Mcp {
    const sourceLabel = `mcps:${this._fqn}`;
    const merged = McpFormat.writeMeta(rawContent, { name: this._fqn }, sourceLabel);
    McpFormat.parse(merged, sourceLabel);
    return new Mcp(this._fqn, this._origin, merged, this._installedAt, new Date().toISOString());
  }
}
