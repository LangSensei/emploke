import { createContext, useContext, useEffect } from "react";
import type { CatalogData, ServerConfig, WorkspaceListItem } from "../api";

/**
 * Shared data + setters provided by `WorkspaceShell` to every route
 * mounted under it. Route pages pull what they need via the typed hook
 * below instead of receiving prop drilled values from the layout —
 * with nested routes (React Router 6 + `<Outlet />`) prop drilling is
 * no longer possible across the parent/child boundary.
 */
export interface WorkspaceShellContextValue {
  /** Workspace UUID from the URL. Always non-empty inside the shell. */
  wsId: string;
  /**
   * The registered-workspace list. `null` while the very first fetch is
   * in flight; an empty array means the registry has zero entries.
   */
  workspaces: WorkspaceListItem[] | null;
  /** Workspace-scoped catalog data (overview, agents, skills, mcps). */
  data: CatalogData;
  /** Server config; `null` while the one-shot fetch hasn't resolved. */
  config: ServerConfig | null;
  /** Trigger a fresh catalog/overview fetch. */
  refreshData: () => Promise<void>;
}

export const WorkspaceShellContext = createContext<WorkspaceShellContextValue | null>(null);

/** Type-safe context accessor — throws on accidental render outside the shell. */
export function useWorkspaceShell(): WorkspaceShellContextValue {
  const v = useContext(WorkspaceShellContext);
  if (v === null) {
    throw new Error("useWorkspaceShell must be used inside <WorkspaceShell>");
  }
  return v;
}

/**
 * Breadcrumb chain rendered by `TopBar`. Pages declare their crumb by
 * calling `useBreadcrumb([...])`; the chain is reset on unmount so the
 * next page sees a clean slate (the shell falls back to a default
 * derived from the current URL section).
 *
 * Title is the prominent H1; chain is the small muted line under it.
 * Both are text-only — no clickable navigation in this round.
 */
export interface BreadcrumbValue {
  title: string;
  chain: readonly string[];
}

export interface BreadcrumbContextValue {
  set: (value: BreadcrumbValue | null) => void;
}

export const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

/**
 * Declarative breadcrumb declaration for a page. Re-runs whenever the
 * stringified inputs change (cheap join keyed comparison) so dynamic
 * crumbs (e.g. agent name) stay in sync without manual deps.
 */
export function useBreadcrumb(title: string, chain: readonly string[]): void {
  const ctx = useContext(BreadcrumbContext);
  const serialised = chain.join("\u0001");
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialised stands in for chain
  useEffect(() => {
    if (!ctx) return;
    ctx.set({ title, chain });
    return () => ctx.set(null);
  }, [title, serialised, ctx]);
}
