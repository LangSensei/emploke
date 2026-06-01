import { useEffect, useState } from "react";
import { previewCron, type SchedulePreview } from "../../api";

const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_COUNT = 5;

export interface UseSchedulePreviewArgs {
  /**
   * Whether the preview effect should run. Pass `open` from the
   * modal — when `false`, the hook is a no-op so a closed modal
   * doesn't fetch on every parent re-render.
   */
  enabled: boolean;
  /** Cron expression (already derived from the active preset). */
  expr: string;
  /** IANA timezone. Empty string short-circuits the fetch. */
  tz: string;
  /**
   * Local validation result for the active preset (`null` when
   * structurally valid). Non-null short-circuits the fetch — no
   * point pinging the server with known-bad inputs.
   */
  presetError: string | null;
}

export interface UseSchedulePreviewResult {
  preview: SchedulePreview | null;
  previewLoading: boolean;
  previewError: string | null;
}

/**
 * Live cron preview hook — owned by `CreateScheduleModal` and
 * `EditScheduleModal`. Wraps a 300ms-debounced `previewCron`
 * round-trip with a per-call `AbortController` so a stale response
 * from a slow earlier request cannot clobber a newer preview AND
 * the underlying `fetch` is cancelled at the network layer (no
 * wasted server work on every keystroke).
 *
 * Short-circuits on: `enabled === false` (modal closed),
 * `presetError !== null` (local validation failed), `tz === ""` (no
 * timezone chosen yet).
 *
 * Extracted from the byte-for-byte duplicate effect that lived in
 * both modals — TN-B F1-3 audit.
 */
export function useSchedulePreview({
  enabled,
  expr,
  tz,
  presetError,
}: UseSchedulePreviewArgs): UseSchedulePreviewResult {
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (presetError !== null) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    if (tz === "") {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setPreviewLoading(true);
    const handle = setTimeout(() => {
      previewCron({ expr, tz, n: PREVIEW_COUNT }, ctrl.signal)
        .then((p) => {
          if (ctrl.signal.aborted) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          // `AbortError` is the expected reject path when the effect
          // cleanup runs `ctrl.abort()`; silently swallow it so the
          // modal doesn't flash a misleading "preview failed" on
          // every keystroke.
          if (e instanceof Error && e.name === "AbortError") return;
          if (ctrl.signal.aborted) return;
          setPreview(null);
          setPreviewError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setPreviewLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [enabled, expr, tz, presetError]);

  return { preview, previewLoading, previewError };
}
