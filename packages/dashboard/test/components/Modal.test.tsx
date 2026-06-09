/**
 * Coverage for the `<dialog>` accessible-name wiring on the Modal.
 * Two attribute paths exist:
 *
 *   1. Default: `title` forwards to `aria-label` so every existing
 *      caller (which already passes a sensible title) gets an
 *      accessible name for free, with no API change.
 *   2. Opt-in: `ariaLabelledBy` lets a caller whose header is richer
 *      than a plain title (kind icon + fqn + status pill, etc.) point
 *      AT to a programmatic heading id. When set, `aria-labelledby`
 *      wins per ARIA spec and `aria-label` is omitted to avoid the
 *      two-name-source conflict.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/components/Modal";

afterEach(() => cleanup());

describe("Modal — accessible name", () => {
  it("forwards `title` as the dialog's aria-label by default", () => {
    render(
      <Modal open title="Cancel workflow?" onClose={vi.fn()}>
        body
      </Modal>,
    );
    const dlg = screen.getByRole("dialog", { hidden: true });
    expect(dlg.getAttribute("aria-label")).toBe("Cancel workflow?");
    expect(dlg.getAttribute("aria-labelledby")).toBeNull();
  });

  it("prefers `ariaLabelledBy` over `title` when provided, and omits aria-label", () => {
    render(
      <Modal open title="ignored" ariaLabelledBy="my-heading-id" onClose={vi.fn()}>
        <h2 id="my-heading-id">Rich heading</h2>
      </Modal>,
    );
    const dlg = screen.getByRole("dialog", { hidden: true });
    expect(dlg.getAttribute("aria-labelledby")).toBe("my-heading-id");
    expect(dlg.hasAttribute("aria-label")).toBe(false);
  });
});
