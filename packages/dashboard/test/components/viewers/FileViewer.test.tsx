import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FileViewer } from "../../../src/components/viewers/FileViewer";

afterEach(() => cleanup());

describe("FileViewer", () => {
  it("renders markdown headings via the in-house renderer", () => {
    const { container } = render(<FileViewer filename="x.md" content="# Hello" />);
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe("Hello");
  });

  it("pretty-prints valid JSON", () => {
    const { container } = render(<FileViewer filename="x.json" content='{"a":1,"b":2}' />);
    const code = container.querySelector("code");
    expect(code?.textContent).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("falls back to raw display for invalid JSON without throwing", () => {
    const { container } = render(<FileViewer filename="x.json" content="not-json" />);
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("not-json");
  });

  it("renders an <img> for image content", () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3])], {
      type: "image/png",
    });
    const { container } = render(<FileViewer filename="pic.png" content={blob} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("pic.png");
  });

  it("renders the binary fallback with a download link for unknown types", () => {
    const blob = new Blob([new Uint8Array([0, 1, 2])], {
      type: "application/octet-stream",
    });
    render(
      <FileViewer filename="data.bin" content={blob} downloadUrl="/api/x/y/artifact/data.bin" />,
    );
    expect(screen.getByText(/Binary file/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Download data.bin/i });
    expect(link.getAttribute("href")).toBe("/api/x/y/artifact/data.bin");
  });

  it("renders code content in a <pre><code> block", () => {
    const { container } = render(<FileViewer filename="x.ts" content="export const a = 1;" />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("export const a = 1;");
  });
});
