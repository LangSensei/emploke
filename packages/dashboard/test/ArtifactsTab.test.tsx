import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveWorkspace, type TaskRecord } from "../src/api";
import { ArtifactsTab } from "../src/components/tasks/TaskDetail/ArtifactsTab";

function makeTask(artifacts: string[]): TaskRecord {
  return {
    id: "task-abc",
    success: { artifacts },
  } as unknown as TaskRecord;
}

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActiveWorkspace("ws-test");
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setActiveWorkspace(null);
  vi.restoreAllMocks();
});

describe("ArtifactsTab", () => {
  it("renders the empty state when there are no artifacts", () => {
    render(<ArtifactsTab task={makeTask([])} />);
    expect(screen.getByText(/No artifacts/i)).toBeTruthy();
  });

  it("auto-selects + fetches when there is exactly one artifact", async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response("# hi", {
                  status: 200,
                  headers: { "content-type": "text/markdown" },
                }),
              ),
            0,
          );
        }),
    );
    render(<ArtifactsTab task={makeTask(["/tmp/notes.md"])} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/tasks/task-abc/artifact/notes.md");
  });

  it("auto-selects the first artifact and renders the dropdown when there are multiple", async () => {
    fetchMock.mockResolvedValue(new Response("body", { status: 200 }));
    render(<ArtifactsTab task={makeTask(["/a/one.md", "/a/two.md"])} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const select = screen.getByRole("combobox", { name: /select artifact/i });
    expect((select as HTMLSelectElement).value).toBe("one.md");
    expect(screen.getByRole("option", { name: "one.md" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "two.md" })).toBeTruthy();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/tasks/task-abc/artifact/one.md");
  });

  it("aborts the prior in-flight fetch when the selection changes", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise((resolve) =>
        setTimeout(() => resolve(new Response("body", { status: 200 })), 50),
      );
    });

    render(<ArtifactsTab task={makeTask(["/a/one.md", "/a/two.md"])} />);

    // Auto-select-first fires on mount, so the first fetch is for one.md
    // without any user interaction.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const select = screen.getByRole("combobox", { name: /select artifact/i });
    fireEvent.change(select, { target: { value: "two.md" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("renders a single Download link whose href reflects the current selection", async () => {
    fetchMock.mockResolvedValue(new Response("body", { status: 200 }));
    render(<ArtifactsTab task={makeTask(["/a/one.md", "/a/two.md"])} />);

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /download/i });
      expect(link.getAttribute("href")).toContain("/tasks/task-abc/artifact/one.md");
    });

    const select = screen.getByRole("combobox", { name: /select artifact/i });
    fireEvent.change(select, { target: { value: "two.md" } });

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /download/i });
      expect(link.getAttribute("href")).toContain("/tasks/task-abc/artifact/two.md");
    });
  });

  it("renders the dropdown with a single option for the one-artifact case", async () => {
    fetchMock.mockResolvedValue(new Response("body", { status: 200 }));
    render(<ArtifactsTab task={makeTask(["/a/only.bin"])} />);
    const select = screen.getByRole("combobox", { name: /select artifact/i });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect((options[0] as HTMLOptionElement).value).toBe("only.bin");
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("only.bin");
    });
  });

  it("renders the pane layout with the artifacts-pane class hooks", () => {
    // The CSS contract relies on these class names being present on the
    // container, its header, and its preview pane. Without them the
    // `.artifacts-pane` rules (full-height column, dropdown header,
    // full-bleed preview) never bind.
    const { container } = render(<ArtifactsTab task={makeTask(["/tmp/notes.md"])} />);
    const pane = container.querySelector(".artifacts-pane");
    expect(pane).toBeTruthy();
    // The root is also the task-detail body so the parent chain
    // (`.tasks-pane__detail > .task-detail__body`) supplies a
    // determinate height for the `height: 100%` rule to consume.
    expect(pane?.classList.contains("task-detail__body")).toBe(true);
    expect(pane?.querySelector(".artifacts-pane__header")).toBeTruthy();
    expect(pane?.querySelector(".artifacts-pane__preview")).toBeTruthy();
  });
});
