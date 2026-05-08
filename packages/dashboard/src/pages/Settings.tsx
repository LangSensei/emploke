import type { ServerConfig, WorkspaceListItem } from "../api";

interface SettingsProps {
  serverUrl: string;
  config: ServerConfig | null;
  currentWorkspace: string | null;
  workspaces: WorkspaceListItem[];
}

export function SettingsPage({ serverUrl, config, currentWorkspace, workspaces }: SettingsProps) {
  const fmt = (v: string | number | undefined | null) => (v == null ? "—" : String(v));
  const currentEntry = workspaces.find((w) => w.name === currentWorkspace);

  return (
    <div className="card">
      <div className="card__header">
        <h3 className="card__title">Runtime</h3>
      </div>
      <dl className="kv-list">
        <dt>Server URL</dt>
        <dd>{serverUrl}</dd>

        <dt>Host</dt>
        <dd>
          <code>{fmt(config?.host)}</code>
        </dd>

        <dt>Port</dt>
        <dd>
          <code>{fmt(config?.port)}</code>
        </dd>

        <dt>Dashboard version</dt>
        <dd>0.0.1</dd>

        <dt>Build mode</dt>
        <dd>{import.meta.env.MODE}</dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Paths</h3>
      </div>
      <dl className="kv-list">
        <dt>Emploke home</dt>
        <dd>
          <code>{fmt(config?.emplokeHome)}</code>
        </dd>

        <dt>Catalog directory</dt>
        <dd>
          <code>{fmt(config?.catalogDir)}</code>
        </dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Workspace</h3>
      </div>
      <dl className="kv-list">
        <dt>Current workspace</dt>
        <dd>
          <code>{fmt(currentWorkspace)}</code>
          {currentEntry?.metadata?.name && currentEntry.metadata.name !== currentWorkspace && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              (workspace.json declares "{currentEntry.metadata.name}")
            </span>
          )}
        </dd>

        <dt>Workspace path</dt>
        <dd>
          <code>{fmt(currentEntry?.path)}</code>
        </dd>

        <dt>Registered workspaces</dt>
        <dd>
          <code>{workspaces.length}</code>
        </dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Environment hints</h3>
      </div>
      <dl className="kv-list">
        <dt>EMPLOKE_HOME</dt>
        <dd>overrides the user-level emploke root (default ~/.emploke)</dd>

        <dt>EMPLOKE_CATALOG_DIR</dt>
        <dd>overrides the catalog directory (default $EMPLOKE_HOME/catalog)</dd>

        <dt>EMPLOKE_WORKSPACE</dt>
        <dd>workspace dir to open at startup (default $EMPLOKE_HOME/workspaces/default)</dd>

        <dt>EMPLOKE_HOST</dt>
        <dd>overrides the bind host shown above</dd>

        <dt>PORT</dt>
        <dd>overrides the port shown above</dd>
      </dl>
      <p className="topbar__crumb" style={{ marginTop: 16 }}>
        Set <code>EMPLOKE_HOST=0.0.0.0</code> on the server to expose the dashboard on the local
        network (warning: enables destructive endpoints over LAN).
      </p>
    </div>
  );
}
