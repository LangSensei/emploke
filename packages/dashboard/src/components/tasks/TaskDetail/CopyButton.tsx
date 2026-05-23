import { useCallback, useState } from "react";
import { CheckIcon, CopyIcon } from "../../Icons";

/**
 * Tiny clipboard button. Uses the async Clipboard API when available
 * (every browser shipping in the dashboard's React 19 + Vite 8 era);
 * falls back to a soft no-op when not (e.g. `file://`-served preview).
 * The visual "Copied" state lives in local component state and self-
 * clears after 1.5s.
 *
 * Iter-2 F4: render the action with SVG icons (`CopyIcon` / `CheckIcon`)
 * instead of the text glyphs `⧉` / `✓` — those did not render
 * consistently across fonts/platforms (wrong glyph, missing, or too
 * wide).
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
    <span className="task-details__copy-wrap">
      <button
        type="button"
        className="btn btn--ghost btn--icon task-details__copy"
        onClick={onCopy}
        aria-label={label}
        title={copied ? "Copied" : label}
      >
        {copied ? (
          <CheckIcon className="task-details__copy-icon" />
        ) : (
          <CopyIcon className="task-details__copy-icon" />
        )}
      </button>
      {/* Sibling live region whose text content actually changes — the
          button's accessible name comes from aria-label and is static,
          so aria-live on the button itself announced nothing. */}
      <span className="visually-hidden" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
