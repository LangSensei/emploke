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
 * Build the root inversify container for the server process and wire
 * the mediatr-ts dispatcher into it.
 *
 * This is the composition root for the architecture-v2 refactor
 * tracked by issue #135. Phase 0 only constructs the container and
 * lets every package register its bindings via `compose…Module`; the
 * bodies of those module functions are empty for now, and no existing
 * code path resolves through the container. The smoke test
 * (`test/inversify-bootstrap.test.ts`) proves the wiring is sound so
 * Phase 1+ can start filling in handlers without re-litigating any of
 * the bootstrap design.
 *
 * Order: register the mediator on the container BEFORE calling any
 * `compose…Module`. Future module functions are expected to bind
 * handlers and resolve them off the mediator; having `Mediator`
 * available from the first compose call avoids ordering pitfalls.
 */
export function buildServerContainer(): Container {
  const container = new Container();
  const resolver = new InversifyResolver(container);
  const mediator = new Mediator({ resolver });
  container.bind(Mediator).toConstantValue(mediator);

  // Phase 0: every compose function is an empty body. They are still
  // invoked so the bootstrap exercises the wiring end-to-end and any
  // future addition lands in this exact order.
  //
  // Call order is documented in `.ceo/design/architecture-v2-e2e.md`:
  // root container is built first, then each context's bindings are
  // registered. The order itself does NOT matter today (all stubs),
  // and Phase 1+ binding registration is dep-direction-agnostic
  // because mediator dispatch is late-bound. If a future binding ever
  // needs a sibling-context service at compose time (rare), revisit.
  composeWorkspaceModule(container);
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  return container;
}
