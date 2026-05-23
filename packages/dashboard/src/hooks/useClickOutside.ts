import { type RefObject, useEffect } from "react";

/**
 * Closes a popover / menu when a pointerdown lands outside every supplied
 * element. Listens on `pointerdown` (not `click`) so the dismissal fires
 * before any inner button's click handler — matches the timing users
 * expect when clicking from one open menu directly onto another trigger.
 *
 * Only attaches the listener when `active` is true so closed popovers
 * don't pay the per-document-event cost.
 */
export function useClickOutside(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onOutside: () => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      for (const ref of refs) {
        const el = ref.current;
        if (el?.contains(target)) return;
      }
      onOutside();
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [refs, onOutside, active]);
}
