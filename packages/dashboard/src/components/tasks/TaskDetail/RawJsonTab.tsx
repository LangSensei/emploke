import type { TaskRecord } from "../../../api";
import { CopyButton } from "./DetailsSidebar";

export interface RawJsonTabProps {
  task: TaskRecord;
}

/**
 * Raw JSON tab — pretty-printed full TaskRecord with a copy button.
 *
 * Replaces the old "Metadata" tab, which omitted top-level fields
 * (id, agent, status, timestamps) and the old "Raw JSON" tab, which
 * showed the activity payload instead. The mission-A spec calls for
 * the *full TaskRecord* here, so the two have been merged.
 */
export function RawJsonTab({ task }: RawJsonTabProps) {
  const json = JSON.stringify(task, null, 2);
  return (
    <div className="task-detail__body">
      <div className="raw-json__head">
        <CopyButton text={json} label="Copy raw JSON" />
      </div>
      <pre className="task-detail__events">{json}</pre>
    </div>
  );
}
