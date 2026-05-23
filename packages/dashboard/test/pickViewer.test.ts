import { describe, expect, it } from "vitest";
import { pickViewer, viewerNeedsBlob } from "../src/components/viewers/index";

describe("pickViewer", () => {
  it("returns 'markdown' for .md / .markdown", () => {
    expect(pickViewer("foo.md")).toBe("markdown");
    expect(pickViewer("notes.MARKDOWN")).toBe("markdown");
  });
  it("returns 'html' for .html / .htm", () => {
    expect(pickViewer("report.html")).toBe("html");
    expect(pickViewer("page.htm")).toBe("html");
  });
  it("returns 'json' for .json", () => {
    expect(pickViewer("config.json")).toBe("json");
  });
  it("returns 'code' for source-like extensions", () => {
    expect(pickViewer("script.ts")).toBe("code");
    expect(pickViewer("module.py")).toBe("code");
    expect(pickViewer("style.scss")).toBe("code");
    expect(pickViewer("conf.yaml")).toBe("code");
  });
  it("returns 'image' for image extensions", () => {
    expect(pickViewer("pic.png")).toBe("image");
    expect(pickViewer("pic.JPG")).toBe("image");
    expect(pickViewer("icon.svg")).toBe("image");
  });
  it("returns 'text' for .txt / .log", () => {
    expect(pickViewer("a.txt")).toBe("text");
    expect(pickViewer("server.log")).toBe("text");
  });
  it("returns 'text' for files with no extension (e.g. README)", () => {
    expect(pickViewer("README")).toBe("text");
    expect(pickViewer("LICENSE")).toBe("text");
  });
  it("returns 'binary' for unknown extensions", () => {
    expect(pickViewer("blob.unknown")).toBe("binary");
    expect(pickViewer("payload.bin")).toBe("binary");
  });
});

describe("viewerNeedsBlob", () => {
  it("is true for image + binary", () => {
    expect(viewerNeedsBlob("a.png")).toBe(true);
    expect(viewerNeedsBlob("a.bin")).toBe(true);
  });
  it("is false for text-y kinds", () => {
    expect(viewerNeedsBlob("a.md")).toBe(false);
    expect(viewerNeedsBlob("a.json")).toBe(false);
    expect(viewerNeedsBlob("a.ts")).toBe(false);
    expect(viewerNeedsBlob("README")).toBe(false);
  });
});
