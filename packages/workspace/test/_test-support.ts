import {
  composeWorkspaceModule,
  type WorkspaceModule,
  type WorkspaceService,
} from "../src/index.js";

export interface WorkspaceTestSubsystem {
  module: WorkspaceModule;
  service: WorkspaceService;
}

export async function setupWorkspaceTestSubsystem(): Promise<WorkspaceTestSubsystem> {
  const module = await composeWorkspaceModule({ dbFile: ":memory:" });
  return { module, service: module.service };
}

export async function teardownWorkspaceTestSubsystem(sys: WorkspaceTestSubsystem): Promise<void> {
  await sys.module.close();
}
