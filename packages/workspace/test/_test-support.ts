import type { MikroORM } from "@mikro-orm/core";
import {
  composeWorkspaceModule,
  type WorkspaceModule,
  type WorkspaceQueries,
  type WorkspaceService,
} from "../src/index.js";
import { openTestWorkspaceOrm } from "../src/testing.js";

export interface WorkspaceTestSubsystem {
  orm: MikroORM;
  module: WorkspaceModule;
  service: WorkspaceService;
  queries: WorkspaceQueries;
}

export async function setupWorkspaceTestSubsystem(): Promise<WorkspaceTestSubsystem> {
  const orm = await openTestWorkspaceOrm();
  const module = await composeWorkspaceModule({ orm });
  return { orm, module, service: module.service, queries: module.queries };
}

export async function teardownWorkspaceTestSubsystem(sys: WorkspaceTestSubsystem): Promise<void> {
  await sys.module.close();
  await sys.orm.close(true);
}
