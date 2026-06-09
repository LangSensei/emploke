/**
 * Test helper: install a prototype-level override for
 * `Element.prototype.getBoundingClientRect` keyed by `data-testid`.
 *
 * happy-dom returns all zeros from `getBoundingClientRect` by default,
 * which would make every viewport-aware placement test trivially pick
 * "below" (zero panel height ⇒ infinite spare space). Installing a
 * keyed spy lets a test craft the exact geometry it needs (trigger
 * rects, panel height, next-sibling rects, …) so the
 * placement/measurement logic under test actually runs against
 * meaningful numbers instead of the all-zero default.
 *
 * Usage:
 *   const restore = installRectSpy(new Map([
 *     ["panel-id", { height: 200 }],
 *     ["trigger-id", { top: 50, bottom: 100, height: 50 }],
 *   ]));
 *   try {
 *     render(<Component />);
 *     // assertions …
 *   } finally {
 *     restore();
 *   }
 *
 * Elements without a matching `data-testid` fall through to the
 * original (unmodified) `getBoundingClientRect`.
 */
export function installRectSpy(map: Map<string, Partial<DOMRect>>): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = (this as HTMLElement).dataset?.testid;
    const override = key ? map.get(key) : undefined;
    if (!override) return original.call(this);
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      toJSON: () => ({}),
      ...override,
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}
