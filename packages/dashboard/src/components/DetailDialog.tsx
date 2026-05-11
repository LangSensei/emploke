import { useEffect, useState } from "react";
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
import { KIND_TITLE } from "../kindMeta";
import { Modal } from "./Modal";
import { ResolveTree } from "./ResolveTree";

/**
 * Read-only detail view for an installed catalog entry.
 *
 * Shown instead of `EditDialog` when the entry's origin is immutable
 * (currently any non-`file:` scheme — see {@link isOriginMutable} in
 * `@emploke/catalog`). Mutable entries still get the full edit form.
 *
 * Layout, top to bottom:
 *  - Status strip: lock + scheme label + Sync from upstream button
 *    (opens a 2-stage preview/apply dialog rather than the legacy
 *    one-shot install)
 *  - Per-entry CTA strip — appears only when the entry is `blocked`:
 *      - Acknowledge button when prereqs are pending
 *      - Enable / Disable button (agents only) for the user toggle
 *  - Origin URL row (wraps long URLs cleanly; click-to-copy for
 *    operators forking the upstream)
 *  - Definition list of the entry's metadata (description, version,
 *    deps, prereqs), each rendered statically — no input fields
 *  - Collapsible Source section showing the raw anchor file
 *    (SKILL.md / AGENTS.md / mcp.json) for users who want to see what
 *    they actually installed before sync'ing or forking
 *
 * Pure read view: NO disabled inputs, NO toggle between form/source
 * modes, NO Save button. Ergonomics for "I want to inspect what's
 * installed and decide whether to sync" diverge enough from
 * "I want to edit my own entry" that a separate dialog reduces noise.
 */
export interface DetailDialogProps {
  target: { kind: "skill" | "agent" | "mcp"; name: string };
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

export function DetailDialog({ target, onClose, onSynced }: DetailDialogProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LoadedDetail | null>(null);
  const [syncManifest, setSyncManifest] = useState<ResolveManifest | null>(null);
  const [syncStage, setSyncStage] = useState<"idle" | "previewing" | "preview" | "applying">(
    "idle",
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
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

  const title = `${KIND_TITLE[target.kind]}: ${target.name}`;
  const scheme = detail ? schemeOf(detail.origin) : "";
  const inSync = syncStage !== "idle";
  const syncBusy = syncStage === "previewing" || syncStage === "applying";

  return (
    <Modal open onClose={onClose} title={title} size={inSync ? "large" : "default"}>
      <div className="modal__body modal__body--scroll detail-dialog">
        {loading && <p className="form-hint">Loading...</p>}
        {!loading && detail && !inSync && (
          <>
            <div className="detail-dialog__strip">
              <span className="detail-dialog__strip-label">
                <span aria-hidden="true">🔒</span> Read-only · <code>{scheme}</code>
              </span>
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                {target.kind === "agent" && (
                  // Lifecycle toggle is always available on agents,
                  // regardless of computed status — disabling a `ready`
                  // agent is the user's primary path to pausing it
                  // without uninstalling. Disabled-state shows Enable
                  // so the toggle is reversible from the same place.
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
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
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={handlePreviewSync}
                  disabled={actionBusy}
                  title="Preview the upstream diff before applying"
                >
                  Sync from upstream
                </button>
              </div>
            </div>

            {detail.status === "blocked" && detail.blockedReason && (
              <BlockedActionStrip
                reason={detail.blockedReason}
                kind={target.kind}
                actionBusy={actionBusy}
                onAcknowledge={handleAcknowledge}
              />
            )}

            <dl className="detail-dialog__dl">
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
              </dd>

              {detail.description && (
                <>
                  <dt>Description</dt>
                  <dd>{detail.description}</dd>
                </>
              )}

              {detail.version && (
                <>
                  <dt>Version</dt>
                  <dd>
                    <code>{detail.version}</code>
                  </dd>
                </>
              )}

              {target.kind !== "mcp" && (
                <>
                  <dt>Skills</dt>
                  <dd>
                    {detail.deps.skills.length === 0 ? (
                      <span className="detail-dialog__empty">none</span>
                    ) : (
                      <DepList items={detail.deps.skills} />
                    )}
                  </dd>
                  <dt>MCPs</dt>
                  <dd>
                    {detail.deps.mcps.length === 0 ? (
                      <span className="detail-dialog__empty">none</span>
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

            <details
              className="detail-dialog__source"
              open={showSource}
              onToggle={(e) => setShowSource((e.target as HTMLDetailsElement).open)}
            >
              <summary>
                {sourceLabel(target.kind)} ·{" "}
                <span className="detail-dialog__source-hint">({detail.source.length} bytes)</span>
              </summary>
              <pre className={`detail-dialog__code lang-${detail.sourceLanguage}`}>
                {detail.source}
              </pre>
            </details>
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
          <button type="button" className="btn" onClick={onClose} disabled={actionBusy}>
            Close
          </button>
        )}
      </div>
    </Modal>
  );
}

interface BlockedActionStripProps {
  reason: import("@emploke/catalog").BlockedReason;
  kind: "skill" | "agent" | "mcp";
  actionBusy: boolean;
  onAcknowledge: () => void;
}

/**
 * Inline alert that surfaces only when an entry is `blocked`. Carries
 * the Acknowledge action for self-blocking via prereqs; cascade
 * blockers (missingDeps / blockedDeps) are shown in the message but
 * resolved by acting on the dep itself, not from this strip. Agent
 * Enable/Disable is OWNED BY THE TOP STRIP — keeping it there means
 * the user can pause a `ready` agent too, not just unpause a blocked one.
 */
function BlockedActionStrip({ reason, kind, actionBusy, onAcknowledge }: BlockedActionStripProps) {
  return (
    <div className="alert alert--warn detail-dialog__blocked-strip">
      <strong>Blocked.</strong> <span>{summariseReason(reason)}</span>
      {reason.needsPrereqsAck && kind !== "mcp" && (
        <div className="detail-dialog__blocked-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onAcknowledge}
            disabled={actionBusy}
          >
            Acknowledge prereqs
          </button>
        </div>
      )}
    </div>
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

function sourceLabel(kind: "skill" | "agent" | "mcp"): string {
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
