import type { ServerConfig } from "../api";

interface SettingsProps {
  serverUrl: string;
  config: ServerConfig | null;
}

export function SettingsPage({ serverUrl, config }: SettingsProps) {
  const fmt = (v: string | number | undefined | null) => (v == null ? "—" : String(v));

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
        <dt>Catalog directory</dt>
        <dd>
          <code>{fmt(config?.catalogDir)}</code>
        </dd>

        <dt>Sessions root</dt>
        <dd>
          <code>{fmt(config?.sessionsRoot)}</code>
        </dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Environment hints</h3>
      </div>
      <dl className="kv-list">
        <dt>EMPLOKE_CATALOG_DIR</dt>
        <dd>overrides the catalog directory shown above</dd>

        <dt>EMPLOKE_SESSIONS_DIR</dt>
        <dd>overrides the sessions root shown above</dd>

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
