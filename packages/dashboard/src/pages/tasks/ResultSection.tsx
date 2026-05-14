import { useId, useState } from "react";

/**
 * Result section under the task header. Two visual states:
 *   - **collapsed**: word-bounded preview (~{@link RESULT_PREVIEW_CHARS}
 *     chars) + a "Show more" button. Rendered for results longer than
 *     the threshold; short results skip the toggle entirely.
 *   - **expanded**: full text + "Show less" button. The preview text
 *     is gone — only one state is visible at a time, unlike the
 *     `<details>`/`<summary>` element which forces the summary to stay
 *     on screen and ends up rendering BOTH preview and full content
 *     simultaneously.
 *
 * Cap chosen empirically from real Copilot session data: median final
 * answer ~1 KB / 15 lines, max ~4.8 KB / 54 lines; 600 chars (~10 lines
 * of typical text) keeps short answers inline and reins in the long
 * ones with one click. Expanded body is capped to 480px scroll so even
 * a 4 KB result can't push the activity timeline below the fold.
 */
const RESULT_PREVIEW_CHARS = 600;
export function ResultSection({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // ARIA disclosure pattern: button toggles a sibling region; the region's
  // id is referenced by the button's `aria-controls` so screen readers can
  // associate them. `useId` (React 19) gives a stable, collision-free id.
  const bodyId = useId();
  const isLong = text.length > RESULT_PREVIEW_CHARS;
  if (!isLong) {
    return (
      <section className="task-detail__result">
        <h3 className="task-detail__section-title">Result</h3>
        <p className="task-detail__result-body">{text}</p>
      </section>
    );
  }
  // Cut on a word boundary near the threshold for a cleaner preview.
  const cut = text.lastIndexOf(" ", RESULT_PREVIEW_CHARS);
  const preview = `${text.slice(0, cut > 0 ? cut : RESULT_PREVIEW_CHARS)}…`;
  return (
    <section className="task-detail__result">
      <h3 className="task-detail__section-title">Result</h3>
      {expanded ? (
        <p
          id={bodyId}
          className="task-detail__result-body"
          style={{ maxHeight: 480, overflowY: "auto" }}
        >
          {text}
        </p>
      ) : (
        <p id={bodyId} className="task-detail__result-body">
          {preview}
        </p>
      )}
      <button
        type="button"
        className="link-button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          marginTop: 6,
          background: "none",
          border: "none",
          color: "var(--color-link, #58a6ff)",
          cursor: "pointer",
          padding: 0,
          fontSize: 12,
        }}
      >
        {expanded ? "Show less" : `Show full (${text.length.toLocaleString()} chars)`}
      </button>
    </section>
  );
}
