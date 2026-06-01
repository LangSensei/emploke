import type { CatalogKind } from "@emploke/catalog";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { InstallProvider, InstallSource, ResolveManifest } from "../../api";
import { Modal } from "../../components/Modal";
import { ResolveTree } from "../../components/ResolveTree";
import { CATALOG_VERBS } from "./CATALOG_VERBS";

interface InstallDialogProps {
  kind: CatalogKind;
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

/**
 * Two-phase install dialog: input → resolve manifest preview → apply.
 * MCPs short-circuit the preview (no dep graph) and submit straight
 * through; whether the kind supports preview is data-driven via
 * `CATALOG_VERBS[kind].resolveInstall !== null`.
 */
export function InstallDialog({ kind, open, busy, error, onClose, onSubmit }: InstallDialogProps) {
  const verbs = CATALOG_VERBS[kind];
  const supportsPreview = verbs.resolveInstall !== null;

  const [provider, setProvider] = useState<InstallProvider>("github");
  // Per-provider input value. Provider-switching clears it so a half-typed
  // github URL doesn't accidentally submit when the user flips to local.
  const [input, setInput] = useState("");
  const [stage, setStage] = useState<InstallStage>("input");
  const [manifest, setManifest] = useState<ResolveManifest | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

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
    if (!supportsPreview) {
      // Leaf-entry kinds (mcp) have no dep graph to preview and the FQN
      // is recovered from the fetched content server-side; submit
      // straight through without the two-phase resolve dance.
      onSubmit(src);
      return;
    }
    setStage("previewing");
    setResolveError(null);
    try {
      const m = await verbs.resolveInstall!(src);
      setManifest(m);
      setStage("preview");
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
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
  const rootIsWillSync = manifest?.nodes.some(
    (n) => n.fqn === manifest.rootFqn && n.status === "will-sync",
  );

  // Per-provider input metadata: label, placeholder, hint. Tweaked per
  // catalog kind (skill vs agent vs mcp) so the hint always matches the
  // file the user is actually pointing at.
  const inputMeta = inputMetaFor(provider, kind);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Install ${verbs.title}`}
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
              {stage === "previewing"
                ? "Resolving..."
                : !supportsPreview
                  ? "Install"
                  : "Preview install"}
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

// ─── input metadata ──────────────────────────────────────────────

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
 * added on submit (see {@link InstallSource} and `buildOriginFromSource`).
 * The label never says "Origin URI" because users shouldn't need to know
 * the underlying URI grammar.
 */
function inputMetaFor(provider: InstallProvider, kind: CatalogKind): InputMeta {
  const what = WHAT[kind];

  if (provider === "github") {
    return {
      label: "GitHub URL",
      placeholder: GITHUB_EXAMPLE[kind],
      hint: (
        <>
          URL to the {what}. Paste the exact URL from your browser when viewing the folder/file on
          github.com.
        </>
      ),
    };
  }

  return {
    label: "Absolute path",
    placeholder: LOCAL_EXAMPLE[kind],
    hint: <>Absolute path on the server's filesystem to the {what}.</>,
  };
}

/** Human description of what each kind's anchor file looks like. */
const WHAT: Record<CatalogKind, string> = {
  skill: "skill folder (must contain SKILL.md)",
  agent: "agent folder (must contain AGENTS.md)",
  mcp: "MCP JSON file",
};

const GITHUB_EXAMPLE: Record<CatalogKind, string> = {
  skill: "https://github.com/owner/repo/tree/main/skills/my-skill",
  agent: "https://github.com/owner/repo/tree/main/agents/my-agent",
  mcp: "https://github.com/owner/repo/tree/main/mcps/my-mcp.json",
};

const LOCAL_EXAMPLE: Record<CatalogKind, string> = {
  skill: "/home/me/skills/my-skill",
  agent: "/home/me/agents/my-agent",
  mcp: "/home/me/mcps/my-mcp.json",
};
