import { type Logger, silentLogger } from "@emploke/logger";
import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Service identifier for the pino-compatible `Logger` injected into
 * pipeline behaviours. Workspace pkg defaults this to `silentLogger`
 * inside `composeWorkspaceModule`; the server / CLI can rebind to a
 * real logger before composing the module if log capture is desired.
 */
export const LOGGER: unique symbol = Symbol.for("emploke/workspace/Logger");

/**
 * Outermost pipeline behaviour. Logs entry / exit / failure for every
 * mediator request, including those that fail validation. Sits OUTSIDE
 * `ValidationBehavior` so a rejected command still produces a paired
 * "handling … " / "failed … " log line — observability for inputs that
 * never made it to the handler.
 *
 * Order: must be the OUTERMOST behaviour. mediatr-ts orders the
 * behaviour chain last-pushed = outermost (see
 * `OrderedMappings.add` + `byOrder` in mediatr-ts), so workspace
 * pkg's `index.ts` registers behaviours bottom-up
 * (Transaction → Validation → Logging).
 *
 * Mirrors eShop's `Application/Behaviors/LoggingBehavior.cs`.
 */
@injectable()
export class LoggingBehavior implements PipelineBehavior {
  constructor(@inject(LOGGER) private readonly logger: Logger = silentLogger) {}

  async handle(request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    const name = (request as { constructor: { name: string } }).constructor.name;
    this.logger.debug({ command: name }, "handling command");
    try {
      const response = await next();
      this.logger.debug({ command: name }, "command handled");
      return response;
    } catch (err) {
      this.logger.warn({ command: name, err }, "command failed");
      throw err;
    }
  }
}

pipelineBehaviorDecorator(LoggingBehavior);
