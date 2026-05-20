import "reflect-metadata";
import { composeCatalogModule } from "@emploke/catalog";
import { composeRuntimeModule } from "@emploke/runtime";
import { composeSessionModule } from "@emploke/session";
import { composeTaskModule } from "@emploke/task";
import { composeWorkspaceModule } from "@emploke/workspace";
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
 * Phase 0 keeps the two composition roots in lock-step so Phase 1+
 * can decide per-binding whether the CLI needs a divergent surface.
 *
 * Phase 0: every compose function is an empty body and no production
 * CLI code resolves through the container; the smoke test
 * (`test/inversify-bootstrap.test.ts`) proves the wiring is sound.
 */
export function buildCliContainer(): Container {
  const container = new Container();
  const resolver = new InversifyResolver(container);
  const mediator = new Mediator({ resolver });
  container.bind(Mediator).toConstantValue(mediator);

  // Same compose-call order as `@emploke/server`'s bootstrap — see the
  // comment block there for the rationale.
  composeWorkspaceModule(container);
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  return container;
}
