/**
 * Architecture spike: prove that mediatr-ts pipeline behaviours
 * resolve per-Mediator-instance through each Mediator's own inversify
 * resolver — i.e. the same `TransactionBehavior` class can inject a
 * DIFFERENT `UnitOfWork` depending on which Mediator dispatches the
 * command, when child containers override the binding.
 *
 * If this test ever turns red, the entire per-workspace-MikroORM-with-
 * one-shared-TransactionBehavior architecture (see plan.md C1-C2) is
 * invalid and the alternative is two distinct TransactionBehavior
 * classes (one bound in workspace pkg, one in per-workspace pkg) —
 * with ALL the duplication that implies.
 */

import { describe, expect, it } from "vitest";

import { Container } from "inversify";
import {
  Mediator,
  pipelineBehavior,
  type PipelineBehavior,
  RequestData,
  RequestHandler,
  requestHandler,
} from "mediatr-ts";

import { inject, injectable } from "inversify";
import { InversifyResolver } from "../src/inversify-resolver.js";

// ── A toy UnitOfWork token + two distinct instances ───────────
abstract class FakeUoW {
  abstract readonly label: string;
}

@injectable()
class FakeUoWA extends FakeUoW {
  override readonly label = "A";
}

@injectable()
class FakeUoWB extends FakeUoW {
  override readonly label = "B";
}

// ── Behavior that records which UoW it saw ────────────────────
const seen: string[] = [];

@injectable()
class RecordingBehavior implements PipelineBehavior {
  constructor(@inject(FakeUoW) private readonly uow: FakeUoW) {}
  async handle(_req: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    seen.push(this.uow.label);
    return next();
  }
}
(pipelineBehavior() as ClassDecorator)(RecordingBehavior);

// ── A trivial command + handler ───────────────────────────────
class PingCommand extends RequestData<string> {}

@injectable()
@requestHandler(PingCommand)
class PingHandler implements RequestHandler<PingCommand, string> {
  async handle(_cmd: PingCommand): Promise<string> {
    return "pong";
  }
}

describe("per-Mediator inversify resolver (UnitOfWork override spike)", () => {
  it("dispatches RecordingBehavior with the right UoW per Mediator", async () => {
    seen.length = 0;

    const parent = new Container();
    parent.bind(FakeUoW).to(FakeUoWA).inSingletonScope();
    parent.bind(PingHandler).toSelf();
    parent.bind(RecordingBehavior).toSelf();
    const parentMediator = new Mediator({ resolver: new InversifyResolver(parent) });

    // Child container inherits parent bindings but OVERRIDES FakeUoW.
    const child = new Container({ parent });
    child.bind(FakeUoW).to(FakeUoWB).inSingletonScope();
    child.bind(RecordingBehavior).toSelf();
    child.bind(PingHandler).toSelf();
    const childMediator = new Mediator({ resolver: new InversifyResolver(child) });

    const out1 = await parentMediator.send(new PingCommand());
    const out2 = await childMediator.send(new PingCommand());
    const out3 = await parentMediator.send(new PingCommand());

    expect(out1).toBe("pong");
    expect(out2).toBe("pong");
    expect(out3).toBe("pong");
    // Parent dispatches → A; child dispatches → B; parent again → A.
    // If mediatr-ts cached the behavior cross-Mediator we'd see AAA or BBB.
    expect(seen).toEqual(["A", "B", "A"]);
  });
});
