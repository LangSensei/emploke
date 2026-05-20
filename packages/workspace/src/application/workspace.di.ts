import { silentLogger } from "@emploke/logger";
import { defineConfig } from "@mikro-orm/better-sqlite";
import { type EntityManager, MikroORM } from "@mikro-orm/core";
import type { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { WorkspaceRepository } from "../domain/aggregates/workspace/workspace-repository.js";
import { DomainEventDispatcher } from "../infrastructure/domain-event-dispatcher.js";
import { MikroWorkspaceRepository } from "../infrastructure/repositories/mikro-workspace-repository.js";
import { WorkspaceContext } from "../infrastructure/workspace-context.js";
import { WORKSPACE_ENTITIES } from "../infrastructure/workspace-entities.js";
import { LOGGER } from "./behaviors/logging-behavior.js";
import { OpenWorkspaceCommand } from "./commands/open-workspace.command.js";
import { OpenWorkspaceCommandHandler } from "./commands/open-workspace.command-handler.js";
import { RegisterWorkspaceCommand } from "./commands/register-workspace.command.js";
import { RegisterWorkspaceCommandHandler } from "./commands/register-workspace.command-handler.js";
import { RenameWorkspaceCommand } from "./commands/rename-workspace.command.js";
import { RenameWorkspaceCommandHandler } from "./commands/rename-workspace.command-handler.js";
import { UnregisterWorkspaceCommand } from "./commands/unregister-workspace.command.js";
import { UnregisterWorkspaceCommandHandler } from "./commands/unregister-workspace.command-handler.js";
import { MikroWorkspaceQueries } from "./queries/mikro-workspace-queries.js";
import { WorkspaceQueries } from "./queries/workspace-queries.js";
import { CommandValidator } from "./validations/command-validator.js";
import { OpenWorkspaceCommandValidator } from "./validations/open-workspace.command-validator.js";
import { RegisterWorkspaceCommandValidator } from "./validations/register-workspace.command-validator.js";
import { RenameWorkspaceCommandValidator } from "./validations/rename-workspace.command-validator.js";
import { UnregisterWorkspaceCommandValidator } from "./validations/unregister-workspace.command-validator.js";

/**
 * Concrete validators registered against the abstract `CommandValidator`
 * service identifier. Inspired by eShop's
 * `services.AddValidatorsFromAssemblyContaining<T>()` — we can't do
 * assembly scanning in TS, but a flat list in one place gives the same
 * "see every validator at a glance" property. Adding a new validator
 * is a single push.
 */
const COMMAND_VALIDATORS = [
  RegisterWorkspaceCommandValidator,
  RenameWorkspaceCommandValidator,
  OpenWorkspaceCommandValidator,
  UnregisterWorkspaceCommandValidator,
] as const;

/**
 * Configuration for {@link composeWorkspaceModule}.
 *
 * Either supply `dbFile` (workspace pkg owns the MikroORM instance —
 * the production path) or `orm` (caller — typically tests — owns a
 * pre-built ORM). The two are mutually exclusive.
 */
export type WorkspaceModuleOptions =
  | {
      /** Absolute path to the global registry SQLite DB. */
      readonly dbFile: string;
      /**
       * When `false`, skip `orm.schema.updateSchema()` after init.
       * Use for production deployments that drive schema via
       * `orm.migrator.up()` instead. Defaults to `true`.
       */
      readonly updateSchema?: boolean;
      /** Forwarded to MikroORM. Defaults to `true` to match prior behaviour. */
      readonly allowGlobalContext?: boolean;
    }
  | {
      /**
       * Pre-built MikroORM instance. The composer does NOT call
       * `init`/`updateSchema`/`close` on it — the caller owns its
       * lifecycle. The handle returned from {@link composeWorkspaceModule}
       * has a no-op `close()` in this mode.
       */
      readonly orm: MikroORM;
    };

/**
 * Lifecycle handle returned by {@link composeWorkspaceModule}.
 *
 * `close()` shuts down the workspace context's underlying MikroORM
 * instance — but only when the composer owned it (i.e. the
 * `dbFile` form was used). When the caller passed in an ORM, the
 * handle's `close()` is a no-op so we don't yank the rug out from
 * under code that still holds a reference.
 */
export interface WorkspaceModuleHandle {
  close(): Promise<void>;
}

/**
 * Compose the @emploke/workspace module into the given container.
 *
 * ## Encapsulation
 * The workspace pkg owns its persistence stack: it opens the
 * MikroORM instance, registers its `DomainEventDispatcher` on the
 * EM's event manager, binds `WorkspaceContext` (the EM wrapper) as
 * a constant value, and wires its repositories / queries / command
 * handlers / validators into the container + mediator.
 *
 * Callers (`@emploke/server`, future `@emploke/cli` direct
 * embeds) only pass configuration — they don't touch MikroORM /
 * EntityManager / WORKSPACE_ENTITIES directly. Each bounded context
 * owns its own EM; analogous compose functions for session / task /
 * catalog will spin up their own ORM the same way.
 *
 * ## Pre-compose prerequisites
 *   - `Mediator` MUST be bound on the container before this call
 *     (the dispatcher binding resolves it via @inject(Mediator)).
 *
 * ## What this function binds
 *   - `WorkspaceContext` (constant value — wraps the EM).
 *   - `WorkspaceRepository` → `MikroWorkspaceRepository` (singleton).
 *   - `WorkspaceQueries` → `MikroWorkspaceQueries` (singleton).
 *   - `DomainEventDispatcher` (singleton; also registered on the
 *     ORM's event manager).
 *   - Per-command validators bound to the abstract `CommandValidator`
 *     identifier so `ValidationBehavior` can multi-inject and dispatch.
 *   - The four command handlers via `mediator.registerHandler`.
 *
 * Pipeline behaviours (`ValidationBehavior` outermost,
 * `TransactionBehavior` inner) self-register at module load via
 * `@pipelineBehavior()` decorator side-effects from
 * `@emploke/workspace` index.ts. They run on *every* command sent
 * through the shared Mediator. Order is asserted in
 * `workspace.di.test.ts` so accidental import re-ordering is caught
 * by CI rather than at runtime.
 */
export async function composeWorkspaceModule(
  container: Container,
  options: WorkspaceModuleOptions,
): Promise<WorkspaceModuleHandle> {
  // ── 1. Open or accept the MikroORM instance ──────────────
  const ownsOrm = !("orm" in options);
  let orm: MikroORM;
  if ("orm" in options) {
    orm = options.orm;
  } else {
    orm = await MikroORM.init(
      defineConfig({
        entities: [...WORKSPACE_ENTITIES],
        dbName: options.dbFile,
        allowGlobalContext: options.allowGlobalContext ?? true,
      }),
    );
    if (options.updateSchema !== false) {
      await orm.schema.updateSchema();
    }
  }

  // ── 2. Bind workspace context (the EM wrapper) ──────────
  // toConstantValue: we own the WorkspaceContext lifecycle here, no
  // need for inversify to resurrect it via @inject(EntityManager).
  // The @injectable decorator on WorkspaceContext is left in place
  // so test-only code paths (makeTestWorkspaceContext) that bypass
  // DI keep working.
  const ctx = new WorkspaceContext(orm.em as EntityManager);
  container.bind(WorkspaceContext).toConstantValue(ctx);

  // ── 3. Domain / application bindings ────────────────────
  container.bind(DomainEventDispatcher).toSelf().inSingletonScope();
  container.bind(WorkspaceRepository).to(MikroWorkspaceRepository).inSingletonScope();
  container.bind(WorkspaceQueries).to(MikroWorkspaceQueries).inSingletonScope();

  // LoggingBehavior's logger. Defaults to silentLogger so unit tests
  // and headless callers never spam stdout. Bind LOGGER before
  // composing the module if a real logger is desired.
  if (!container.isBound(LOGGER)) {
    container.bind(LOGGER).toConstantValue(silentLogger);
  }

  // Per-command validators bound to the abstract CommandValidator
  // service identifier so ValidationBehavior can `@multiInject` them
  // and pick the right one per request via the validator's `command`
  // self-declaration.
  for (const ValidatorClass of COMMAND_VALIDATORS) {
    container.bind(CommandValidator).to(ValidatorClass).inSingletonScope();
  }

  // ── 4. Register the dispatcher on MikroORM's event manager ─
  // Any em.flush() (driven by TransactionBehavior's em.transactional,
  // by a direct test call, or by any future code path) automatically
  // drains pending aggregate domain events from the UoW identity map
  // and publishes them through the mediator BEFORE the SQL writes
  // hit SQLite. Mirrors eShop OrderingContext.SaveEntitiesAsync
  // semantics, leveraging MikroORM's subscriber registry rather
  // than rebuilding the orchestration in a Context method.
  orm.em.getEventManager().registerSubscriber(container.get(DomainEventDispatcher));

  // ── 5. Manual command-handler registration ──────────────
  // mediatr-ts stores mappings on a module-level singleton, so
  // re-running composeWorkspaceModule (test contexts) would throw
  // "defined twice" without the idempotent guard below.
  const mediator = container.get(Mediator);
  registerCommandIdempotent(mediator, RegisterWorkspaceCommand, RegisterWorkspaceCommandHandler);
  registerCommandIdempotent(mediator, RenameWorkspaceCommand, RenameWorkspaceCommandHandler);
  registerCommandIdempotent(
    mediator,
    UnregisterWorkspaceCommand,
    UnregisterWorkspaceCommandHandler,
  );
  registerCommandIdempotent(mediator, OpenWorkspaceCommand, OpenWorkspaceCommandHandler);

  // ── 6. Lifecycle handle ─────────────────────────────────
  return {
    async close() {
      if (ownsOrm) {
        await orm.close(true);
      }
    },
  };
}

function registerCommandIdempotent(
  mediator: Mediator,
  // biome-ignore lint/suspicious/noExplicitAny: mediatr-ts requires wide shape
  command: any,
  // biome-ignore lint/suspicious/noExplicitAny: see above
  handler: any,
): void {
  try {
    mediator.registerHandler(command, handler);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("defined twice")) throw err;
  }
}
