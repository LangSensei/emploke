import type { WorkflowHeaderWire } from "../../api";
import { WorkflowListItem } from "./WorkflowListItem";

export interface WorkflowListProps {
  workflows: readonly WorkflowHeaderWire[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Left-column workflow list. Thin labelled `<ul>` wrapper that
 * delegates row markup to {@link WorkflowListItem}. The `role="list"`
 * attribute is the Safari + VoiceOver workaround documented on
 * `components/schedules/ScheduleList.tsx`; jsdom does not replicate
 * the role-stripping behaviour, but Safari does. Page handles the
 * empty state (`pages/Workflows.tsx`) — the list never renders a "no
 * rows" placeholder itself.
 */
export function WorkflowList({ workflows, selectedId, onSelect }: WorkflowListProps) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari + VoiceOver strip the implicit listitem role from <li> children when the <ul> has `list-style: none`. See components/schedules/ScheduleList.tsx for the parallel justification.
    <ul role="list" className="task-list" aria-label="Workflows">
      {workflows.map((w, idx, arr) => (
        <WorkflowListItem
          key={w.id}
          workflow={w}
          selected={selectedId === w.id}
          onSelect={() => onSelect(w.id)}
          posinset={idx + 1}
          setsize={arr.length}
        />
      ))}
    </ul>
  );
}
