/**
 * Shared agent avatar primitive — coloured monogram square used by the
 * Agents-list row, the AgentDetailPane header, and any future
 * agent-mention chip.
 *
 * Design contract (locked by tests):
 *
 *   - **Background colour** is a deterministic hash of the FULL `fqn`
 *     (`scope/short`). Two agents that share a short name but live in
 *     different scopes (e.g. `langsensei/dev` vs `acme/dev`) MUST resolve
 *     to different palette entries — that disambiguation is the avatar's
 *     primary job, alongside the rendered FQN text. Hashing just `label`
 *     would defeat the property, so don't refactor in that direction
 *     without updating the lock-in tests in `AgentAvatar.test.tsx`.
 *
 *   - **Monogram** is derived from `label` only. Two-segment rule:
 *     split the label on `-` or `_` and take the first character of
 *     each of the first two segments (`agent-distill` → `AD`,
 *     `code_review` → `CR`). Single-segment labels collapse to the
 *     first two letters (`dev` → `DE`, `qa` → `QA`); a one-letter
 *     label renders just that letter. The scope NEVER contributes to
 *     the monogram so the scope-disambiguation signal stays in the
 *     background colour + the rendered FQN text, not in the letters.
 *
 *   - **Foreground colour** is computed from background luminance —
 *     white when the bg's relative luminance is below 0.55, dark text
 *     otherwise. Keeps WCAG-friendly contrast across the palette.
 *
 *   - **Sizes** map to fixed pixel boxes so consumers can rely on a
 *     stable footprint inside flex/grid layouts:
 *       sm = 24 px (chips, mentions),
 *       md = 40 px (list rows, default),
 *       lg = 56 px (detail pane header).
 */

export type AgentAvatarSize = "sm" | "md" | "lg";

export interface AgentAvatarProps {
  /** Full FQN (`scope/short`); drives the deterministic colour hash. */
  fqn: string;
  /** Short label (typically the agent's short name); drives the monogram. */
  label: string;
  /** Pixel size preset. Defaults to `"md"` (40px square). */
  size?: AgentAvatarSize;
}

/**
 * Curated 8-colour accent palette. Hex values let us compute readable
 * foreground via the relative-luminance test without touching the CSS
 * custom-property layer (computed-style lookups on `var(--…)` are unreliable
 * inside happy-dom, and the readable-fg logic is part of the locked
 * component contract). The hues are spaced across the design-token
 * accent family — blue / indigo / teal / green / amber / orange /
 * rose / violet — so adjacent rows in the list stay visually distinct.
 */
const AVATAR_PALETTE: readonly string[] = [
  "#2563eb", // blue   (matches --color-accent)
  "#4f46e5", // indigo
  "#0d9488", // teal
  "#15803d", // green  (matches --color-success)
  "#b45309", // amber  (matches --color-warn)
  "#ea580c", // orange
  "#be123c", // rose
  "#7c3aed", // violet
];

/**
 * FNV-ish 32-bit string hash. Deterministic across renders / sessions /
 * clients so the same fqn always yields the same colour. Exported so the
 * tests can pin specific fqns to specific palette indices.
 */
export function hashFqn(fqn: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < fqn.length; i++) {
    h ^= fqn.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Deterministic colour pick for an agent's full FQN. */
export function avatarColorForFqn(fqn: string): string {
  return AVATAR_PALETTE[hashFqn(fqn) % AVATAR_PALETTE.length] as string;
}

/**
 * Relative luminance of a `#rrggbb` colour, per WCAG 2.x. Used to pick
 * a readable foreground; the threshold 0.55 was chosen so the cooler
 * blue/indigo/teal/violet entries get white text while amber/orange
 * (light on the eye) get dark text.
 */
function relativeLuminance(hex: string): number {
  const norm = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = Number.parseInt(norm.slice(0, 2), 16) / 255;
  const g = Number.parseInt(norm.slice(2, 4), 16) / 255;
  const b = Number.parseInt(norm.slice(4, 6), 16) / 255;
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const LUMINANCE_THRESHOLD = 0.55;
const READABLE_DARK = "#0f172a";
const READABLE_LIGHT = "#ffffff";

/**
 * Pick a foreground colour that reads cleanly on `bg`. White on dark
 * backgrounds, near-black on light ones.
 */
export function readableTextOn(bg: string): string {
  return relativeLuminance(bg) < LUMINANCE_THRESHOLD ? READABLE_LIGHT : READABLE_DARK;
}

/**
 * Derive the 1- or 2-letter monogram from `label`. Rule documented in
 * the file header; locked by `AgentAvatar.test.tsx`.
 *
 * Examples:
 *   - `dev` → `DE`
 *   - `agent-distill` → `AD`
 *   - `code_review` → `CR`
 *   - `a` → `A`
 *   - `` → `?` (defensive fallback for a malformed label)
 */
export function monogramForLabel(label: string): string {
  const segments = label.split(/[-_]/).filter((s) => s.length > 0);
  if (segments.length === 0) return "?";
  if (segments.length >= 2) {
    const a = segments[0]?.[0] ?? "";
    const b = segments[1]?.[0] ?? "";
    return (a + b).toUpperCase();
  }
  const only = segments[0] ?? "";
  return only.slice(0, 2).toUpperCase();
}

const SIZE_PX: Record<AgentAvatarSize, number> = {
  sm: 24,
  md: 40,
  lg: 56,
};

/**
 * Coloured monogram avatar for an agent. See file header for contract.
 */
export function AgentAvatar({ fqn, label, size = "md" }: AgentAvatarProps) {
  const bg = avatarColorForFqn(fqn);
  const fg = readableTextOn(bg);
  const monogram = monogramForLabel(label);
  const px = SIZE_PX[size];
  return (
    <span
      className={`agent-avatar agent-avatar--${size}`}
      style={{
        backgroundColor: bg,
        color: fg,
        width: `${px}px`,
        height: `${px}px`,
      }}
      role="img"
      aria-label={`Agent ${fqn}`}
      data-testid={`agent-avatar-${fqn}`}
    >
      {monogram}
    </span>
  );
}
