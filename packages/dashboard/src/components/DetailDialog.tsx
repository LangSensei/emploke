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
 *  - Footer: Sync from upstream + Close. While the user is in the
 *    sync resolve flow, the footer switches to the standard
 *    Back / Cancel / Apply triad.
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
    setSyncStage("applying");
    setError(null);
    try {
      // The sync API returns a `CatalogSyncResult` carrying per-entry
      // prereqs info, but the dashboard surfaces "needs ack" through
      // the entry's `blocked` badge + DetailDialog rather than via a
      // post-sync banner. We only need success vs throw here.
      if (target.kind === "skill") await applySkillSync(target.name);
      else if (target.kind === "agent") await applyAgentSync(target.name);
      else await applyMcpSync(target.name);
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

            {activeTab === "overview" && (
              <OverviewTab
                target={target}
                detail={detail}
                actionBusy={actionBusy}
                onAcknowledge={handleAcknowledge}
                onToggleAgent={handleToggleAgent}
              />
            )}

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
            <button type="button" className="btn" onClick={onClose} disabled={syncBusy}>
              Cancel
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
        {!inSync && (
          <>
            <button
              type="button"
              className="btn btn--primary modal__footer-secondary"
              onClick={handlePreviewSync}
              disabled={actionBusy || !detail}
              title="Preview the upstream diff before applying"
            >
              Sync from upstream
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={actionBusy}>
              Close
            </button>
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
  const { namespace, short } = splitFqn(target.name);
  return (
    <div className="detail-hero">
      <span className="detail-hero__icon" aria-hidden="true">
        {KIND_ICON[target.kind]}
      </span>
      <div className="detail-hero__text">
        <div className="detail-hero__kind">{KIND_TAG[target.kind]}</div>
        <div className="detail-hero__title">
          <span className="detail-hero__name">{short}</span>
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
        {namespace && <div className="detail-hero__namespace">{namespace}</div>}
      </div>
    </div>
  );
}

interface OverviewTabProps {
  target: { kind: EntityKind; name: string };
  detail: LoadedDetail;
  actionBusy: boolean;
  onAcknowledge: () => void;
  onToggleAgent: (currentlyDisabled: boolean) => void;
}

/**
 * The default tab. Shows the action strip (visible when there is any
 * action available — Acknowledge for self-blocked-by-prereqs entries
 * or Enable/Disable for agents), then the metadata definition list.
 */
function OverviewTab({
  target,
  detail,
  actionBusy,
  onAcknowledge,
  onToggleAgent,
}: OverviewTabProps) {
  const showAcknowledge = target.kind !== "mcp" && detail.blockedReason?.needsPrereqsAck === true;
  const showAgentToggle = target.kind === "agent";
  const hasActions = showAcknowledge || showAgentToggle;

  return (
    <>
      {hasActions && (
        <div className="detail-dialog__actions">
          {showAcknowledge && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={onAcknowledge}
              disabled={actionBusy}
              title="Mark prereqs as acknowledged so this entry can be used."
            >
              Acknowledge prereqs
            </button>
          )}
          {showAgentToggle && (
            // Always available on agents, regardless of computed status
            // — disabling a `ready` agent is the user's primary path
            // to pausing it without uninstalling. The label flips so
            // the toggle is reversible from the same place.
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onToggleAgent(detail.disabledByUser ?? false)}
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
        </div>
      )}

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
    </>
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

/**
 * Split a fqn like `langsensei/emploke-dev` into namespace + short
 * name so the hero can render them on two visually distinct lines.
 * Unscoped entries (no slash) return `namespace = ""` — caller hides
 * the second line.
 */
function splitFqn(fqn: string): { namespace: string; short: string } {
  const slash = fqn.lastIndexOf("/");
  if (slash <= 0) return { namespace: "", short: fqn };
  return { namespace: fqn.slice(0, slash), short: fqn.slice(slash + 1) };
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
      skills: [...(meta.dependencies?.skills ?? [])],
      mcps: [...(meta.dependencies?.mcps ?? [])],
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
      skills: [...(meta.dependencies?.skills ?? [])],
      mcps: [...(meta.dependencies?.mcps ?? [])],
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
