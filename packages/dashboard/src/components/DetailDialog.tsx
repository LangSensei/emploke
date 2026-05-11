import { useEffect, useState } from "react";
import {
  type AgentDetail,
  getAgent,
  getMcp,
  getSkill,
  type InstallSource,
  installAgent,
  installMcp,
  installSkill,
  type McpDetail,
  type SkillDetail,
} from "../api";
import { Modal } from "./Modal";

/**
 * Read-only detail view for an installed catalog entry.
 *
 * Shown instead of `EditDialog` when the entry's origin is immutable
 * (currently any non-`file:` scheme — see {@link isOriginMutable} in
 * `@emploke/catalog`). Mutable entries still get the full edit form.
 *
 * Layout, top to bottom:
 *  - Status strip: lock + scheme label + Sync button (re-installs from
 *    origin; this is the only "write" the user can do for a remote entry)
 *  - Origin URL row (wraps long URLs cleanly; click-to-copy for
 *    operators forking the upstream)
 *  - Definition list of the entry's metadata (description, version,
 *    deps), each rendered statically — no input fields, since "edit"
 *    isn't the user's verb here
 *  - Collapsible Source section showing the raw anchor file
 *    (SKILL.md / AGENTS.md / mcp.json) for users who want to see what
 *    they actually installed before sync'ing or forking
 *
 * Pure read view: NO disabled inputs, NO toggle between form/source
 * modes, NO Save button. Ergonomics for "I want to inspect what's
 * installed and decide whether to sync" diverge enough from
 * "I want to edit my own entry" that a separate dialog reduces noise.
 *
 * Future (issue #53): the Source section will grow into a per-file
 * browser (sibling files for skills/agents become navigable and
 * viewable). The component is structured so that change is a swap
 * of the Source <details> block for a file tree + content pane.
 */
export interface DetailDialogProps {
  target: { kind: "skill" | "agent" | "mcp"; name: string };
  onClose: () => void;
  /** Called after a successful Sync; parent re-fetches catalog list. */
  onSynced: () => void;
}

interface LoadedDetail {
  origin: string;
  description?: string;
  version?: string;
  prereqs?: string;
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
  const [syncing, setSyncing] = useState(false);
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

  const handleSync = async (): Promise<void> => {
    if (!detail) return;
    setSyncing(true);
    setError(null);
    try {
      const src = sourceFromOrigin(detail.origin);
      if (target.kind === "skill") await installSkill(src);
      else if (target.kind === "agent") await installAgent(src);
      else await installMcp(src);
      onSynced();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const title = `${KIND_LABEL[target.kind]}: ${target.name}`;
  const scheme = detail ? schemeOf(detail.origin) : "";

  return (
    <Modal open onClose={onClose} title={title}>
      <div className="modal__body modal__body--scroll detail-dialog">
        {loading && <p className="form-hint">Loading...</p>}
        {!loading && detail && (
          <>
            <div className="detail-dialog__strip">
              <span className="detail-dialog__strip-label">
                <span aria-hidden="true">🔒</span> Read-only · <code>{scheme}</code>
              </span>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={handleSync}
                disabled={syncing}
                title="Re-fetch from upstream and overwrite the local copy"
              >
                {syncing ? "Syncing..." : "Sync from upstream"}
              </button>
            </div>

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

        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>

      <div className="modal__footer">
        <button type="button" className="btn" onClick={onClose} disabled={syncing}>
          Close
        </button>
      </div>
    </Modal>
  );
}

const KIND_LABEL: Record<"skill" | "agent" | "mcp", string> = {
  skill: "Skill",
  agent: "Agent",
  mcp: "MCP",
};

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

/**
 * Reverse {@link InstallSource} from a stored origin URI. Used by Sync
 * (which has the origin in hand from the catalog and needs to feed it
 * back through the install API in the new structured form).
 *
 *   - github URL          → { provider: "github", location: <url> }
 *   - file:<abs>          → { provider: "file",   location: <abs> }
 *
 * Anything we don't recognise falls through as github (the API will
 * 400 on an unsupported scheme; better than swallowing).
 */
function sourceFromOrigin(origin: string): InstallSource {
  if (origin.startsWith("file:")) {
    return { provider: "file", location: origin.slice("file:".length) };
  }
  return { provider: "github", location: origin };
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
