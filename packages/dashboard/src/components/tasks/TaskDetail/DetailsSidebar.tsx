import { useCallback, useState } from "react";
import type { TaskRecord } from "../../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../../utils/time";

export interface DetailsSidebarProps {
  task: TaskRecord;
}

/**
 * Right-rail vertical list of label → value rows for the Overview tab.
 *
 * Per mission-A scope: ONLY the fields available on the existing
 * `TaskRecord` shape. The mockup's `Workspace`, `Branch`, `Commit`,
 * and `PR` rows are deliberately omitted — those need mission B
 * (schema enrichment). Their absence is intentional, not an oversight.
 *
 * Bug-bash iter-1:
 *   - F8: drop `Status` / `Agent` / `Runtime` rows — the right-pane
 *     header already shows pills for those.
 *   - F9: `Started` uses the absolute timestamp as the primary value,
 *     relative time on hover (less ambiguous for ops/debug).
 *   - F4: `Task ID` renders monospace + nowrap with horizontal
 *     ellipsis; the copy button sits beside it (never breaking the
 *     id mid-string).
 */
export function DetailsSidebar({ task }: DetailsSidebarProps) {
  const duration =
    task.endedAt && task.startedAt
      ? formatDuration(task.startedAt, task.endedAt)
      : task.status === "running" && task.startedAt
        ? `running for ${formatDuration(task.startedAt, null)}`
        : null;
  return (
    <aside className="task-details">
      <h3 className="task-details__title">Metadata</h3>
      <dl className="task-details__list">
        {task.startedAt && (
          <Row
            label="Started"
            value={formatAbsolute(task.startedAt)}
            title={`${formatRelative(task.startedAt)} — ${task.startedAt}`}
          />
        )}
        {duration !== null && <Row label="Duration" value={duration} />}
        <Row
          label="Task ID"
          value={
            <span className="task-details__id-row">
              <code className="task-details__id" title={task.id}>
                {task.id}
              </code>
              <CopyButton text={task.id} label="Copy task id" />
            </span>
          }
        />
        <Row label="Origin" value={task.origin} />
      </dl>
    </aside>
  );
}

function Row({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <>
      <dt className="task-details__key">{label}</dt>
      <dd className={`task-details__val${mono ? " task-details__val--mono" : ""}`} title={title}>
        {value}
      </dd>
    </>
  );
}

/**
 * Tiny clipboard button. Uses the async Clipboard API when available
 * (every browser shipping in the dashboard's React 19 + Vite 8 era);
 * falls back to a soft no-op when not (e.g. `file://`-served preview).
 * The visual "Copied" state lives in local component state and self-
 * clears after 1.5s.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best-effort; the user can still select-and-copy the text.
    }
  }, [text]);
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon task-details__copy"
      onClick={onCopy}
      aria-label={label}
      title={copied ? "Copied" : label}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
