import { describe, expect, it } from "vitest";
import { WorkspaceCorruptedError } from "../../src/domain/errors.js";
import {
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
  WorkspaceRegistered,
  WorkspaceRenamed,
  WorkspaceUnregistered,
} from "../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const NOW_1 = "2026-05-20T10:00:00.000Z";
const NOW_2 = "2026-05-20T11:00:00.000Z";

function newId(): WorkspaceId {
  return WorkspaceId.of(UUID_A);
}

describe("Workspace.register", () => {
  it("creates a fresh workspace and raises WorkspaceRegistered", () => {
    const ws = Workspace.register({
      id: newId(),
      name: WorkspaceName.of("Project"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
    expect(ws.id.value).toBe(UUID_A);
    expect(ws.name.value).toBe("Project");
    expect(ws.createdAt).toBe(NOW_1);

    const events = ws.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(WorkspaceRegistered);
    const evt = events[0] as WorkspaceRegistered;
    expect(evt.id.value).toBe(UUID_A);
    expect(evt.name.value).toBe("Project");
    expect(evt.registeredAt).toBe(NOW_1);
    expect(evt.occurredAt).toBe(NOW_1);
  });

  it("pullDomainEvents drains the buffer (second call returns empty)", () => {
    const ws = Workspace.register({
      id: newId(),
      name: WorkspaceName.of("X"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
    expect(ws.pullDomainEvents()).toHaveLength(1);
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
    expect(ws.id.value).toBe(UUID_A);
    expect(ws.name.value).toBe("Stored");
    expect(ws.pullDomainEvents()).toHaveLength(0);
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
    const ws = Workspace.register({
      id: newId(),
      name: WorkspaceName.of("Old"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
    ws.pullDomainEvents(); // drain register event
    return ws;
  }

  it("changes the name and raises WorkspaceRenamed", () => {
    const ws = fresh();
    ws.rename(WorkspaceName.of("New"), NOW_2);
    expect(ws.name.value).toBe("New");
    const events = ws.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(WorkspaceRenamed);
    const evt = events[0] as WorkspaceRenamed;
    expect(evt.oldName.value).toBe("Old");
    expect(evt.newName.value).toBe("New");
    expect(evt.renamedAt).toBe(NOW_2);
  });

  it("is a no-op when the new name equals the current name", () => {
    const ws = fresh();
    ws.rename(WorkspaceName.of("Old"), NOW_2);
    expect(ws.name.value).toBe("Old");
    expect(ws.pullDomainEvents()).toHaveLength(0);
  });
});

describe("Workspace.unregister", () => {
  function fresh(): Workspace {
    const ws = Workspace.register({
      id: newId(),
      name: WorkspaceName.of("X"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: NOW_1,
    });
    ws.pullDomainEvents();
    return ws;
  }

  it("raises WorkspaceUnregistered with purged=false by default", () => {
    const ws = fresh();
    ws.unregister(NOW_2, { purged: false });
    const events = ws.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(WorkspaceUnregistered);
    expect((events[0] as WorkspaceUnregistered).purged).toBe(false);
    expect((events[0] as WorkspaceUnregistered).unregisteredAt).toBe(NOW_2);
  });

  it("carries purged=true into the event", () => {
    const ws = fresh();
    ws.unregister(NOW_2, { purged: true });
    const evt = ws.pullDomainEvents()[0] as WorkspaceUnregistered;
    expect(evt.purged).toBe(true);
  });
});
