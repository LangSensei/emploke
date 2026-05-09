import type { AgentEntry, SkillEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useState } from "react";
import {
  getAgent,
  getMcp,
  getSkill,
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

type EditTarget =
  | { kind: "skill"; name: string }
  | { kind: "agent"; name: string }
  | { kind: "mcp"; name: string };

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

  const doInstall = async (
    origin: string,
    name: string | undefined,
    scopeHints: Record<string, string>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "agents")
        await installAgent(origin, hasHints(scopeHints) ? scopeHints : undefined);
      else if (tab === "skills")
        await installSkill(origin, hasHints(scopeHints) ? scopeHints : undefined);
      else {
        if (!name) throw new Error("name is required for MCP installs");
        await installMcp(origin, name);
      }
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

          {error && !installOpen && !confirmRemove && (
            <div className="alert alert--error" style={{ marginBottom: 16 }}>
              ⚠ {error}
            </div>
          )}

          {tab === "agents" && (
            <EntryGrid
              items={agents.map((a) => ({
                name: a.agent.name,
                description: a.agent.description,
                version: a.agent.version,
                status: a.status,
                missingDeps: a.missingDeps,
                skillsCount: a.agent.dependencies?.skills?.length ?? 0,
                mcpsCount: a.agent.dependencies?.mcps?.length ?? 0,
              }))}
              emptyTitle="No agents installed"
              emptyHint={<>Agents wrap skills + MCPs into runnable templates.</>}
              onEdit={(name) => {
                setError(null);
                setEdit({ kind: "agent", name });
              }}
              onRemove={(name) => setConfirmRemove(name)}
            />
          )}

          {tab === "skills" && (
            <EntryGrid
              items={skills.map((s) => ({
                name: s.skill.name,
                description: s.skill.description,
                version: s.skill.version,
                status: s.status,
                missingDeps: s.missingDeps,
                skillsCount: s.skill.dependencies?.skills?.length ?? 0,
                mcpsCount: s.skill.dependencies?.mcps?.length ?? 0,
              }))}
              emptyTitle="No skills installed"
              emptyHint={<>A skill is a reusable capability package referenced by agents.</>}
              onEdit={(name) => {
                setError(null);
                setEdit({ kind: "skill", name });
              }}
              onRemove={(name) => setConfirmRemove(name)}
            />
          )}

          {tab === "mcps" && (
            <McpGrid
              mcps={mcps}
              onEdit={(name) => {
                setError(null);
                setEdit({ kind: "mcp", name });
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

          {edit !== null && (
            <EditDialog
              target={edit}
              availableSkills={skills.map((s) => s.skill.name)}
              availableMcps={mcps.map((m) => m.name)}
              onClose={() => setEdit(null)}
              onSaved={() => {
                setEdit(null);
                onChanged();
              }}
            />
          )}
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
   * `origin` is a URI: `https://github.com/<owner>/<repo>/tree/<ref>/<path>`
   * or `file:<absolute-path>`. `name` is required for MCPs (full
   * MCP-spec FQN, `<namespace>/<short>`). `scopeHints` is the per-FQN
   * scope override map (skill/agent only — MCPs ignore hints).
   */
  onSubmit: (origin: string, name: string | undefined, scopeHints: Record<string, string>) => void;
}

type InstallStage = "input" | "previewing" | "preview" | "applying";

function InstallDialog({ kind, open, busy, error, onClose, onSubmit }: InstallDialogProps) {
  const [origin, setOrigin] = useState("");
  const [name, setName] = useState("");
  const [stage, setStage] = useState<InstallStage>("input");
  const [manifest, setManifest] = useState<ResolveManifest | null>(null);
  const [scopeHints, setScopeHints] = useState<Record<string, string>>({});
  const [resolveError, setResolveError] = useState<string | null>(null);
  const isMcp = kind === "mcps";

  // Reset transient state whenever the dialog closes / re-opens.
  useEffect(() => {
    if (!open) {
      setStage("input");
      setManifest(null);
      setScopeHints({});
      setResolveError(null);
    }
  }, [open]);

  const handleScopeChange = (fqn: string, scope: string): void => {
    if (!manifest) return;
    const node = manifest.nodes.find((n) => n.fqn === fqn);
    const trimmed = scope.trim();
    setScopeHints((prev) => {
      const next = { ...prev };
      // If the user blanked the field or set it back to the default,
      // drop the hint so the install body stays sparse.
      const defaultScope =
        node && (node.kind === "skill" || node.kind === "agent") ? node.defaultScope : "";
      if (trimmed === "" || trimmed === defaultScope) {
        delete next[fqn];
      } else {
        next[fqn] = trimmed;
      }
      return next;
    });
  };

  const handlePreview = async (e: FormEvent) => {
    e.preventDefault();
    if (!origin.trim()) return;
    if (isMcp) {
      // MCPs skip the resolve preview — single fetch + write, no deps to
      // tweak; submit straight through.
      if (!name.trim()) return;
      onSubmit(origin.trim(), name.trim(), {});
      return;
    }
    setStage("previewing");
    setResolveError(null);
    try {
      const m =
        kind === "agents"
          ? await resolveAgentInstall(origin.trim())
          : await resolveSkillInstall(origin.trim());
      setManifest(m);
      setStage("preview");
    } catch (err) {
      setResolveError((err as Error).message);
      setStage("input");
    }
  };

  const handleApply = (): void => {
    setStage("applying");
    onSubmit(origin.trim(), undefined, scopeHints);
  };

  const handleBack = (): void => {
    setStage("input");
    setManifest(null);
    setScopeHints({});
  };

  const stageBusy = busy || stage === "previewing" || stage === "applying";
  const showPreview = stage === "preview" || stage === "applying";

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
            <label htmlFor="install-origin">Origin URI</label>
            <input
              id="install-origin"
              type="text"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://github.com/owner/repo/tree/main/path  or  file:/abs/path"
              // biome-ignore lint/a11y/noAutofocus: install dialog opens in response to a user click; auto-focusing the only field is expected UX
              autoFocus
              disabled={stageBusy || showPreview}
            />
            <p className="form-hint">
              <code>
                https://github.com/&lt;owner&gt;/&lt;repo&gt;/tree/&lt;ref&gt;/&lt;path&gt;
              </code>{" "}
              for remote installs, or <code>file:&lt;absolute-path&gt;</code> for the server's local
              filesystem. Dependencies are recursively previewed and installed.
            </p>
          </div>

          {isMcp && (
            <div className="form-field">
              <label htmlFor="install-name">Name</label>
              <input
                id="install-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="azure/mcp (full MCP-spec FQN with /)"
                disabled={stageBusy}
              />
              <p className="form-hint">
                Required — the full MCP-spec FQN (<code>&lt;namespace&gt;/&lt;short&gt;</code>).
                MCPs do NOT participate in scope-mapping; the spec name IS the catalog identity.
              </p>
            </div>
          )}

          {showPreview && manifest && (
            <ResolveTree
              manifest={manifest}
              scopeHints={scopeHints}
              onScopeChange={handleScopeChange}
              disabled={stage === "applying"}
            />
          )}

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
              disabled={stageBusy || !origin.trim() || (isMcp && !name.trim())}
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
              {stage === "applying" ? "Installing..." : "Install"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function hasHints(hints: Record<string, string>): boolean {
  for (const _ in hints) return true;
  return false;
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
        if (!cancelled) setText(d.content);
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
            // Project DependencyRef → FQN string for the missing-set
            // comparison. `MetadataForm` does the same projection internally
            // when rendering chips, so the chip flagged as missing matches
            // the FQN we test here.
            missingSkills={form.skills
              .map((s) => (s.scope ? `${s.scope}/${s.name}` : s.name))
              .filter((label) => !availableSkills.includes(label))}
            missingMcps={form.mcps
              .map((m) => (m.scope ? `${m.scope}/${m.name}` : m.name))
              .filter((label) => !availableMcps.includes(label))}
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

// ─── Frontmatter helpers (client-side, best-effort) ───────────────
//
// (Removed: server already parses frontmatter authoritatively and exposes
// the structured fields via GET /api/skills/:name and /api/agents/:name.
// We project from those rather than re-parsing on the client, which avoids
// drift and edge-case bugs like inline-flow YAML arrays.)
