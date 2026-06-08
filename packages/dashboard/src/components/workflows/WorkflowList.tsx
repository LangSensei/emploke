import type { WorkflowHeaderWire } from "../../api";
import { WorkflowListItem } from "./WorkflowListItem";

export interface WorkflowListProps {
  workflows: readonly WorkflowHeaderWire[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Page-supplied action callback. The list forwards it per-row so any
   *  row's `⋯` menu can cancel any workflow without selecting it first. */
  onCancel: (target: WorkflowHeaderWire) => void;
  /** Page-supplied single-open coordination. */
  openMenuId: string | null;
  onMenuOpenChange: (id: string | null) => void;
}

/**
 * Left-column workflow list. Thin labelled `<ul>` wrapper that
 * delegates row markup to {@link WorkflowListItem}. The `role="list"`
 * attribute is the Safari + VoiceOver workaround documented on
 * `components/schedules/ScheduleList.tsx`; jsdom does not replicate
 * the role-stripping behaviour, but Safari does. Page handles the
 * empty state (`pages/Workflows.tsx`) — the list never renders a "no
 * rows" placeholder itself.
 *
 * Row actions (`Cancel workflow`, `Copy ID`) are exposed via the
 * per-row `⋯` menu in `WorkflowListItem`. This list forwards the
 * page-level single-open coordination and cancel handler per row,
 * mirroring `ScheduleList`'s shape.
 */
export function WorkflowList({
  workflows,
  selectedId,
  onSelect,
  onCancel,
  openMenuId,
  onMenuOpenChange,
}: WorkflowListProps) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari + VoiceOver strip the implicit listitem role from <li> children when the <ul> has `list-style: none`. See components/schedules/ScheduleList.tsx for the parallel justification.
    <ul role="list" className="task-list" aria-label="Workflows">
      {workflows.map((w, idx, arr) => (
        <WorkflowListItem
          key={w.id}
          workflow={w}
          selected={selectedId === w.id}
          onSelect={() => onSelect(w.id)}
          onCancel={onCancel}
          menuOpen={openMenuId === w.id}
          onMenuOpenChange={(open) => onMenuOpenChange(open ? w.id : null)}
          posinset={idx + 1}
          setsize={arr.length}
        />
      ))}
    </ul>
  );
}
