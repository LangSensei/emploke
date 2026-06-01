import type { AgentEntry, SkillEntry } from "@emploke/catalog";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deleteAgent,
  deleteMcp,
  deleteSkill,
  disableAgent,
  enableAgent,
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
  resolveAgentInstall,
  resolveSkillInstall,
  updateAgentContent,
  updateMcpContent,
  updateSkillContent,
} from "../api";
import { CodeEditor } from "../components/CodeEditor";
import { DetailDialog } from "../components/DetailDialog";
import { EntryGrid } from "../components/EntryGrid";
import { HeaderActions } from "../components/HeaderActions";
import { PlusIcon } from "../components/Icons";
import { McpGrid } from "../components/McpGrid";
import { MetadataForm, type MetadataFormValues } from "../components/MetadataForm";
import { Modal } from "../components/Modal";
import { ResolveTree } from "../components/ResolveTree";
import { useClickOutside } from "../hooks/useClickOutside";
import { useUrlSearchValue } from "../hooks/useUrlState";
import { KIND_TITLE } from "../kindMeta";

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

/**
 * Mirror of `KIND_TITLE` keyed by the page's plural tab key.
 * Catalog uses the plural form for legacy URL stability; everywhere
 * else uses singular via {@link KIND_TITLE} / {@link KIND_TAG}.
 */
const KIND_LABEL: Record<CatalogTab, string> = {
  agents: KIND_TITLE.agent,
  skills: KIND_TITLE.skill,
  mcps: KIND_TITLE.mcp,
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Reset the filter when the tab changes — switching from Skills
  // (where "Blocked" is valid) to MCPs (where it isn't) would leave
  // an unreachable filter selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setStatusFilter is stable; tab change is the trigger
  useEffect(() => {
    setStatusFilter("all");
  }, [tab]);

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

  // PR #189 polish v3 — `?agent=<fqn>` deep-link. When the URL carries
  // an agent fqn (e.g. from the AgentDetailPane's Configure button) and
  // the matching row is rendered on the Agents tab, scroll it into view
  // and apply a transient highlight class for ~2s. Misses are a silent
  // no-op (stale link / uninstalled agent).
  //
  // `appliedAgentHighlightRef` keeps the scroll from re-firing on every
  // unrelated re-render (filter typing, etc.) while still allowing the
  // effect to re-run when `filteredAgents` arrives late so the row that
  // wasn't in the DOM on first pass still gets the treatment.
  const [agentHint] = useUrlSearchValue("agent", "");
  const appliedAgentHighlightRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (tab !== "agents") {
      appliedAgentHighlightRef.current = null;
      return;
    }
    if (agentHint === "" || agentHint === null) return;
    if (appliedAgentHighlightRef.current === agentHint) return;

    const selector = `.card-grid__item[data-entry-name="${CSS.escape(agentHint)}"]`;
    const row = document.querySelector<HTMLElement>(selector);
    if (!row) return; // Silent no-op on miss (stale link / uninstalled agent).

    appliedAgentHighlightRef.current = agentHint;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.classList.add("card-grid__item--highlight");
    const t = window.setTimeout(() => {
      row.classList.remove("card-grid__item--highlight");
    }, 2000);
    return () => {
      window.clearTimeout(t);
      row.classList.remove("card-grid__item--highlight");
    };
  }, [agentHint, tab]);

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

  const doInstall = async (src: InstallSource) => {
    setBusy(true);
    setError(null);
    try {
      // The install/sync responses carry a per-entry `prereqs` +
      // `prereqsAck` payload (see `CatalogInstalledEntry` on the
      // server) so other clients (CLI, future scripts) can react,
      // but the dashboard relies on the entry's own `blocked` badge
      // and DetailDialog to surface the same information rather
      // than splashing a banner above the grid.
      if (tab === "agents") await installAgent(src);
      else if (tab === "skills") await installSkill(src);
      else await installMcp(src);
      setInstallOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "agents") await deleteAgent(name);
      else if (tab === "skills") await deleteSkill(name);
      else await deleteMcp(name);
      setConfirmRemove(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            await deleteSkill(s.skill.fqn);
          } catch (e) {
            // HasDependentsError shouldn't happen by definition (orphans
            // have zero reverse-deps), but if it does, surface and continue
            // — best-effort bulk delete shouldn't abort halfway.
            setError(
              `failed to remove ${s.skill.fqn}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      } else if (tab === "mcps") {
        const orphans = mcps.filter((m) => m.orphaned);
        for (const m of orphans) {
          try {
            await deleteMcp(m.fqn);
          } catch (e) {
            setError(`failed to remove ${m.fqn}: ${e instanceof Error ? e.message : String(e)}`);
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
          <HeaderActions>
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
          </HeaderActions>
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
              {/*
                Status filter is a popover-style button rather than a
                row of inline pills. The pills approach used to occupy
                a slice of the toolbar that competed with the kind tabs
                and the install button; collapsing them into one
                "Filters" button keeps the toolbar to a single row and
                gives us room to add sort / search controls later
                without redesigning the strip again.

                When the active filter is anything other than "All",
                the button title shows the picked value and a small
                indicator dot so it's still obvious from a glance that
                a filter is constraining the view.
              */}
              <FilterMenu
                tab={tab}
                value={statusFilter}
                onChange={setStatusFilter}
                orphanCount={orphanCount}
              />
              {statusFilter === "orphaned" && orphanCount > 0 && tab !== "agents" && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={doRemoveAllOrphans}
                  disabled={busy}
                  title="Delete every orphaned entry. Each delete is guarded against accidentally removing one with dependents."
                >
                  {busy ? "Removing…" : `Remove all (${orphanCount})`}
                </button>
              )}
            </div>
          </div>

          {error && !installOpen && !confirmRemove && (
            <div className="alert alert--error" style={{ marginBottom: 16 }}>
              ⚠ {error}
            </div>
          )}

          {tab === "agents" && (
            <EntryGrid
              kind="agent"
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
              kind="skill"
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
                const m = mcps.find((x) => x.fqn === name);
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
                availableMcps={mcps.map((m) => m.fqn)}
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
                onSynced={() => {
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

// ─── FilterMenu ────────────────────────────────────────────────────

type StatusFilter = "all" | "ready" | "blocked" | "orphaned";

interface FilterMenuProps {
  /** Which catalog tab is active — drives which options are valid. */
  tab: CatalogTab;
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  /** Surfaced as a count next to the Orphaned option. */
  orphanCount: number;
}

interface FilterOption {
  readonly value: StatusFilter;
  readonly label: string;
  /** Optional count to render as a small chip after the label. */
  readonly count?: number;
}

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  ready: "Ready",
  blocked: "Blocked",
  orphaned: "Orphaned",
};

/**
 * Per-tab filter menu, opened from a single toolbar button so the
 * top strip stays at one row of chrome regardless of how many filter
 * dimensions we add later.
 *
 * Implementation: a controlled popover (state-driven open/close).
 * We previously used a native `<details>`/`<summary>` and claimed it
 * gave close-on-outside-click + Esc for free — that was wrong.
 * Browsers don't run a global handler on `<details>` and Esc only
 * closes when focus is already inside the panel. The current pattern:
 *   - `open` state on this component drives `aria-expanded` on the
 *     trigger and conditional render of the panel.
 *   - `useClickOutside` listens on `document` `pointerdown` and closes
 *     when the event target is outside both the trigger and the panel.
 *   - A `keydown` listener on `document` closes on Escape.
 *   - The panel is `position: absolute` (parent `.filter-menu` is
 *     `position: relative`) and lives above the grid below via a
 *     high z-index, so opening the menu does not change toolbar
 *     height.
 *
 * Per-tab option set:
 *   - agents: All / Ready / Blocked         (agents can never be orphaned)
 *   - skills: All / Ready / Blocked / Orphaned
 *   - mcps:   All / Orphaned                (mcps have no ready/blocked semantics)
 *
 * If the active tab doesn't support the current filter (e.g. user was
 * on Skills with "Blocked" and switches to Mcps), the parent caller
 * is responsible for resetting the value on tab change.
 */
function FilterMenu({ tab, value, onChange, orphanCount }: FilterMenuProps) {
  const options: FilterOption[] = [{ value: "all", label: FILTER_LABEL.all }];
  if (tab !== "mcps") {
    options.push(
      { value: "ready", label: FILTER_LABEL.ready },
      { value: "blocked", label: FILTER_LABEL.blocked },
    );
  }
  if (tab !== "agents") {
    options.push({
      value: "orphaned",
      label: FILTER_LABEL.orphaned,
      ...(orphanCount > 0 ? { count: orphanCount } : {}),
    });
  }

  const activeLabel = FILTER_LABEL[value];
  const isFiltered = value !== "all";

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  // Stable ref array so useClickOutside's effect deps don't churn each render.
  const outsideRefs = useMemo(() => [triggerRef, panelRef] as const, []);
  useClickOutside(outsideRefs, close, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="filter-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn--ghost filter-menu__trigger${isFiltered ? " filter-menu__trigger--active" : ""}`}
        title={isFiltered ? `Showing ${activeLabel} only` : "Filter by status"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="filter-menu__icon" aria-hidden="true">
          ⚙
        </span>
        Filters
        {isFiltered && (
          <>
            <span className="filter-menu__sep" aria-hidden="true">
              ·
            </span>
            <span className="filter-menu__current">{activeLabel}</span>
          </>
        )}
      </button>
      {open && (
        <div ref={panelRef} className="filter-menu__panel" role="menu">
          <div className="filter-menu__group-label">Status</div>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === opt.value}
              className={`filter-menu__option${value === opt.value ? " filter-menu__option--active" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span className="filter-menu__radio" aria-hidden="true">
                {value === opt.value ? "●" : "○"}
              </span>
              <span className="filter-menu__option-label">{opt.label}</span>
              {opt.count !== undefined && (
                <span className="filter-menu__option-count">{opt.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
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
  // Captured at load time for agents so the lifecycle button knows
  // which direction the toggle should go. Skills / mcps don't carry
  // this flag.
  const [agentDisabledByUser, setAgentDisabledByUser] = useState<boolean>(false);

  const [mode, setMode] = useState<EditMode>(target.kind === "mcp" ? "source" : "form");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
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
        skills: (meta.dependencies?.skills ?? []).map((d) => d.fqn),
        mcps: (meta.dependencies?.mcps ?? []).map((d) => d.fqn),
      });
      if ("agent" in detail) {
        setAgentDisabledByUser(detail.agent.disabledByUser);
      }
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAgentDisabled = async (): Promise<void> => {
    if (target.kind !== "agent") return;
    setToggling(true);
    setError(null);
    try {
      if (agentDisabledByUser) {
        await enableAgent(target.name);
        setAgentDisabledByUser(false);
      } else {
        await disableAgent(target.name);
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
            disabled={saving || loading || toggling}
          >
            {mode === "form" ? "Edit source →" : "← Back to form"}
          </button>
        )}
        {target.kind === "agent" && (
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
