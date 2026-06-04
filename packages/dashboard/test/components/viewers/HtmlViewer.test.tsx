import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import HtmlViewer from "../../../src/components/viewers/HtmlViewer";

afterEach(() => cleanup());

/**
 * Tests for the per-artifact "Run scripts" toggle (#304).
 *
 * The viewer's contract:
 *   - Default `sandbox=""` (maximum restriction, no scripts).
 *   - Toggle ON → re-mount iframe with `sandbox="allow-scripts"`.
 *     `allow-same-origin` is deliberately NOT granted — combined
 *     with `allow-scripts` on a same-origin srcDoc iframe it would
 *     let the artifact read/mutate the parent DOM. The regression
 *     guard below asserts the token is absent.
 *   - Toggle MUST reset to OFF whenever `filename` changes so the
 *     elevated sandbox never carries into a different artifact.
 *
 * Sandbox is read via `getAttribute('sandbox')` — that's what's
 * actually committed to the DOM (and what the browser uses to make
 * its security decision).
 */

const iframeFor = (filename: string): HTMLIFrameElement =>
  screen.getByTitle(`Preview of ${filename}`) as HTMLIFrameElement;

const runScriptsToggle = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: /Run scripts/i }) as HTMLInputElement;

describe("HtmlViewer", () => {
  it("defaults to a fully locked-down sandbox (sandbox='')", () => {
    render(<HtmlViewer filename="report.html" content="<p>hi</p>" />);
    const iframe = iframeFor("report.html");
    expect(iframe.hasAttribute("sandbox")).toBe(true);
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(runScriptsToggle().checked).toBe(false);
  });

  it("re-mounts the iframe with allow-scripts (and NOT allow-same-origin) when the toggle is flipped ON", () => {
    render(<HtmlViewer filename="deck.html" content="<p>slides</p>" />);
    expect(iframeFor("deck.html").getAttribute("sandbox")).toBe("");

    fireEvent.click(runScriptsToggle());

    const iframe = iframeFor("deck.html");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    // Explicit regression guard: `allow-same-origin` combined with
    // `allow-scripts` on a same-origin srcDoc iframe is a sandbox
    // escape. If a future change tries to add it back, this fails.
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(runScriptsToggle().checked).toBe(true);
  });

  it("resets the toggle to OFF when the selected artifact (filename) changes", () => {
    const { rerender } = render(<HtmlViewer filename="a.html" content="<p>A</p>" />);

    // Flip ON for artifact A.
    fireEvent.click(runScriptsToggle());
    expect(iframeFor("a.html").getAttribute("sandbox")).toBe("allow-scripts");

    // Re-render with a DIFFERENT artifact. The toggle MUST snap back
    // to OFF — the elevated sandbox does not silently carry over.
    rerender(<HtmlViewer filename="b.html" content="<p>B</p>" />);

    expect(iframeFor("b.html").getAttribute("sandbox")).toBe("");
    expect(runScriptsToggle().checked).toBe(false);
  });

  it("round-trips ON → OFF → ON without error", () => {
    render(<HtmlViewer filename="x.html" content="<p>x</p>" />);

    fireEvent.click(runScriptsToggle()); // ON
    expect(iframeFor("x.html").getAttribute("sandbox")).toBe("allow-scripts");

    fireEvent.click(runScriptsToggle()); // OFF
    expect(iframeFor("x.html").getAttribute("sandbox")).toBe("");

    fireEvent.click(runScriptsToggle()); // ON again
    expect(iframeFor("x.html").getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("passes the content prop verbatim into the iframe's srcDoc", () => {
    // Use an inert payload — happy-dom parses srcdoc and would try to
    // run any <script> tag. The verbatim-passthrough check only needs
    // the string to round-trip, not execute.
    const html = '<h1>Hello &amp; world</h1><p data-marker="abc">body</p>';
    render(<HtmlViewer filename="x.html" content={html} />);
    // happy-dom lowercases attribute names from JSX; `srcDoc` lands as `srcdoc`.
    expect(iframeFor("x.html").getAttribute("srcdoc")).toBe(html);
  });

  it("describes the toggle for screen readers via aria-describedby", () => {
    render(<HtmlViewer filename="x.html" content="<p>x</p>" />);
    const checkbox = runScriptsToggle();
    const descId = checkbox.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    const desc = document.getElementById(descId as string);
    expect(desc).not.toBeNull();
    // Description must mention the elevated sandbox value AND the
    // trust caveat so a screen-reader user understands the risk.
    expect(desc?.textContent).toMatch(/allow-scripts/);
    expect(desc?.textContent).toMatch(/trust/i);
  });
});
