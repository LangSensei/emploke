/**
 * Artifact viewer registry — file-extension-keyed selection of a
 * read-only preview renderer. Used by the Tasks → Detail → Artifacts tab
 * to inline-preview the files produced by a task.
 *
 * Add new types by extending `ViewerKind` + `pickViewer` + adding the
 * dispatch arm in `FileViewer`.
 */

export { FileViewer } from "./FileViewer";
export type { ViewerProps } from "./types";

export type ViewerKind = "markdown" | "html" | "json" | "code" | "image" | "text" | "binary";

/** Map a file basename to the viewer that should render its contents. */
export function pickViewer(filename: string): ViewerKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  // No dot at all (e.g. "README", "LICENSE") → treat as text.
  if (!filename.includes(".")) return "text";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "json") return "json";
  if (
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "go",
      "rs",
      "rb",
      "sh",
      "yaml",
      "yml",
      "toml",
      "ini",
      "css",
      "scss",
    ].includes(ext)
  ) {
    return "code";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["txt", "log", ""].includes(ext)) return "text";
  return "binary";
}

/** True iff the viewer for this file consumes a Blob (vs a text string). */
export function viewerNeedsBlob(filename: string): boolean {
  const kind = pickViewer(filename);
  return kind === "image" || kind === "binary";
}
