interface SettingsProps {
  serverUrl: string;
}

export function SettingsPage({ serverUrl }: SettingsProps) {
  return (
    <div className="card">
      <div className="card__header">
        <h3 className="card__title">Runtime</h3>
      </div>
      <dl className="kv-list">
        <dt>Server URL</dt>
        <dd>{serverUrl}</dd>

        <dt>Dashboard version</dt>
        <dd>0.0.1</dd>

        <dt>Build mode</dt>
        <dd>{import.meta.env.MODE}</dd>
      </dl>

      <div className="card__header" style={{ marginTop: 32 }}>
        <h3 className="card__title">Environment hints</h3>
      </div>
      <dl className="kv-list">
        <dt>EMPLOKE_CATALOG_DIR</dt>
        <dd>
          defaults to <code>~/.emploke/catalog</code>
        </dd>

        <dt>EMPLOKE_HOST</dt>
        <dd>
          defaults to <code>127.0.0.1</code> (loopback)
        </dd>

        <dt>PORT</dt>
        <dd>
          defaults to <code>3000</code>
        </dd>
      </dl>
      <p className="topbar__crumb" style={{ marginTop: 16 }}>
        Set <code>EMPLOKE_HOST=0.0.0.0</code> on the server to expose the dashboard on the local
        network (warning: enables destructive endpoints over LAN).
      </p>
    </div>
  );
}
