import { describe, expect, it } from "vitest";
import { WorkspaceCorruptedError } from "../../src/domain/exceptions/workspace-errors.js";
import { Workspace, WorkspaceDir, WorkspaceId, WorkspaceName } from "../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const NOW_1 = "2026-05-20T10:00:00.000Z";
const NOW_2 = "2026-05-20T11:00:00.000Z";

function newId(): WorkspaceId {
  return WorkspaceId.of(UUID_A);
}

describe("Workspace.register (Phase 2 / MikroORM entity)", () => {
  it("creates a fresh workspace with primitive fields populated", () => {
    const ws = Workspace.register({
      id: newId(),
      name: WorkspaceName.of("Project"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
    // Phase 2: aggregate fields are primitives (MikroORM column
    // mapping). Value objects live at the constructor boundary only.
    expect(ws.id).toBe(UUID_A);
    expect(ws.name).toBe("Project");
    expect(ws.createdAt).toBe(NOW_1);
    // register acts as implicit "first open"
    expect(ws.lastOpenedAt).toBe(NOW_1);
    expect(ws.pullDomainEvents()).toHaveLength(0);
  });
});

describe("Workspace.fromStored", () => {
  it("rehydrates without raising events", () => {
    const ws = Workspace.fromStored({
      id: UUID_A,
      name: "Stored",
      workspaceDir: "/tmp/x",
      createdAt: NOW_1,
    });
    expect(ws.id).toBe(UUID_A);
    expect(ws.name).toBe("Stored");
    expect(ws.lastOpenedAt).toBeNull();
    expect(ws.pullDomainEvents()).toHaveLength(0);
  });

  it("preserves lastOpenedAt when supplied", () => {
    const ws = Workspace.fromStored({
      id: UUID_A,
      name: "Stored",
      workspaceDir: "/tmp/x",
      createdAt: NOW_1,
      lastOpenedAt: NOW_2,
    });
    expect(ws.lastOpenedAt).toBe(NOW_2);
  });

  it("throws WorkspaceCorruptedError on invalid id", () => {
    expect(() =>
      Workspace.fromStored({
        id: "not-a-uuid",
        name: "Bad",
        workspaceDir: "/tmp/x",
        createdAt: NOW_1,
      }),
    ).toThrow(WorkspaceCorruptedError);
  });

  it("throws WorkspaceCorruptedError on empty name", () => {
    expect(() =>
      Workspace.fromStored({
        id: UUID_A,
        name: "",
        workspaceDir: "/tmp/x",
        createdAt: NOW_1,
      }),
    ).toThrow(WorkspaceCorruptedError);
  });

  it("throws WorkspaceCorruptedError on missing createdAt", () => {
    expect(() =>
      Workspace.fromStored({
        id: UUID_A,
        name: "Ok",
        workspaceDir: "/tmp/x",
        createdAt: "",
      }),
    ).toThrow(WorkspaceCorruptedError);
  });
});

describe("Workspace.rename", () => {
  function fresh(): Workspace {
    return Workspace.register({
      id: newId(),
      name: WorkspaceName.of("Old"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
  }

  it("changes the name", () => {
    const ws = fresh();
    ws.rename(WorkspaceName.of("New"));
    expect(ws.name).toBe("New");
  });

  it("is a no-op when the new name equals the current name", () => {
    const ws = fresh();
    ws.rename(WorkspaceName.of("Old"));
    expect(ws.name).toBe("Old");
  });
});

describe("Workspace.open", () => {
  function fresh(): Workspace {
    return Workspace.register({
      id: newId(),
      name: WorkspaceName.of("X"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
  }

  it("updates lastOpenedAt on open", () => {
    const ws = fresh();
    expect(ws.lastOpenedAt).toBe(NOW_1);
    ws.open(NOW_2);
    expect(ws.lastOpenedAt).toBe(NOW_2);
  });
});
