import {
  composeWorkspaceModule,
  type WorkspaceModule,
  type WorkspaceService,
} from "../src/index.js";
import { openTestWorkspaceDb } from "../src/testing.js";

export interface WorkspaceTestSubsystem {
  handle: ReturnType<typeof openTestWorkspaceDb>;
  module: WorkspaceModule;
  service: WorkspaceService;
}

export async function setupWorkspaceTestSubsystem(): Promise<WorkspaceTestSubsystem> {
  const handle = openTestWorkspaceDb();
  const module = await composeWorkspaceModule({ db: handle.db });
  return { handle, module, service: module.service };
}

export async function teardownWorkspaceTestSubsystem(sys: WorkspaceTestSubsystem): Promise<void> {
  await sys.module.close();
  sys.handle.close();
}
