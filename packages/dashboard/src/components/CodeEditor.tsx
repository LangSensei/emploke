import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "markdown" | "yaml" | "json";
  disabled?: boolean;
  /** Fixed editor height. Content beyond this scrolls inside the editor. */
  height?: string;
}

const LANG_EXTENSIONS = {
  markdown: () => markdown(),
  yaml: () => yaml(),
  json: () => yaml(), // CodeMirror's yaml mode handles JSON well enough; avoids a separate dep
};

const baseExtensions = [
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { fontSize: "12px" },
    ".cm-content": { fontFamily: "var(--font-mono)" },
    ".cm-gutters": { fontFamily: "var(--font-mono)" },
  }),
];

export function CodeEditor({
  value,
  onChange,
  language,
  disabled,
  height = "400px",
}: CodeEditorProps) {
  return (
    <div className="code-editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        editable={!disabled}
        readOnly={disabled}
        height={height}
        extensions={[...baseExtensions, LANG_EXTENSIONS[language]()]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !disabled,
          highlightSelectionMatches: false,
        }}
      />
    </div>
  );
}
