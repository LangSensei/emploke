import "reflect-metadata";
import { composeCatalogModule } from "@emploke/catalog";
import { composeRuntimeModule } from "@emploke/runtime";
import { composeSessionModule } from "@emploke/session";
import { composeTaskModule } from "@emploke/task";
import { composeWorkspaceModule, WorkspaceDb } from "@emploke/workspace";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { InversifyResolver } from "./inversify-resolver.js";

/**
 * Build the inversify container for one `emploke` CLI invocation and
 * wire the mediatr-ts dispatcher into it.
 *
 * Unlike the server's long-lived container (one per process), each
 * CLI command starts a fresh container that lives only until the
 * command returns. The shape is intentionally identical to
 * `@emploke/server`'s `buildServerContainer` (see issue #135 ADR) —
 * Phase 1+ keeps the two composition roots in lock-step so future
 * phases can decide per-binding whether the CLI needs a divergent
 * surface.
 *
 * ## Phase 1 caveat: no DB binding
 *
 * CLI commands talk HTTP to the server; they never dispatch workspace
 * commands locally and therefore never need a `WorkspaceDb` binding.
 * The compose calls run, the mediator registers the handler-class
 * mappings, but the handlers themselves are never resolved (and
 * therefore never trigger `@inject(WorkspaceDb)`). If a future CLI
 * subcommand wants to operate against `global.db` directly without a
 * running server, replace the throw below with a real DB handle.
 *
 * A sentinel binding for `WorkspaceDb` is registered with a descriptive
 * error so the first contributor who wires a workspace-handler-using
 * CLI subcommand gets a clear "CLI process has no global.db — talk to
 * the server" message instead of inversify's generic
 * `No bindings found for service: ...` (PR #138 reviewer feedback).
 */
export function buildCliContainer(): Container {
  const container = new Container();
  const resolver = new InversifyResolver(container);
  const mediator = new Mediator({ resolver });
  container.bind(Mediator).toConstantValue(mediator);

  // Sentinel binding: throws on first resolve with a clear message.
  // TODO(#135 Phase 3+): replace with a real `DatabaseSync` handle if
  // a CLI subcommand starts dispatching workspace handlers locally.
  container.bind(WorkspaceDb).toDynamicValue(() => {
    throw new Error(
      "CLI process has no global.db handle — workspace command handlers cannot run in the CLI. " +
        "Talk to the server via HTTP, or wire a real WorkspaceDb binding in cli/src/bootstrap.ts.",
    );
  });

  // Same compose-call order as `@emploke/server`'s bootstrap — see
  // the comment block there for the rationale.
  composeWorkspaceModule(container);
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  return container;
}
