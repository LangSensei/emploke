import type { AgentEntry, SkillEntry } from "@emploke/catalog";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  getAgent,
  getMcp,
  getSkill,
  type InstallProvider,
  type InstallSource,
  installAgent,
  installMcp,
  installSkill,
  type McpItem,
  patchAgentMetadata,
  patchSkillMetadata,
  type ResolveManifest,
  removeAgent,
  removeMcp,
  removeSkill,
  resolveAgentInstall,
  resolveSkillInstall,
  updateAgentContent,
  updateMcpContent,
  updateSkillContent,
} from "../api";
import { CodeEditor } from "../components/CodeEditor";
import { DetailDialog } from "../components/DetailDialog";
import { EntryGrid } from "../components/EntryGrid";
import { PlusIcon } from "../components/Icons";
import { McpGrid } from "../components/McpGrid";
import { MetadataForm, type MetadataFormValues } from "../components/MetadataForm";
import { Modal } from "../components/Modal";
import { ResolveTree } from "../components/ResolveTree";

export type CatalogTab = "agents" | "skills" | "mcps";

interface CatalogProps {
  tab: CatalogTab;
  onTabChange: (tab: CatalogTab) => void;
  skills: SkillEntry[];
  agents: AgentEntry[];
  mcps: McpItem[];
  /** Currently-selected workspace id (UUID); null = no workspace, page renders an empty-state. */
  currentWorkspaceId: string | null;
  onChanged: () => void;
}

const KIND_LABEL: Record<CatalogTab, string> = {
  agents: "Agent",
  skills: "Skill",
  mcps: "MCP",
};

type DialogTarget =
  | { kind: "skill"; name: string; mutable: boolean }
  | { kind: "agent"; name: string; mutable: boolean }
  | { kind: "mcp"; name: string; mutable: boolean };

type EditTarget = DialogTarget;

export function CatalogPage({
  tab,
  onTabChange,
  skills,
  agents,
  mcps,
  currentWorkspaceId,
  onChanged,
}: CatalogProps) {
  const [installOpen, setInstallOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "blocked" | "orphaned">("all");

  // Filter the per-tab list down according to the status pill row.
  // `orphaned` only meaningful for skills + mcps (agents can't be
  // orphaned — they're root entities), so the filter is hidden when
  // the agents tab is active.
  const filteredAgents = useMemo(() => {
    if (statusFilter === "all") return agents;
    if (statusFilter === "ready") return agents.filter((a) => a.status === "ready");
    if (statusFilter === "blocked") return agents.filter((a) => a.status === "blocked");
    return agents; // orphaned doesn't apply
  }, [agents, statusFilter]);

  const filteredSkills = useMemo(() => {
    if (statusFilter === "all") return skills;
    if (statusFilter === "ready") return skills.filter((s) => s.status === "ready");
    if (statusFilter === "blocked") return skills.filter((s) => s.status === "blocked");
    return skills.filter((s) => s.skill.orphaned);
  }, [skills, statusFilter]);

  const filteredMcps = useMemo(() => {
    if (statusFilter === "all") return mcps;
    // mcps don't carry status; only orphaned applies. Treat ready as
    // "not orphaned" and blocked as "orphaned" to keep the pill set
    // consistent across tabs.
    if (statusFilter === "ready") return mcps.filter((m) => !m.orphaned);
    return mcps.filter((m) => m.orphaned);
  }, [mcps, statusFilter]);

  const orphanCount = useMemo(() => {
    if (tab === "skills") return skills.filter((s) => s.skill.orphaned).length;
    if (tab === "mcps") return mcps.filter((m) => m.orphaned).length;
    return 0;
  }, [tab, skills, mcps]);

  /**
   * Set after a successful install/sync. Each entry needs the user to
   * follow its prereqs and click Acknowledge before the entity will run.
   * Rendered as a sticky alert until the user dismisses it.
   */
  const [pendingPrereqs, setPendingPrereqs] = useState<
    { kind: "skill" | "agent"; fqn: string; prereqs: string }[]
  >([]);

  const doInstall = async (src: InstallSource) => {
    setBusy(true);
    setError(null);
    try {
      const result =
        tab === "agents"
          ? await installAgent(src)
          : tab === "skills"
            ? await installSkill(src)
            : await installMcp(src);
      // Surface any newly-installed (or sync-touched) skill/agent that
      // has prereqs the user hasn't acknowledged yet — frontend
      // contract spelled out on `CatalogInstalledEntry`.
      const pending = result.installed.filter(
        (e): e is typeof e & { prereqs: string } =>
          (e.kind === "skill" || e.kind === "agent") &&
          e.prereqs !== undefined &&
          e.prereqsAck === false,
      );
      setPendingPrereqs(
        pending.map((e) => ({
          kind: e.kind as "skill" | "agent",
          fqn: e.fqn,
          prereqs: e.prereqs,
        })),
      );
      setInstallOpen(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "agents") await removeAgent(name);
      else if (tab === "skills") await removeSkill(name);
      else await removeMcp(name);
      setConfirmRemove(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRemoveAllOrphans = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "skills") {
        const orphans = skills.filter((s) => s.skill.orphaned);
        for (const s of orphans) {
          try {
            await removeSkill(s.skill.fqn);
          } catch (e) {
            // HasDependentsError shouldn't happen by definition (orphans
            // have zero reverse-deps), but if it does, surface and continue
            // — best-effort bulk delete shouldn't abort halfway.
            setError(`failed to remove ${s.skill.fqn}: ${(e as Error).message}`);
          }
        }
      } else if (tab === "mcps") {
        const orphans = mcps.filter((m) => m.orphaned);
        for (const m of orphans) {
          try {
            await removeMcp(m.name);
          } catch (e) {
            setError(`failed to remove ${m.name}: ${(e as Error).message}`);
          }
        }
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {currentWorkspaceId === null ? (
        <div className="alert alert--error">
          No workspace is selected. Use the workspace dropdown in the top bar to choose or create
          one — the catalog is scoped to a workspace.
        </div>
      ) : (
        <>
          <div className="page-toolbar">
            <nav className="section-tabs">
              <button
                type="button"
                className={tab === "agents" ? "active" : ""}
                onClick={() => onTabChange("agents")}
              >
                Agents <span className="count">{agents.length}</span>
              </button>
              <button
                type="button"
                className={tab === "skills" ? "active" : ""}
                onClick={() => onTabChange("skills")}
              >
                Skills <span className="count">{skills.length}</span>
              </button>
              <button
                type="button"
                className={tab === "mcps" ? "active" : ""}
                onClick={() => onTabChange("mcps")}
              >
                MCPs <span className="count">{mcps.length}</span>
              </button>
            </nav>
            <div className="page-toolbar__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setError(null);
                  setInstallOpen(true);
                }}
              >
                <PlusIcon />
                Install {KIND_LABEL[tab]}
              </button>
            </div>
          </div>

          <div
            className="section-tabs"
            style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center" }}
          >
            <FilterPill
              label="All"
              active={statusFilter === "all"}
              onClick={() => setStatusFilter("all")}
            />
            <FilterPill
              label="Ready"
              active={statusFilter === "ready"}
              onClick={() => setStatusFilter("ready")}
            />
            {tab !== "mcps" && (
              <FilterPill
                label="Blocked"
                active={statusFilter === "blocked"}
                onClick={() => setStatusFilter("blocked")}
              />
            )}
            {tab !== "agents" && (
              <FilterPill
                label={`Orphaned${orphanCount > 0 ? ` (${orphanCount})` : ""}`}
                active={statusFilter === "orphaned"}
                onClick={() => setStatusFilter("orphaned")}
              />
            )}
            {statusFilter === "orphaned" && orphanCount > 0 && tab !== "agents" && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={doRemoveAllOrphans}
                disabled={busy}
                style={{ marginLeft: "auto" }}
                title="Delete every orphaned entry. Each delete is guarded against accidentally removing one with dependents."
              >
                {busy ? "Removing…" : `Remove all (${orphanCount})`}
              </button>
            )}
          </div>

          {error && !installOpen && !confirmRemove && (
            <div className="alert alert--error" style={{ marginBottom: 16 }}>
              ⚠ {error}
            </div>
          )}

          {pendingPrereqs.length > 0 && (
            <div className="alert alert--warn" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>
                  {pendingPrereqs.length}{" "}
                  {pendingPrereqs.length === 1 ? "entry needs" : "entries need"} prereqs setup
                </strong>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setPendingPrereqs([])}
                >
                  Dismiss
                </button>
              </div>
              <p style={{ marginTop: 4, marginBottom: 8, fontSize: 13 }}>
                Follow the prereqs below, then click each entry's <strong>Acknowledge</strong>{" "}
                button to mark it ready.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {pendingPrereqs.map((p) => (
                  <li key={`${p.kind}:${p.fqn}`} style={{ marginBottom: 6 }}>
                    <code>{p.fqn}</code> ({p.kind}):
                    <pre
                      style={{
                        margin: "4px 0 0 0",
                        padding: 8,
                        background: "var(--surface-alt, #f5f5f5)",
                        borderRadius: 4,
                        fontSize: 12,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {p.prereqs}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "agents" && (
            <EntryGrid
              items={filteredAgents.map((a) => ({
                name: a.agent.fqn,
                description: a.agent.description,
                version: a.agent.version,
                status: a.status,
                ...(a.blockedReason !== undefined ? { blockedReason: a.blockedReason } : {}),
                missingDeps: a.missingDeps,
                skillsCount: a.agent.dependencies?.skills?.length ?? 0,
                mcpsCount: a.agent.dependencies?.mcps?.length ?? 0,
              }))}
              emptyTitle="No agents installed"
              emptyHint={<>Agents wrap skills + MCPs into runnable templates.</>}
              onEdit={(name) => {
                setError(null);
                const a = agents.find((x) => x.agent.fqn === name);
                setEdit({ kind: "agent", name, mutable: a?.agent.mutable ?? true });
              }}
              onRemove={(name) => setConfirmRemove(name)}
            />
          )}

          {tab === "skills" && (
            <EntryGrid
              items={filteredSkills.map((s) => ({
                name: s.skill.fqn,
                description: s.skill.description,
                version: s.skill.version,
                status: s.status,
                ...(s.blockedReason !== undefined ? { blockedReason: s.blockedReason } : {}),
                missingDeps: s.missingDeps,
                skillsCount: s.skill.dependencies?.skills?.length ?? 0,
                mcpsCount: s.skill.dependencies?.mcps?.length ?? 0,
              }))}
              emptyTitle="No skills installed"
              emptyHint={<>A skill is a reusable capability package referenced by agents.</>}
              onEdit={(name) => {
                setError(null);
                const s = skills.find((x) => x.skill.fqn === name);
                setEdit({ kind: "skill", name, mutable: s?.skill.mutable ?? true });
              }}
              onRemove={(name) => setConfirmRemove(name)}
            />
          )}

          {tab === "mcps" && (
            <McpGrid
              mcps={filteredMcps}
              onEdit={(name) => {
                setError(null);
                const m = mcps.find((x) => x.name === name);
                setEdit({ kind: "mcp", name, mutable: m?.mutable ?? true });
              }}
              onRemove={(name) => setConfirmRemove(name)}
            />
          )}

          <InstallDialog
            kind={tab}
            open={installOpen}
            busy={busy}
            error={error}
            onClose={() => {
              setInstallOpen(false);
              setError(null);
            }}
            onSubmit={doInstall}
          />

          <ConfirmRemoveDialog
            kind={tab}
            name={confirmRemove}
            busy={busy}
            error={error}
            onClose={() => {
              setConfirmRemove(null);
              setError(null);
            }}
            onConfirm={() => confirmRemove && doRemove(confirmRemove)}
          />

          {edit !== null &&
            (edit.mutable ? (
              <EditDialog
                target={edit}
                availableSkills={skills.map((s) => s.skill.fqn)}
                availableMcps={mcps.map((m) => m.name)}
                onClose={() => setEdit(null)}
                onSaved={() => {
                  setEdit(null);
                  onChanged();
                }}
              />
            ) : (
              <DetailDialog
                target={{ kind: edit.kind, name: edit.name }}
                onClose={() => setEdit(null)}
                onSynced={(syncResult) => {
                  if (syncResult !== undefined) {
                    const pending = syncResult.installed.filter(
                      (e): e is typeof e & { prereqs: string } =>
                        (e.kind === "skill" || e.kind === "agent") &&
                        e.prereqs !== undefined &&
                        e.prereqsAck === false,
                    );
                    if (pending.length > 0) {
                      setPendingPrereqs(
                        pending.map((e) => ({
                          kind: e.kind as "skill" | "agent",
                          fqn: e.fqn,
                          prereqs: e.prereqs,
                        })),
                      );
                    }
                  }
                  setEdit(null);
                  onChanged();
                }}
              />
            ))}
        </>
      )}
    </div>
  );
}

// ─── InstallDialog ────────────────────────────────────────────────

interface InstallDialogProps {
  kind: CatalogTab;
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /**
   * `src` is the structured install source (provider + location);
   * server assembles the canonical origin URI from those.
   */
  onSubmit: (src: InstallSource) => void;
}

type InstallStage = "input" | "previewing" | "preview" | "applying";

function InstallDialog({ kind, open, busy, error, onClose, onSubmit }: InstallDialogProps) {
  const [provider, setProvider] = useState<InstallProvider>("github");
  // Per-provider input value. Provider-switching clears it so a half-typed
  // github URL doesn't accidentally submit when the user flips to local.
  const [input, setInput] = useState("");
  const [stage, setStage] = useState<InstallStage>("input");
  const [manifest, setManifest] = useState<ResolveManifest | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const isMcp = kind === "mcps";

  // Reset transient state whenever the dialog closes / re-opens.
  useEffect(() => {
    if (!open) {
      setStage("input");
      setManifest(null);
      setResolveError(null);
      setInput("");
      setProvider("github");
    }
  }, [open]);

  const handleProviderChange = (p: InstallProvider): void => {
    setProvider(p);
    setInput("");
    setResolveError(null);
  };

  // Build the structured install source from the form. The server is
  // responsible for assembling the canonical origin URI — clients
  // never need to type `file:` prefixes or assemble URI strings.
  const buildSource = (): InstallSource => ({ provider, location: input.trim() });

  const handlePreview = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const src = buildSource();
    if (isMcp) {
      // MCPs are leaf entries (no dep graph to preview) and the FQN
      // is recovered from `_meta.name` server-side; submit straight
      // through without the two-phase resolve dance.
      onSubmit(src);
      return;
    }
    setStage("previewing");
    setResolveError(null);
    try {
      const m = kind === "agents" ? await resolveAgentInstall(src) : await resolveSkillInstall(src);
      setManifest(m);
      setStage("preview");
    } catch (err) {
      setResolveError((err as Error).message);
      setStage("input");
    }
  };

  const handleApply = (): void => {
    setStage("applying");
    onSubmit(buildSource());
  };

  const handleBack = (): void => {
    setStage("input");
    setManifest(null);
  };

  const stageBusy = busy || stage === "previewing" || stage === "applying";
  const showPreview = stage === "preview" || stage === "applying";
  // When the resolved root was already installed under the same origin,
  // `install` semantically becomes "sync from upstream" (catalog upserts
  // with fresh content). Re-label the primary action so the user knows
  // we're not re-creating; we're updating in place.
  const rootIsWillSync =
    manifest !== null &&
    manifest.nodes.some((n) => n.fqn === manifest.rootFqn && n.status === "will-sync");

  // Per-provider input metadata: label, placeholder, hint. Tweaked per
  // catalog kind (skill vs agent vs mcp) so the hint always matches the
  // file the user is actually pointing at.
  const inputMeta = inputMetaFor(provider, kind);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Install ${KIND_LABEL[kind]}`}
      size={showPreview ? "large" : "default"}
    >
      <form onSubmit={handlePreview}>
        <div className="modal__body">
          <div className="form-field">
            <label htmlFor="install-provider">Source</label>
            <select
              id="install-provider"
              className="install-dialog__provider"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as InstallProvider)}
              disabled={stageBusy || showPreview}
            >
              <option value="github">GitHub</option>
              <option value="file">Local file</option>
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="install-input">{inputMeta.label}</label>
            <input
              id="install-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={inputMeta.placeholder}
              // biome-ignore lint/a11y/noAutofocus: install dialog opens in response to a user click; auto-focusing the only field is expected UX
              autoFocus
              disabled={stageBusy || showPreview}
            />
            <p className="form-hint">{inputMeta.hint}</p>
          </div>

          {showPreview && manifest && <ResolveTree manifest={manifest} />}

          {(error || resolveError) && (
            <div className="alert alert--error">⚠ {error ?? resolveError}</div>
          )}
        </div>

        <div className="modal__footer">
          {showPreview && (
            <button
              type="button"
              className="btn btn--ghost modal__footer-secondary"
              onClick={handleBack}
              disabled={stageBusy}
            >
              ← Back
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={stageBusy}>
            Cancel
          </button>
          {!showPreview ? (
            <button
              type="submit"
              className="btn btn--primary"
              disabled={stageBusy || !input.trim()}
            >
              {stage === "previewing" ? "Resolving..." : isMcp ? "Install" : "Preview install"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleApply}
              disabled={stageBusy}
            >
              {stage === "applying"
                ? rootIsWillSync
                  ? "Syncing..."
                  : "Installing..."
                : rootIsWillSync
                  ? "Sync from upstream"
                  : "Install"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ─── FilterPill ────────────────────────────────────────────────────

interface FilterPillProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function FilterPill({ label, active, onClick }: FilterPillProps) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        border: "1px solid var(--border, #ddd)",
        background: active ? "var(--accent, #2c5fb5)" : "transparent",
        color: active ? "white" : "inherit",
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      {label}
    </button>
  );
}

// ─── ConfirmRemoveDialog ──────────────────────────────────────────

interface ConfirmRemoveDialogProps {
  kind: CatalogTab;
  name: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

function ConfirmRemoveDialog({
  kind,
  name,
  busy,
  error,
  onClose,
  onConfirm,
}: ConfirmRemoveDialogProps) {
  return (
    <Modal open={name !== null} onClose={onClose} title={`Remove ${KIND_LABEL[kind]}`}>
      <div className="modal__body">
        <p>
          Remove <code>{name}</code>? This deletes the entry from the catalog. Other entries that
          declare it as a dependency will be marked <strong>disabled</strong>.
        </p>
        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Removing..." : "Remove"}
        </button>
      </div>
    </Modal>
  );
}

// ─── EditDialog ────────────────────────────────────────────────────

interface EditDialogProps {
  target: EditTarget;
  // Available names for chip autocomplete in the metadata form.
  availableSkills: string[];
  availableMcps: string[];
  onClose: () => void;
  onSaved: () => void;
}

type EditMode = "form" | "source";

function EditDialog({ target, availableSkills, availableMcps, onClose, onSaved }: EditDialogProps) {
  // ─ source-mode state (raw editor) ──────────────────
  const [text, setText] = useState("");
  // ─ form-mode state (metadata form) ─────────────────
  const [form, setForm] = useState<MetadataFormValues>({
    description: "",
    version: "",
    prereqs: "",
    skills: [],
    mcps: [],
  });

  const [mode, setMode] = useState<EditMode>(target.kind === "mcp" ? "source" : "form");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // EditDialog is only opened for mutable (file: origin) entries —
  // the Catalog page routes immutable entries to DetailDialog instead.
  // We don't carry mutability state here; the catalog facade still
  // gates writes on the server side, so a stale state (entry mutability
  // changed under us) surfaces as a 405 from the API.

  // Load on mount / target change. We always fetch the raw content (covers
  // source mode) and additionally project the server's structured fields
  // into the form values — no client-side YAML parsing needed.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async (): Promise<void> => {
      if (target.kind === "mcp") {
        const d = await getMcp(target.name);
        if (cancelled) return;
        setText(d.content);
        return;
      }
      const detail =
        target.kind === "skill" ? await getSkill(target.name) : await getAgent(target.name);
      if (cancelled) return;
      setText(detail.content);
      const meta = "skill" in detail ? detail.skill : detail.agent;
      setForm({
        description: meta.description ?? "",
        version: meta.version ?? "",
        prereqs: "skill" in detail ? (detail.skill.prereqs ?? "") : "",
        skills: [...(meta.dependencies?.skills ?? [])],
        mcps: [...(meta.dependencies?.mcps ?? [])],
      });
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

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (target.kind === "mcp") {
        // Server validates that `text` is parseable JSON; no need to re-parse
        // here. Sending raw string preserves user's formatting verbatim.
        await updateMcpContent(target.name, text);
      } else if (mode === "source") {
        // Skill / Agent source mode: write raw content via PUT.
        if (target.kind === "skill") await updateSkillContent(target.name, text);
        else await updateAgentContent(target.name, text);
      } else {
        // Skill / Agent form mode: PATCH the metadata fields only.
        const patch =
          target.kind === "skill"
            ? {
                description: form.description,
                version: form.version,
                prereqs: form.prereqs.trim() === "" ? null : form.prereqs,
                dependencies:
                  form.skills.length === 0 && form.mcps.length === 0
                    ? null
                    : { skills: form.skills, mcps: form.mcps },
              }
            : {
                description: form.description,
                version: form.version,
                dependencies:
                  form.skills.length === 0 && form.mcps.length === 0
                    ? null
                    : { skills: form.skills, mcps: form.mcps },
              };
        if (target.kind === "skill") await patchSkillMetadata(target.name, patch);
        else await patchAgentMetadata(target.name, patch);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const kindLabel = KIND_LABEL[(target.kind === "mcp" ? "mcps" : `${target.kind}s`) as CatalogTab];
  const title = `Edit ${kindLabel}: ${target.name}`;
  const isLargeMode = mode === "source" || target.kind === "mcp";

  return (
    <Modal open onClose={onClose} title={title} size={isLargeMode ? "large" : "default"}>
      <div className="modal__body modal__body--scroll">
        {loading ? (
          <p className="form-hint">Loading...</p>
        ) : target.kind === "mcp" ? (
          <CodeEditor
            value={text}
            onChange={setText}
            language="json"
            disabled={saving}
            height="500px"
          />
        ) : mode === "form" ? (
          <MetadataForm
            kind={target.kind}
            values={form}
            onChange={setForm}
            availableSkills={availableSkills.filter((n) => n !== target.name)}
            availableMcps={availableMcps}
            // dep refs are now bare origin strings; surface ones whose
            // origin isn't in the installed set as missing.
            missingSkills={form.skills.filter((s) => !availableSkills.includes(s))}
            missingMcps={form.mcps.filter((m) => !availableMcps.includes(m))}
            disabled={saving}
          />
        ) : (
          <CodeEditor
            value={text}
            onChange={setText}
            language="markdown"
            disabled={saving}
            height="500px"
          />
        )}
        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>
      <div className="modal__footer">
        {target.kind !== "mcp" && (
          <button
            type="button"
            className="btn btn--ghost modal__footer-secondary"
            onClick={() => setMode(mode === "form" ? "source" : "form")}
            disabled={saving || loading}
          >
            {mode === "form" ? "Edit source →" : "← Back to form"}
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleSave}
          disabled={loading || saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}

// ─── InstallDialog input metadata ────────────────────────────────

interface InputMeta {
  label: string;
  placeholder: string;
  hint: ReactNode;
}

/**
 * Per-(provider × catalog kind) input field metadata. The user types
 * ONE thing — a github URL or a local path — and we tell them exactly
 * what we expect to find at that location.
 *
 * GitHub URLs go through verbatim; local paths get the `file:` prefix
 * added on submit (see {@link InstallDialog.buildOrigin}). The label
 * never says "Origin URI" because users shouldn't need to know the
 * underlying URI grammar.
 */
function inputMetaFor(provider: InstallProvider, kind: CatalogTab): InputMeta {
  const what =
    kind === "skills"
      ? "skill folder (must contain SKILL.md)"
      : kind === "agents"
        ? "agent folder (must contain AGENTS.md)"
        : "MCP JSON file";

  if (provider === "github") {
    const example =
      kind === "skills"
        ? "https://github.com/owner/repo/tree/main/skills/my-skill"
        : kind === "agents"
          ? "https://github.com/owner/repo/tree/main/agents/my-agent"
          : "https://github.com/owner/repo/tree/main/mcps/my-mcp.json";
    return {
      label: "GitHub URL",
      placeholder: example,
      hint: (
        <>
          URL to the {what}. Paste the exact URL from your browser when viewing the folder/file on
          github.com.
        </>
      ),
    };
  }

  // Local file
  const example =
    kind === "skills"
      ? "/home/me/skills/my-skill"
      : kind === "agents"
        ? "/home/me/agents/my-agent"
        : "/home/me/mcps/my-mcp.json";
  return {
    label: "Absolute path",
    placeholder: example,
    hint: <>Absolute path on the server's filesystem to the {what}.</>,
  };
}

// ─── Frontmatter helpers (client-side, best-effort) ───────────────
//
// (Removed: server already parses frontmatter authoritatively and exposes
// the structured fields via GET /api/skills/:name and /api/agents/:name.
// We project from those rather than re-parsing on the client, which avoids
// drift and edge-case bugs like inline-flow YAML arrays.)
