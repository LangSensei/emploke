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

  it("does NOT auto-select when there are multiple artifacts", () => {
    render(<ArtifactsTab task={makeTask(["/a/one.md", "/a/two.md"])} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Select an artifact/i)).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "one.md" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "two.md" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("keeps the per-row Download link as a permanent affordance", () => {
    render(<ArtifactsTab task={makeTask(["/a/one.bin"])} />);
    const links = screen.getAllByRole("link", { name: /Download/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]?.getAttribute("href")).toContain("/tasks/task-abc/artifact/one.bin");
  });
});
