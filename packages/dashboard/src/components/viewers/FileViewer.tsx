import BinaryFallback from "./BinaryFallback";
import CodeViewer from "./CodeViewer";
import HtmlViewer from "./HtmlViewer";
import ImageViewer from "./ImageViewer";
import { pickViewer } from "./index";
import JsonViewer from "./JsonViewer";
import MarkdownViewer from "./MarkdownViewer";
import TextViewer from "./TextViewer";
import type { ViewerProps } from "./types";

/**
 * Dispatcher — picks a viewer based on `filename` extension and
 * forwards `content` / `size` / `downloadUrl`. Kept dumb on purpose:
 * fetching, abort handling, and selection state live in the parent.
 */
export function FileViewer(props: ViewerProps) {
  const kind = pickViewer(props.filename);
  switch (kind) {
    case "markdown":
      return <MarkdownViewer {...props} />;
    case "html":
      return <HtmlViewer {...props} />;
    case "json":
      return <JsonViewer {...props} />;
    case "code":
      return <CodeViewer {...props} />;
    case "image":
      return <ImageViewer {...props} />;
    case "text":
      return <TextViewer {...props} />;
    case "binary":
      return <BinaryFallback {...props} />;
  }
}
