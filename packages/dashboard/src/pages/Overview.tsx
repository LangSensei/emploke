import type { OverviewData } from "../api";

interface OverviewProps {
  overview: OverviewData | null;
}

export function OverviewPage({ overview }: OverviewProps) {
  if (!overview) {
    return <div className="empty">Loading...</div>;
  }
  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 32 }}>
        <Stat label="Skills" value={overview.counts.skills} />
        <Stat label="Agents" value={overview.counts.agents} />
        <Stat label="MCPs" value={overview.counts.mcps} />
        <Stat label="Disabled" value={overview.counts.disabled} warn />
      </div>

      <div className="card">
        <div className="card__header">
          <h3 className="card__title">⚠️ Scan Issues</h3>
        </div>
        {overview.issues.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <div className="empty__icon">✓</div>
            <h3 className="empty__title">No scan issues</h3>
            <p className="empty__hint">Catalog scanned cleanly.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {overview.issues.map((i) => (
                <tr key={i.path}>
                  <td className="name-cell">{i.path}</td>
                  <td className="desc-cell">{i.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="stat">
      <div className={`stat__value${warn && value > 0 ? " stat__value--warn" : ""}`}>{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}
