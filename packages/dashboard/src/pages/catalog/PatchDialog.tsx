import type { CatalogKind } from "@emploke/contracts";
import { useEffect, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import { MetadataForm, type MetadataFormValues } from "../../components/MetadataForm";
import { Modal } from "../../components/Modal";
import { CATALOG_VERBS, type CatalogMetadataPatch } from "./CATALOG_VERBS";

interface PatchDialogProps {
  kind: CatalogKind;
  name: string;
  // Available names for chip autocomplete in the metadata form.
  availableSkills: string[];
  availableMcps: string[];
  /**
   * Installed agent FQNs (excluding the entry being edited) for the
   * agent-deps chip autocomplete. Only used when `kind === "agent"`.
   */
  availableAgents: string[];
  onClose: () => void;
  onSaved: () => void;
}

type EditMode = "form" | "source";

/**
 * Edit dialog for any mutable catalog entry (file: origin). Reads the
 * entry detail via {@link CATALOG_VERBS}, then offers either:
 *   - form-mode: structured metadata edit (skill / agent only); or
 *   - source-mode: raw anchor file edit (SKILL.md / AGENTS.md / mcp.json).
 *
 * MCPs skip form mode entirely (their structure is the JSON itself);
 * agents additionally expose a lifecycle toggle (Disable / Enable) in
 * the footer. All three behaviours are data-driven via the per-kind
 * verbs, not by branching on the kind discriminator here.
 *
 * The Catalog page routes immutable entries to `DetailDialog` instead;
 * mutability is not tracked here. A stale state (entry mutability
 * changed under us) surfaces as a 405 from the API.
 */
export function PatchDialog({
  kind,
  name,
  availableSkills,
  availableMcps,
  availableAgents,
  onClose,
  onSaved,
}: PatchDialogProps) {
  const verbs = CATALOG_VERBS[kind];
  // Whether the kind exposes a structured metadata form. False ⇒
  // dialog is locked to source mode. By the verbs construction this
  // also implies `verbs.patchMetadata !== null`.
  const supportsForm = verbs.patchMetadata !== null;
  const lifecycle = verbs.lifecycle;

  // ─ source-mode state (raw editor) ──────────────────
  const [text, setText] = useState("");
  // ─ form-mode state (metadata form) ─────────────────
  const [form, setForm] = useState<MetadataFormValues>({
    description: "",
    version: "",
    prereqs: "",
    skills: [],
    mcps: [],
    agents: [],
  });
  // Captured at load time for agents so the lifecycle button knows
  // which direction the toggle should go. `null` ⇒ kind has no
  // lifecycle (skill / mcp).
  const [agentDisabledByUser, setAgentDisabledByUser] = useState<boolean | null>(null);

  const [mode, setMode] = useState<EditMode>(supportsForm ? "form" : "source");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on mount / target change. The detail loader (per kind) returns
  // a normalised `CatalogEntryDetail` shape so this effect never
  // re-discriminates on the kind itself.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async (): Promise<void> => {
      const detail = await verbs.loadDetail(name);
      if (cancelled) return;
      setText(detail.content);
      if (detail.meta !== null) {
        setForm({
          description: detail.meta.description,
          version: detail.meta.version,
          prereqs: detail.meta.prereqs,
          skills: detail.meta.skills,
          mcps: detail.meta.mcps,
          agents: detail.meta.agents,
        });
      }
      setAgentDisabledByUser(detail.agentDisabledByUser);
    };
    load()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [verbs, name]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (mode === "source") {
        // Source mode (mcp always, skill/agent when toggled): write raw
        // content via PUT. Server validates JSON for mcp; for skill/agent
        // the raw markdown is preserved verbatim including frontmatter.
        await verbs.updateContent(name, text);
      } else {
        // Form mode: PATCH metadata fields only. Per-kind adapters in
        // CATALOG_VERBS strip the fields the backend ignores
        // (agents have no `prereqs`; skills cannot carry `agents`).
        //
        // null-when-all-empty preservation is intentional — the server
        // distinguishes "explicitly empty deps" from "deps field omitted".
        // We include `agents` in the emptiness check only for agent
        // kind; for skills `form.agents` is always [] so it never
        // changes the outcome but we keep the gate explicit for clarity.
        const agentsEmpty = kind !== "agent" || form.agents.length === 0;
        const allDepsEmpty = form.skills.length === 0 && form.mcps.length === 0 && agentsEmpty;
        const patch: CatalogMetadataPatch = {
          description: form.description,
          version: form.version,
          prereqs: form.prereqs.trim() === "" ? null : form.prereqs,
          dependencies: allDepsEmpty
            ? null
            : {
                skills: form.skills,
                mcps: form.mcps,
                ...(kind === "agent" ? { agents: form.agents } : {}),
              },
        };
        // `mode === "form"` and we only flipped past `supportsForm` so
        // `verbs.patchMetadata !== null` by construction.
        await verbs.patchMetadata!(name, patch);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAgentDisabled = async (): Promise<void> => {
    if (lifecycle === null || agentDisabledByUser === null) return;
    setToggling(true);
    setError(null);
    try {
      if (agentDisabledByUser) {
        await lifecycle.enable(name);
        setAgentDisabledByUser(false);
      } else {
        await lifecycle.disable(name);
        setAgentDisabledByUser(true);
      }
      // Don't close the dialog — toggle is in-place; user may want to
      // continue editing. The catalog list doesn't refresh until Save
      // or Close, so flag stays consistent with the displayed state.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };

  const title = `Edit ${verbs.title}: ${name}`;
  const isLargeMode = mode === "source" || !supportsForm;

  return (
    <Modal open onClose={onClose} title={title} size={isLargeMode ? "large" : "default"}>
      <div className="modal__body modal__body--scroll">
        {loading ? (
          <p className="form-hint">Loading...</p>
        ) : !supportsForm ? (
          <CodeEditor
            value={text}
            onChange={setText}
            language={verbs.sourceLanguage}
            disabled={saving}
            height="500px"
          />
        ) : mode === "form" ? (
          <MetadataForm
            // `supportsForm` is true ⇒ kind ∈ {"skill", "agent"} by
            // construction (mcp has no metadata form). The verbs table
            // is the single source of that invariant.
            kind={kind as "skill" | "agent"}
            values={form}
            onChange={setForm}
            availableSkills={availableSkills.filter((n) => n !== name)}
            availableMcps={availableMcps}
            // Only thread agent-deps autocomplete + missing highlight
            // for agent forms — skills never render the agent-deps
            // chip group, so passing them would be inert noise.
            {...(kind === "agent"
              ? {
                  availableAgents,
                  missingAgents: form.agents.filter((a) => !availableAgents.includes(a)),
                }
              : {})}
            // form.skills/mcps are fqn strings (catalog v2); surface
            // ones not in the installed set as missing.
            missingSkills={form.skills.filter((s) => !availableSkills.includes(s))}
            missingMcps={form.mcps.filter((m) => !availableMcps.includes(m))}
            disabled={saving}
          />
        ) : (
          <CodeEditor
            value={text}
            onChange={setText}
            language={verbs.sourceLanguage}
            disabled={saving}
            height="500px"
          />
        )}
        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>
      <div className="modal__footer">
        {supportsForm && (
          <button
            type="button"
            className="btn btn--ghost modal__footer-secondary"
            onClick={() => setMode(mode === "form" ? "source" : "form")}
            disabled={saving || loading || toggling}
          >
            {mode === "form" ? "Edit source →" : "← Back to form"}
          </button>
        )}
        {lifecycle !== null && agentDisabledByUser !== null && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleToggleAgentDisabled}
            disabled={saving || loading || toggling}
            title={
              agentDisabledByUser
                ? "Mark this agent active. New dispatches will be allowed."
                : "Pause this agent. New dispatches will be refused until re-enabled."
            }
          >
            {toggling
              ? agentDisabledByUser
                ? "Enabling…"
                : "Disabling…"
              : agentDisabledByUser
                ? "Enable agent"
                : "Disable agent"}
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} disabled={saving || toggling}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleSave}
          disabled={loading || saving || toggling}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}
