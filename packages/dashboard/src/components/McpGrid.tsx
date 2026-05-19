import type { McpItem } from "../api";
import { EntryGrid } from "./EntryGrid";

interface McpGridProps {
  mcps: McpItem[];
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}

/**
 * MCP-specific facade over {@link EntryGrid}. Maps the lean `McpItem`
 * shape into the richer `EntryCardItem` shape:
 *   - description / version are empty (mcps don't carry these in the
 *     manifest) — EntryCard suppresses the chip when the value is "".
 *   - skillsCount / mcpsCount are -1 — EntryCard treats negative as
 *     "opt out" so the meta strip skips dep counts entirely.
 *   - status is computed from `orphaned`: orphaned mcps were dropped
 *     by their last referrer's sync and are now unreachable.
 */
export function McpGrid({ mcps, onEdit, onRemove }: McpGridProps) {
  return (
    <EntryGrid
      kind="mcp"
      items={mcps.map((m) => ({
        name: m.fqn,
        description: "",
        version: "",
        status: m.orphaned ? ("blocked" as const) : ("ready" as const),
        ...(m.orphaned ? { blockedReason: { orphaned: true as const } } : {}),
        skillsCount: -1,
        mcpsCount: -1,
      }))}
      emptyTitle="No MCPs installed"
      emptyHint="MCPs are JSON server configs referenced by skills/agents."
      onEdit={onEdit}
      onRemove={onRemove}
    />
  );
}
