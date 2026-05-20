import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { CommandValidatorRegistry } from "../validations/command-validator-registry.js";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Outermost pipeline behaviour. Runs the registered per-command
 * validator (if any) before the request enters `TransactionBehavior` -
 * so validation failures throw without ever opening a DB transaction.
 *
 * Order matters: this behaviour MUST be registered BEFORE
 * `TransactionBehavior` so mediatr-ts puts it outside in the
 * pipelineBehaviors registry. Workspace pkg's `index.ts` enforces
 * this via the import order of the two behaviour files.
 *
 * Mirrors eShop's `Application/Behaviors/ValidatorBehavior.cs`
 * (FluentValidation in C#, Zod in TS); validators throw typed
 * domain errors (mapped to wire 400/409) instead of returning a
 * `ValidationResult` so the rest of the pipeline can short-circuit
 * uniformly via the standard async-throw path.
 */
@injectable()
export class ValidationBehavior implements PipelineBehavior {
  constructor(
    @inject(CommandValidatorRegistry) private readonly registry: CommandValidatorRegistry,
  ) {}

  async handle(request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    const validator = this.registry.resolve(request);
    if (validator) {
      await validator.validate(request);
    }
    return await next();
  }
}

pipelineBehaviorDecorator(ValidationBehavior);
