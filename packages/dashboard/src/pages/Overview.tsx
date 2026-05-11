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
        <Stat label="Agents" value={overview.counts.agents} />
        <Stat label="Skills" value={overview.counts.skills} />
        <Stat label="MCPs" value={overview.counts.mcps} />
        <Stat label="Disabled" value={overview.counts.disabled} warn />
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
