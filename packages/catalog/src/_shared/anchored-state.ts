import {
  type DepSpec,
  emptyDeps,
  emptyOriginDeps,
  type FqnDeps,
  normaliseFqnDeps,
  type OriginDeps,
} from "./dep-keys.js";
import { initialPrereqsAck, nowIso, requireNonEmptyOrigin } from "./entity-helpers.js";
import {
  type AnchoredFrontmatter,
  type FrontmatterCodec,
  metaDepsToOriginDeps,
} from "./frontmatter-codec.js";
import type { AnchoredValidators } from "./validate-shared.js";

/**
 * State builders for anchored markdown entities. Each per-kind concrete
 * class composes these and stores the returned `AnchoredEntityState<K>`
 * in a private field; the class methods are then ~one-line getters or
 * one-line `applyAnchorPatch(...)` calls. No inheritance.
 *
 * Generic over the per-kind dep-key union `K` — agent passes
 * `"skills" | "mcps"`, skill passes the same, a future kind passes
 * its own.
 */

export interface AnchoredStateBuilderConfig<K extends string> {
  /** Class-method label used in diagnostics (e.g. `"AgentEntity"`). */
  readonly label: string;
  /** The dep-spec set this kind recognises. */
  readonly depSpecs: readonly DepSpec<K>[];
  readonly codec: FrontmatterCodec<K>;
  readonly validators: Pick<AnchoredValidators, "makeFqn" | "splitFqn" | "validateFqn">;
}

/** The state common to every anchored entity, generic over dep keys. */
export interface AnchoredEntityState<K extends string> {
  readonly fqn: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs: string | undefined;
  readonly dependencies: FqnDeps<K>;
  readonly depsRefs: OriginDeps<K>;
  readonly prereqsAck: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

const SCOPED_LABEL = (label: string, method: string) => `${label}.${method}`;

/** Build the initial state from raw anchor bytes. Used by `Entity.create`. */
export function buildInitialAnchoredState<K extends string>(
  raw: string,
  origin: string,
  sourceLabel: string,
  cfg: AnchoredStateBuilderConfig<K>,
): AnchoredEntityState<K> {
  requireNonEmptyOrigin(origin, SCOPED_LABEL(cfg.label, "create"));
  const { meta } = cfg.codec.parse(raw, sourceLabel);
  const fqn = cfg.validators.makeFqn(meta.scope, meta.shortName);
  const now = nowIso();
  return {
    fqn,
    origin,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    dependencies: emptyDeps(cfg.depSpecs),
    depsRefs: metaDepsToOriginDeps(cfg.depSpecs, meta),
    prereqsAck: initialPrereqsAck(meta.prereqs),
    installedAt: now,
    updatedAt: now,
  };
}

/**
 * Build state from a stored row. `depsRefs` defaults to empty (origins
 * aren't persisted past install — only the resolved fqns are).
 */
export function buildStoredAnchoredState<K extends string>(
  args: {
    readonly fqn: string;
    readonly origin: string;
    readonly description: string;
    readonly version: string;
    readonly prereqs: string | undefined;
    readonly dependencies: FqnDeps<K>;
    readonly prereqsAck: boolean;
    readonly installedAt: string;
    readonly updatedAt: string;
    readonly depsRefs?: OriginDeps<K>;
  },
  cfg: AnchoredStateBuilderConfig<K>,
): AnchoredEntityState<K> {
  cfg.validators.validateFqn(args.fqn);
  return {
    fqn: args.fqn,
    origin: args.origin,
    description: args.description,
    version: args.version,
    prereqs: args.prereqs,
    dependencies: normaliseFqnDeps(cfg.depSpecs, args.dependencies),
    depsRefs: args.depsRefs ?? emptyOriginDeps(cfg.depSpecs),
    prereqsAck: args.prereqsAck,
    installedAt: args.installedAt,
    updatedAt: args.updatedAt,
  };
}

/**
 * Apply a new anchor's bytes to existing state. Identity (`fqn`) MUST
 * NOT change — throws `TypeError` otherwise (caller must delete and
 * reinstall to rename). Body bytes are NOT held on the state; the
 * repository's `getAnchor(fqn)` is the canonical fetch path.
 */
export function applyAnchorPatch<K extends string>(
  state: AnchoredEntityState<K>,
  raw: string,
  sourceLabel: string,
  cfg: AnchoredStateBuilderConfig<K>,
): AnchoredEntityState<K> {
  const { meta } = cfg.codec.parse(raw, sourceLabel);
  const newFqn = cfg.validators.makeFqn(meta.scope, meta.shortName);
  if (newFqn !== state.fqn) {
    throw new TypeError(
      `${SCOPED_LABEL(cfg.label, "withAnchor")} cannot change identity: ` +
        `existing "${state.fqn}" vs new "${newFqn}". ` +
        "Delete and reinstall to rename.",
    );
  }
  return {
    ...state,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    depsRefs: metaDepsToOriginDeps(cfg.depSpecs, meta),
    updatedAt: nowIso(),
  };
}

/** Re-export the codec metadata helper signature so consumers don't import twice. */
export type { AnchoredFrontmatter };
