import { type ReactNode, useEffect, useState } from "react";
import {
  type AgentDetail,
  acknowledgeAgentPrereqs,
  acknowledgeSkillPrereqs,
  applyAgentSync,
  applyMcpSync,
  applySkillSync,
  disableAgent,
  enableAgent,
  getAgent,
  getMcp,
  getSkill,
  type McpDetail,
  type ResolveManifest,
  resolveAgentSync,
  resolveMcpSync,
  resolveSkillSync,
  type SkillDetail,
} from "../api";
import { type EntityKind, KIND_ICON, KIND_TAG, KIND_TITLE } from "../kindMeta";
import { splitFqnForDisplay } from "../utils/fqn";
import { Modal } from "./Modal";
import { ResolveTree } from "./ResolveTree";

/**
 * Read-only detail view for an installed catalog entry.
 *
 * Shown instead of `EditDialog` when the entry's origin is immutable
 * (currently any non-`file:` scheme — see {@link isOriginMutable} in
 * `@emploke/catalog`). Mutable entries still get the full edit form.
 *
 * Layout:
 *  - Hero header: kind icon tag + KIND label + big fqn (mono) +
 *    status pill, with namespace breadcrumb on a second line. Close
 *    button on the right.
 *  - Tab nav: Overview / Source. Sync, Acknowledge, and Disable/Enable
 *    actions live in the Overview tab as a contextual action strip
 *    above the metadata; the source file gets its own dedicated tab.
 *  - Overview tab: optional action strip + definition-list metadata
 *    (description, origin, version, status, deps, prereqs).
 *  - Source tab: full anchor file contents (SKILL.md / AGENTS.md /
 *    mcp.json), no collapse.
 *  - Footer: Sync from upstream (left, ghost) — primary CTA slot on
 *    the right is reserved for the most-actionable lifecycle button:
 *    Acknowledge prereqs (when needed) or Disable/Enable agent. While
 *    the user is in the sync resolve flow, the footer switches to the
 *    standard Back / Apply triad.
 *
 * Pure read view: NO disabled inputs, NO toggle between form/source
 * modes, NO Save button. Ergonomics for "I want to inspect what's
 * installed and decide whether to sync" diverge enough from
 * "I want to edit my own entry" that a separate dialog reduces noise.
 */
export interface DetailDialogProps {
  target: { kind: EntityKind; name: string };
  onClose: () => void;
  /** Called after a successful Sync / Acknowledge / Enable / Disable; parent re-fetches catalog list. */
  onSynced: () => void;
}

interface LoadedDetail {
  origin: string;
  description?: string;
  version?: string;
  prereqs?: string;
  /** Status from the catalog — drives which CTA buttons show. */
  status: "ready" | "blocked";
  /** Reason fields when status is "blocked"; undefined when ready. */
  blockedReason?: import("@emploke/catalog").BlockedReason;
  prereqsAck: boolean;
  /** Agents only; undefined for skills/mcps. */
  disabledByUser?: boolean;
  /** Skills/mcps only. */
  orphaned?: boolean;
  deps: { skills: string[]; mcps: string[] };
  /** Raw anchor content (SKILL.md / AGENTS.md / mcp.json bytes). */
  source: string;
  /** True if `target.kind === "mcp"` so the source is rendered as JSON. */
  sourceLanguage: "markdown" | "json";
}

type DetailTab = "overview" | "source";

export function DetailDialog({ target, onClose, onSynced }: DetailDialogProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LoadedDetail | null>(null);
  const [syncManifest, setSyncManifest] = useState<ResolveManifest | null>(null);
  const [syncStage, setSyncStage] = useState<"idle" | "previewing" | "preview" | "applying">(
    "idle",
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setActiveTab("overview");
    const load = async (): Promise<void> => {
      if (target.kind === "mcp") {
        const d = await getMcp(target.name);
        if (cancelled) return;
        setDetail(projectMcp(d));
      } else if (target.kind === "skill") {
        const d = await getSkill(target.name);
        if (cancelled) return;
        setDetail(projectSkill(d));
      } else {
        const d = await getAgent(target.name);
        if (cancelled) return;
        setDetail(projectAgent(d));
      }
    };
    load()
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const handlePreviewSync = async (): Promise<void> => {
    setSyncStage("previewing");
    setError(null);
    try {
      const manifest =
        target.kind === "skill"
          ? await resolveSkillSync(target.name)
          : target.kind === "agent"
            ? await resolveAgentSync(target.name)
            : await resolveMcpSync(target.name);
      setSyncManifest(manifest);
      setSyncStage("preview");
    } catch (e) {
      setError((e as Error).message);
      setSyncStage("idle");
    }
  };

  const handleApplySync = async (): Promise<void> => {
    // The token comes from the manifest the dashboard previewed.
    // Server-side, this trades back for the exact preview-time plan
    // (single-use, 5-min TTL) — no re-resolve, no preview/apply
    // closure drift. Without a token we'd be back to the old
    // "server re-resolves and silently applies a fresh plan" hole.
    const planToken = syncManifest?.planToken;
    if (planToken === undefined) {
      setError("internal: missing plan token (re-preview required)");
      setSyncStage("idle");
      return;
    }
    setSyncStage("applying");
    setError(null);
    try {
      // The sync API returns a `CatalogSyncResult` carrying per-entry
      // prereqs info, but the dashboard surfaces "needs ack" through
      // the entry's `blocked` badge + DetailDialog rather than via a
      // post-sync banner. We only need success vs throw here.
      if (target.kind === "skill") await applySkillSync(target.name, planToken);
      else if (target.kind === "agent") await applyAgentSync(target.name, planToken);
      else await applyMcpSync(target.name, planToken);
      onSynced();
    } catch (e) {
      setError((e as Error).message);
      setSyncStage("preview");
    }
  };

  const handleAcknowledge = async (): Promise<void> => {
    if (target.kind === "mcp") return; // mcps have no prereqs
    setActionBusy(true);
    setError(null);
    try {
      if (target.kind === "skill") await acknowledgeSkillPrereqs(target.name);
      else await acknowledgeAgentPrereqs(target.name);
      onSynced();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  const handleToggleAgent = async (currentlyDisabled: boolean): Promise<void> => {
    if (target.kind !== "agent") return;
    setActionBusy(true);
    setError(null);
    try {
      if (currentlyDisabled) await enableAgent(target.name);
      else await disableAgent(target.name);
      onSynced();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  const inSync = syncStage !== "idle";
  const syncBusy = syncStage === "previewing" || syncStage === "applying";

  // Lifecycle action visibility — derived once and reused by both the
  // footer button cluster and the Overview tab status area. Keeping
  // these in the parent (rather than recomputing in OverviewTab) lets
  // the footer render the buttons even when a different tab is active.
  const showAcknowledge = target.kind !== "mcp" && detail?.blockedReason?.needsPrereqsAck === true;
  const showAgentToggle = target.kind === "agent";

  // Hero header — rich title block. While the user is in the sync
  // flow we keep the same hero (so context never disappears) but mute
  // the status pill (it would be stale once apply runs anyway).
  const header = detail ? (
    <DetailHero target={target} detail={detail} hideStatus={inSync} />
  ) : (
    <h3 className="modal__title">{`${KIND_TITLE[target.kind]}: ${target.name}`}</h3>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`${KIND_TITLE[target.kind]}: ${target.name}`}
      header={header}
      size={inSync ? "large" : "default"}
    >
      <div className="modal__body modal__body--scroll detail-dialog">
        {loading && <p className="form-hint">Loading...</p>}

        {!loading && detail && !inSync && (
          <>
            <div className="detail-dialog__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "overview"}
                className={`detail-dialog__tab${activeTab === "overview" ? " detail-dialog__tab--active" : ""}`}
                onClick={() => setActiveTab("overview")}
              >
                Overview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "source"}
                className={`detail-dialog__tab${activeTab === "source" ? " detail-dialog__tab--active" : ""}`}
                onClick={() => setActiveTab("source")}
              >
                {sourceLabel(target.kind)}
              </button>
            </div>

            {activeTab === "overview" && <OverviewTab target={target} detail={detail} />}

            {activeTab === "source" && (
              <pre className={`detail-dialog__code lang-${detail.sourceLanguage}`}>
                {detail.source}
              </pre>
            )}
          </>
        )}

        {inSync && syncManifest && <ResolveTree manifest={syncManifest} />}
        {inSync && syncStage === "previewing" && <p className="form-hint">Resolving…</p>}

        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>

      <div className="modal__footer">
        {inSync && (
          <>
            <button
              type="button"
              className="btn btn--ghost modal__footer-secondary"
              onClick={() => {
                setSyncStage("idle");
                setSyncManifest(null);
              }}
              disabled={syncBusy}
            >
              ← Back
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleApplySync}
              disabled={syncBusy || (syncManifest?.upToDate ?? false)}
              title={syncManifest?.upToDate ? "Nothing to apply — already up to date" : undefined}
            >
              {syncStage === "applying"
                ? "Syncing…"
                : syncManifest?.upToDate
                  ? "Up to date"
                  : "Apply sync"}
            </button>
          </>
        )}
        {!inSync && detail && (
          <>
            {/*
             * Footer convention:
             *  - LEFT (ghost, `modal__footer-secondary`): "Sync from
             *    upstream". Always anchored here so its position never
             *    shifts as the entry's status changes — a stable button
             *    location matters more than a one-off primary-CTA promotion.
             *  - RIGHT (primary): the lifecycle CTA when one applies
             *    — Acknowledge prereqs (skills + agents) or
             *    Disable/Enable (agents). When no lifecycle CTA is
             *    relevant the right slot is intentionally empty;
             *    Sync stays on the left.
             *
             * Dismiss is handled by the modal header (×); a footer
             * Close would just compete with whichever CTA is anchored
             * on the right.
             */}
            <button
              type="button"
              className="btn btn--ghost modal__footer-secondary"
              onClick={handlePreviewSync}
              disabled={actionBusy}
              title="Preview the upstream diff before applying"
            >
              Sync from upstream
            </button>
            {showAgentToggle && (
              // Always available on agents, regardless of computed
              // status — disabling a `ready` agent is the user's
              // primary path to pausing it without uninstalling. The
              // label flips so the toggle is reversible from the same
              // place. Demoted to ghost when Acknowledge is also
              // visible so the structural-fix button stands out.
              <button
                type="button"
                className={showAcknowledge ? "btn btn--ghost" : "btn btn--primary"}
                onClick={() => handleToggleAgent(detail.disabledByUser ?? false)}
                disabled={actionBusy}
                title={
                  detail.disabledByUser
                    ? "Mark this agent active. Status will recompute."
                    : "Pause this agent. New dispatches will be refused until re-enabled."
                }
              >
                {detail.disabledByUser ? "Enable agent" : "Disable agent"}
              </button>
            )}
            {showAcknowledge && (
              // Right-most primary CTA when shown — acknowledging is
              // the most urgent action while the entry is blocked-
              // by-prereqs (it's the only thing standing between the
              // user and a usable entry).
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleAcknowledge}
                disabled={actionBusy}
                title="Mark prereqs as acknowledged so this entry can be used."
              >
                Acknowledge prereqs
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

interface DetailHeroProps {
  target: { kind: EntityKind; name: string };
  detail: LoadedDetail;
  hideStatus: boolean;
}

/**
 * Top-of-modal hero block. Mirrors the v0 mockup: a kind icon tile on
 * the left, KIND label + big mono fqn stacked next to it, an optional
 * namespace breadcrumb beneath, and a status pill on the right.
 */
function DetailHero({ target, detail, hideStatus }: DetailHeroProps) {
  const { scope, shortName } = splitFqnForDisplay(target.name);
  return (
    <div className="detail-hero">
      <span className="detail-hero__icon" aria-hidden="true">
        {KIND_ICON[target.kind]}
      </span>
      <div className="detail-hero__text">
        <div className="detail-hero__kind">{KIND_TAG[target.kind]}</div>
        <div className="detail-hero__title">
          <span className="detail-hero__name">{shortName}</span>
          {!hideStatus && (
            <span
              className={`detail-hero__status detail-hero__status--${detail.status}`}
              title={
                detail.status === "ready"
                  ? "Ready to use"
                  : detail.blockedReason
                    ? summariseReason(detail.blockedReason)
                    : "Blocked"
              }
            >
              <span className="detail-hero__status-dot" aria-hidden="true">
                ●
              </span>
              {detail.status === "ready" ? "Ready" : "Blocked"}
            </span>
          )}
        </div>
        {scope && <div className="detail-hero__namespace">{scope}</div>}
      </div>
    </div>
  );
}

interface OverviewTabProps {
  target: { kind: EntityKind; name: string };
  detail: LoadedDetail;
}

/**
 * The default tab. Renders the entry metadata as a definition list.
 * Lifecycle actions (Acknowledge, Disable/Enable) live in the dialog
 * footer alongside the primary CTA so the body stays purely
 * informational.
 */
function OverviewTab({ target, detail }: OverviewTabProps) {
  return (
    <dl className="detail-dialog__dl">
      {detail.description && (
        <>
          <dt>Description</dt>
          <dd>{detail.description}</dd>
        </>
      )}

      <dt>Origin</dt>
      <dd>
        <a
          href={hrefForOrigin(detail.origin)}
          target="_blank"
          rel="noreferrer noopener"
          className="detail-dialog__origin"
        >
          {detail.origin}
        </a>
        <span className="detail-dialog__origin-scheme"> · {schemeOf(detail.origin)}</span>
      </dd>

      {detail.version && (
        <>
          <dt>Version</dt>
          <dd>
            <code>{detail.version}</code>
          </dd>
        </>
      )}

      <dt>Status</dt>
      <dd>
        <StatusLine detail={detail} />
      </dd>

      {target.kind !== "mcp" && (
        <>
          <dt>Skills</dt>
          <dd>
            {detail.deps.skills.length === 0 ? (
              <span className="detail-dialog__empty">None</span>
            ) : (
              <DepList items={detail.deps.skills} />
            )}
          </dd>
          <dt>MCPs</dt>
          <dd>
            {detail.deps.mcps.length === 0 ? (
              <span className="detail-dialog__empty">None</span>
            ) : (
              <DepList items={detail.deps.mcps} />
            )}
          </dd>
        </>
      )}

      {detail.prereqs && (
        <>
          <dt>Prereqs</dt>
          <dd>
            <pre className="detail-dialog__prereqs">{detail.prereqs}</pre>
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * Status row inside the Overview definition list. Renders the same
 * coloured dot as the hero pill plus a one-line plain-English summary
 * (e.g. "All dependencies are available." for ready, or the structured
 * blocked reason joined into a sentence).
 */
function StatusLine({ detail }: { detail: LoadedDetail }): ReactNode {
  if (detail.status === "ready") {
    return (
      <span className="detail-dialog__status">
        <span className="detail-hero__status-dot detail-hero__status-dot--ready" aria-hidden="true">
          ●
        </span>
        Ready · All dependencies are available.
      </span>
    );
  }
  return (
    <span className="detail-dialog__status">
      <span className="detail-hero__status-dot detail-hero__status-dot--blocked" aria-hidden="true">
        ●
      </span>
      Blocked · {detail.blockedReason ? summariseReason(detail.blockedReason) : "unknown reason"}
    </span>
  );
}

function summariseReason(r: import("@emploke/catalog").BlockedReason): string {
  const parts: string[] = [];
  if (r.disabledByUser) parts.push("disabled by user");
  if (r.needsPrereqsAck) parts.push("prereqs not acknowledged");
  if (r.orphaned) parts.push("orphaned");
  if (r.missingDeps && r.missingDeps.length > 0) {
    parts.push(`missing deps: ${r.missingDeps.map((d) => d.name).join(", ")}`);
  }
  if (r.blockedDeps && r.blockedDeps.length > 0) {
    parts.push(`blocked deps: ${r.blockedDeps.map((d) => d.fqn).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "unknown reason";
}

function sourceLabel(kind: EntityKind): string {
  switch (kind) {
    case "skill":
      return "SKILL.md";
    case "agent":
      return "AGENTS.md";
    case "mcp":
      return "mcp.json";
  }
}

function schemeOf(origin: string): string {
  const colon = origin.indexOf(":");
  if (colon < 0) return "unknown";
  if (origin.startsWith("https://github.com/")) return "github";
  return origin.slice(0, colon);
}

function hrefForOrigin(origin: string): string {
  // Only http(s) URLs are click-safe; everything else (file:, future
  // npm:/oci:) goes through href="#" so the link is informational.
  if (origin.startsWith("https://") || origin.startsWith("http://")) return origin;
  return "#";
}

function projectSkill(d: SkillDetail): LoadedDetail {
  const meta = d.skill;
  return {
    origin: meta.origin,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    status: d.status,
    ...(d.blockedReason !== undefined ? { blockedReason: d.blockedReason } : {}),
    prereqsAck: meta.prereqsAck,
    orphaned: meta.orphaned,
    deps: {
      skills: (meta.dependencies?.skills ?? []).map((d) => d.fqn),
      mcps: (meta.dependencies?.mcps ?? []).map((d) => d.fqn),
    },
    source: d.content,
    sourceLanguage: "markdown",
  };
}

function projectAgent(d: AgentDetail): LoadedDetail {
  const meta = d.agent;
  return {
    origin: meta.origin,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    status: d.status,
    ...(d.blockedReason !== undefined ? { blockedReason: d.blockedReason } : {}),
    prereqsAck: meta.prereqsAck,
    disabledByUser: meta.disabledByUser,
    deps: {
      skills: (meta.dependencies?.skills ?? []).map((d) => d.fqn),
      mcps: (meta.dependencies?.mcps ?? []).map((d) => d.fqn),
    },
    source: d.content,
    sourceLanguage: "markdown",
  };
}

function projectMcp(d: McpDetail): LoadedDetail {
  return {
    origin: d.origin,
    status: d.orphaned ? "blocked" : "ready",
    ...(d.orphaned ? { blockedReason: { orphaned: true as const } } : {}),
    prereqsAck: true,
    orphaned: d.orphaned,
    deps: { skills: [], mcps: [] },
    source: d.content,
    sourceLanguage: "json",
  };
}

function DepList({ items }: { items: readonly string[] }) {
  return (
    <ul className="detail-dialog__deps">
      {items.map((origin) => (
        <li key={origin}>
          <a
            href={hrefForOrigin(origin)}
            target="_blank"
            rel="noreferrer noopener"
            className="detail-dialog__dep"
            title={origin}
          >
            {origin}
          </a>
        </li>
      ))}
    </ul>
  );
}
