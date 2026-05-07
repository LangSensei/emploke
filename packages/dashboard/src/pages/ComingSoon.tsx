interface ComingSoonProps {
  title: string;
  description: string;
  hint?: string;
}

export function ComingSoonPage({ title, description, hint }: ComingSoonProps) {
  return (
    <div className="empty" style={{ padding: 64 }}>
      <div className="empty__icon">🚧</div>
      <h3 className="empty__title">{title} — coming soon</h3>
      <p className="empty__hint">{description}</p>
      {hint && (
        <p className="empty__hint" style={{ marginTop: 12, fontStyle: "italic" }}>
          {hint}
        </p>
      )}
    </div>
  );
}
