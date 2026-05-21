import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";
import type { TaskOrigin, TaskStatus } from "./types.js";

/**
 * Internal MikroORM row carrier for the `tasks` table. Distinct from
 * the public `Task` entity class (in `./task-entity.ts`): this is the
 * persistence shape; `Task` is the rich JS class that callers see.
 * `TaskRepository.list()/.read()` convert TaskRow → Task via
 * `Task.fromStored`; `TaskRepository.save()` extracts fields off a
 * `Task` instance back into a TaskRow.
 *
 * Kept private to the pkg: external consumers should never see this.
 *
 * `runtime` is promoted out of `metadata` into a first-class indexed
 * column so the dashboard's runtime-filter dropdown reads cleanly.
 */
@Entity({ tableName: "tasks" })
export class TaskRow {
  @PrimaryKey({ type: "text" })
  id!: string;

  @Property({ type: "text" })
  @Index({ name: "tasks_agent_idx" })
  agent!: string;

  @Property({ type: "text", nullable: true })
  @Index({ name: "tasks_runtime_idx" })
  runtime!: string | null;

  @Property({ type: "text" })
  @Index({ name: "tasks_status_idx" })
  status!: TaskStatus;

  @Property({ type: "text" })
  brief!: string;

  @Property({ type: "text", nullable: true })
  details!: string | null;

  @Property({ type: "text" })
  @Index({ name: "tasks_origin_idx" })
  origin!: TaskOrigin;

  @Property({ type: "text", fieldName: "created_at" })
  createdAt!: string;

  @Property({ type: "text", fieldName: "started_at" })
  startedAt!: string;

  @Property({ type: "text", fieldName: "ended_at", nullable: true })
  endedAt!: string | null;

  @Property({ type: "text", nullable: true })
  success!: string | null;

  @Property({ type: "text", nullable: true })
  failure!: string | null;

  @Property({ type: "text", nullable: true })
  cancellation!: string | null;

  @Property({ type: "text" })
  metadata!: string;
}

export const TASK_ENTITIES = [TaskRow] as const;
