import type { ViewerProps } from "./types";

/**
 * HTML preview — rendered inside an `<iframe sandbox="" srcDoc=…>`.
 *
 * `sandbox=""` (empty attribute) is the maximum-restriction form: no
 * scripts, no same-origin, no forms, no top navigation, no plugins,
 * no popups. A malicious artifact therefore cannot exfiltrate cookies,
 * navigate the parent, or run JS in the dashboard origin. We clamp the
 * iframe height via CSS so a giant HTML report doesn't blow out the
 * layout — the iframe itself scrolls.
 */
export default function HtmlViewer({ content, filename }: ViewerProps) {
  const html = typeof content === "string" ? content : "";
  return (
    <div className="artifact-viewer artifact-viewer--html">
      <iframe
        title={`Preview of ${filename}`}
        sandbox=""
        srcDoc={html}
        className="artifact-viewer__iframe"
      />
    </div>
  );
}
