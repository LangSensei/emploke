import { useId, useState } from "react";

/**
 * Detail-header instructions with collapse-by-default for long
 * inputs. Short instructions render plain (the existing 4-line CSS
 * clamp is enough); long ones use a button + state toggle so the
 * user can expand to read the full text without the header eating
 * half the viewport.
 *
 * Toggle uses the same button + state pattern as `ResultSection` /
 * `ToolDisplay` rather than `<details>/<summary>`: the latter
 * forces the summary to stay on screen, so opening the disclosure
 * would render BOTH the preview and the full content at once.
 *
 * The tag-line below the form already serves as the task's
 * persistent "title"; the unmutable instructions are the source of
 * truth, not a runtime-derived preview (which would be unstable
 * and shift every poll). See the comment in TaskDetail's render.
 */
const TASK_INSTRUCTIONS_PREVIEW_CHARS = 320;
export function TaskInstructions({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const isLong = text.length > TASK_INSTRUCTIONS_PREVIEW_CHARS;
  if (!isLong) {
    return (
      <p className="task-detail__instructions" title={text}>
        {text}
      </p>
    );
  }
  // Cut on a word boundary near the threshold for a cleaner preview.
  const cut = text.lastIndexOf(" ", TASK_INSTRUCTIONS_PREVIEW_CHARS);
  const preview = `${text.slice(0, cut > 0 ? cut : TASK_INSTRUCTIONS_PREVIEW_CHARS)}…`;
  return (
    <div>
      {expanded ? (
        <p
          id={bodyId}
          className="task-detail__instructions"
          title={text}
          style={{ WebkitLineClamp: "unset", maxHeight: 320, overflowY: "auto" }}
        >
          {text}
        </p>
      ) : (
        <p id={bodyId} className="task-detail__instructions" title={text}>
          {preview}
        </p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          marginTop: 4,
          background: "none",
          border: "none",
          color: "var(--color-link, #58a6ff)",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
        }}
      >
        {expanded ? "Show less" : `Show full (${text.length.toLocaleString()} chars)`}
      </button>
    </div>
  );
}
