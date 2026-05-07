import type { AgentEntry, SkillEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useState } from "react";
import {
  getMcp,
  installAgent,
  installMcp,
  installSkill,
  type McpItem,
  removeAgent,
  removeMcp,
  removeSkill,
  updateMcpContent,
} from "../api";
import { EntryTable } from "../components/EntryTable";
import { PlusIcon, TrashIcon } from "../components/Icons";
import { Modal } from "../components/Modal";

export type CatalogTab = "agents" | "skills" | "mcps";

interface CatalogProps {
  tab: CatalogTab;
  onTabChange: (tab: CatalogTab) => void;
  skills: SkillEntry[];
  agents: AgentEntry[];
  mcps: McpItem[];
  onChanged: () => void;
}

const KIND_LABEL: Record<CatalogTab, string> = {
  agents: "Agent",
  skills: "Skill",
  mcps: "MCP",
};

export function CatalogPage({ tab, onTabChange, skills, agents, mcps, onChanged }: CatalogProps) {
  const [installOpen, setInstallOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editMcp, setEditMcp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doInstall = async (sourcePath: string, name?: string) => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "agents") await installAgent(sourcePath);
      else if (tab === "skills") await installSkill(sourcePath);
      else await installMcp(sourcePath, name);
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
        <EntryTable
          items={agents.map((a) => ({
            name: a.agent.name,
            description: a.agent.description,
            version: a.agent.version,
            status: a.status,
            missingDeps: a.missingDeps,
          }))}
          emptyTitle="No agents installed"
          emptyHint={<>Agents wrap skills + MCPs into runnable templates.</>}
          onRemove={(name) => setConfirmRemove(name)}
        />
      )}

      {tab === "skills" && (
        <EntryTable
          items={skills.map((s) => ({
            name: s.skill.name,
            description: s.skill.description,
            version: s.skill.version,
            status: s.status,
            missingDeps: s.missingDeps,
          }))}
          emptyTitle="No skills installed"
          emptyHint={<>A skill is a reusable capability package referenced by agents.</>}
          onRemove={(name) => setConfirmRemove(name)}
        />
      )}

      {tab === "mcps" && (
        <McpList
          mcps={mcps}
          onRemove={(name) => setConfirmRemove(name)}
          onEdit={(name) => {
            setError(null);
            setEditMcp(name);
          }}
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

      {editMcp !== null && (
        <EditMcpDialog
          name={editMcp}
          onClose={() => setEditMcp(null)}
          onSaved={() => {
            setEditMcp(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// ─── McpList ──────────────────────────────────────────────────────

function McpList({
  mcps,
  onRemove,
  onEdit,
}: {
  mcps: McpItem[];
  onRemove: (name: string) => void;
  onEdit: (name: string) => void;
}) {
  if (mcps.length === 0) {
    return (
      <div className="empty">
        <div className="empty__icon">∅</div>
        <h3 className="empty__title">No MCPs installed</h3>
        <p className="empty__hint">MCPs are JSON server configs referenced by skills/agents.</p>
      </div>
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Path</th>
          <th className="actions-col" />
        </tr>
      </thead>
      <tbody>
        {mcps.map((m) => (
          <tr key={m.name}>
            <td className="name-cell">
              <button
                type="button"
                className="link-button"
                onClick={() => onEdit(m.name)}
                title="View / edit JSON"
              >
                {m.name}
              </button>
            </td>
            <td className="desc-cell mono" style={{ fontSize: 12 }}>
              {m.path ?? <em>—</em>}
            </td>
            <td className="actions-cell">
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={() => onRemove(m.name)}
                aria-label={`Remove ${m.name}`}
                title="Remove"
              >
                <TrashIcon />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── InstallDialog ────────────────────────────────────────────────

interface InstallDialogProps {
  kind: CatalogTab;
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (sourcePath: string, name?: string) => void;
}

function InstallDialog({ kind, open, busy, error, onClose, onSubmit }: InstallDialogProps) {
  const [sourcePath, setSourcePath] = useState("");
  const [name, setName] = useState("");
  const isFile = kind === "mcps";

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!sourcePath.trim()) return;
    onSubmit(sourcePath.trim(), name.trim() || undefined);
  };

  return (
    <Modal open={open} onClose={onClose} title={`Install ${KIND_LABEL[kind]}`}>
      <form onSubmit={handleSubmit}>
        <div className="modal__body">
          <div className="form-field">
            <label htmlFor="install-source">
              {isFile ? "Source JSON file" : "Source directory"}
            </label>
            <input
              id="install-source"
              type="text"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder={isFile ? "/absolute/path/to/server.json" : "/absolute/path/to/skill-dir"}
              autoFocus
              disabled={busy}
            />
            <p className="form-hint">
              Path on the <strong>server's</strong> local filesystem.
            </p>
          </div>

          {isFile && (
            <div className="form-field">
              <label htmlFor="install-name">Name (optional)</label>
              <input
                id="install-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Defaults to filename"
                disabled={busy}
              />
            </div>
          )}

          {error && <div className="alert alert--error">⚠ {error}</div>}
        </div>

        <div className="modal__footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !sourcePath.trim()}>
            {busy ? "Installing..." : "Install"}
          </button>
        </div>
      </form>
    </Modal>
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

// ─── EditMcpDialog ────────────────────────────────────────────────

interface EditMcpDialogProps {
  name: string;
  onClose: () => void;
  onSaved: () => void;
}

function EditMcpDialog({ name, onClose, onSaved }: EditMcpDialogProps) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMcp(name)
      .then((d) => {
        if (!cancelled) setText(JSON.stringify(d.content, null, 2));
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const handleSave = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`invalid JSON: ${(e as Error).message}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateMcpContent(name, parsed);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit MCP: ${name}`}>
      <div className="modal__body">
        {loading && <p className="form-hint">Loading...</p>}
        {!loading && (
          <div className="form-field">
            <label htmlFor="mcp-content">JSON content</label>
            <textarea
              id="mcp-content"
              className="code-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={16}
              disabled={saving}
            />
            <p className="form-hint">Edited atomically on the server.</p>
          </div>
        )}
        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleSave}
          disabled={loading || saving || text === ""}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}
