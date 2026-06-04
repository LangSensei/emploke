import { useState } from "react";
import type { ViewerProps } from "./types";

/**
 * HTML preview — rendered inside an `<iframe>` with a per-artifact
 * "Run scripts" toggle.
 *
 * The viewer has two modes:
 *
 * 1. **Locked-down (default)** — `sandbox=""` (empty attribute) is the
 *    maximum-restriction form: no scripts, no same-origin, no forms,
 *    no top navigation, no plugins, no popups. A malicious artifact
 *    therefore cannot exfiltrate cookies, navigate the parent, or run
 *    JS in the dashboard origin.
 * 2. **Run scripts (opt-in)** — user-toggled. The iframe is re-mounted
 *    with `sandbox="allow-scripts"` so HTML artifacts that ship
 *    intentional client-side behavior (Reveal.js decks, Chart.js
 *    figures, interactive demos) actually render. `allow-same-origin`
 *    is deliberately NOT granted: combined with `allow-scripts` on a
 *    same-origin `srcDoc` iframe it would inherit the dashboard
 *    origin and let the artifact read/mutate the parent DOM and
 *    issue credentialed fetches against the dashboard. Pure
 *    `allow-scripts` gives the iframe an opaque origin — scripts
 *    (inline + CDN) still run, network fetches still work, but the
 *    iframe cannot reach the parent.
 *
 * Invariants:
 *
 * - First render of any artifact is always locked-down — the toggle
 *   defaults to OFF.
 * - When the selected artifact changes (`filename` prop changes) the
 *   toggle MUST reset to OFF. The elevated sandbox never silently
 *   carries into a different file the user has not opted in for.
 *   This is enforced by wrapping the body in `<HtmlViewerInner>` keyed
 *   on `filename`: React unmounts the old instance and mounts a fresh
 *   one with `scriptsEnabled=false` whenever the file changes.
 * - The iframe is re-mounted (via `key`) whenever the sandbox value
 *   changes — React's reconciliation does not reliably re-apply the
 *   `sandbox` attribute on an already-rendered iframe across browsers,
 *   so a full remount is the only safe way to flip modes.
 *
 * The iframe height is clamped via CSS so a giant HTML report doesn't
 * blow out the layout — the iframe itself scrolls.
 */
export default function HtmlViewer(props: ViewerProps) {
  // The `key={filename}` here is the per-artifact reset seam: when the
  // user switches to a different artifact, React unmounts the inner
  // component and remounts it fresh, so `scriptsEnabled` reliably
  // starts at `false` — no race window where the elevated sandbox
  // briefly applies to a different file's content.
  return <HtmlViewerInner key={props.filename} {...props} />;
}

function HtmlViewerInner({ content, filename }: ViewerProps) {
  const html = typeof content === "string" ? content : "";
  const [scriptsEnabled, setScriptsEnabled] = useState(false);

  const sandboxValue = scriptsEnabled ? "allow-scripts" : "";
  const toggleTooltip =
    'Re-render with iframe sandbox="allow-scripts". ' +
    "The artifact can execute its own JavaScript (inline and from CDNs) " +
    "but cannot access the dashboard. Only enable for HTML you trust.";

  return (
    <div className="artifact-viewer artifact-viewer--html">
      <div className="artifact-viewer__html-controls">
        <span
          className="artifact-viewer__html-status"
          aria-live="polite"
          data-scripts={scriptsEnabled ? "on" : "off"}
        >
          Scripts: {scriptsEnabled ? "on" : "off"}
        </span>
        <label className="artifact-viewer__html-toggle" title={toggleTooltip}>
          <input
            type="checkbox"
            aria-describedby="artifact-html-toggle-desc"
            checked={scriptsEnabled}
            onChange={(e) => setScriptsEnabled(e.target.checked)}
          />
          Run scripts
        </label>
        <span id="artifact-html-toggle-desc" className="visually-hidden">
          {toggleTooltip}
        </span>
      </div>
      <iframe
        key={scriptsEnabled ? "scripts-on" : "scripts-off"}
        title={`Preview of ${filename}`}
        sandbox={sandboxValue}
        srcDoc={html}
        className="artifact-viewer__iframe"
      />
    </div>
  );
}
