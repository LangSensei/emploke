import type { ServerConfig, WorkspaceListItem } from "../api";
import { InfoIcon } from "../components/Icons";

interface SettingsProps {
  serverUrl: string;
  config: ServerConfig | null;
  /** UUID of the workspace currently in scope (from the URL), or null. */
  currentWorkspaceId: string | null;
  workspaces: WorkspaceListItem[];
}

/**
 * Tiny inline icon + custom CSS tooltip for env-var hints. We render the
 * hint text as a child bubble (rather than relying on the browser's native
 * `title`) so it appears immediately on hover / focus instead of after
 * the platform's ~1s delay, and so we control its styling.
 */
function EnvHint({ children }: { children: string }) {
  return (
    <span className="env-hint">
      <button
        type="button"
        className="env-hint__trigger"
        aria-label={children}
        // Click is a no-op; the element exists purely to surface the
        // tooltip on hover/focus. Using <button> keeps it natively
        // focusable so keyboard users can read the hint too.
        onClick={(e) => e.preventDefault()}
      >
        <InfoIcon className="env-hint__icon" />
      </button>
      <span className="env-hint__bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}

export function SettingsPage({ serverUrl, config, currentWorkspaceId, workspaces }: SettingsProps) {
  const fmt = (v: string | number | undefined | null) => (v == null ? "—" : String(v));
  const currentEntry = workspaces.find((w) => w.id === currentWorkspaceId);
  const displayName = currentEntry?.name ?? null;

  return (
    <div className="card">
      <div className="card__header">
        <h3 className="card__title">Runtime</h3>
      </div>
      <dl className="kv-list">
        <dt>Server URL</dt>
        <dd>{serverUrl}</dd>

        <dt>
          Host <EnvHint>Override with EMPLOKE_HOST (default 127.0.0.1).</EnvHint>
        </dt>
        <dd>
          <code>{fmt(config?.host)}</code>
        </dd>

        <dt>
          Port <EnvHint>Override with PORT (default 8787).</EnvHint>
        </dt>
        <dd>
          <code>{fmt(config?.port)}</code>
        </dd>

        <dt>Build mode</dt>
        <dd>{import.meta.env.MODE}</dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Paths</h3>
      </div>
      <dl className="kv-list">
        <dt>
          Emploke home <EnvHint>Override with EMPLOKE_HOME (default ~/.emploke).</EnvHint>
        </dt>
        <dd>
          <code>{fmt(config?.emplokeHome)}</code>
        </dd>

        <dt>Workspace catalog</dt>
        <dd>
          {currentEntry ? (
            <code>
              {currentEntry.workspaceDir}
              {config?.pathSeparator ?? "/"}catalog
            </code>
          ) : (
            <span className="muted">—</span>
          )}
        </dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Workspace</h3>
      </div>
      <dl className="kv-list">
        <dt>
          Display name{" "}
          <EnvHint>
            Free-form text from the workspace metadata row. Edit via the sidebar's pencil icon.
          </EnvHint>
        </dt>
        <dd>
          <code>{fmt(displayName)}</code>
        </dd>

        <dt>
          Workspace id{" "}
          <EnvHint>
            Opaque UUID assigned at creation; the URL routing key. Stable for the lifetime of the
            workspace.
          </EnvHint>
        </dt>
        <dd>
          <code>{fmt(currentWorkspaceId)}</code>
        </dd>

        <dt>Workspace path</dt>
        <dd>
          <code>{fmt(currentEntry?.workspaceDir)}</code>
        </dd>

        <dt>Registered workspaces</dt>
        <dd>
          <code>{workspaces.length}</code>
        </dd>
      </dl>

      <p className="topbar__crumb" style={{ marginTop: 16 }}>
        emploke binds to <code>127.0.0.1</code> and ships no built-in auth. For remote access,
        expose the loopback socket through SSH port-forward, a reverse proxy, or a mesh VPN.
      </p>
    </div>
  );
}
