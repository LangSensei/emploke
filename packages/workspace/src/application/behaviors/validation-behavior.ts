import { injectable, multiInject } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { CommandValidator } from "../validations/command-validator.js";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Outermost pipeline behaviour. Looks up the validator that handles
 * the request's command class and runs it before the request enters
 * `TransactionBehavior`. Validation failures throw without ever
 * opening a DB transaction.
 *
 * Validators are discovered via `@multiInject(CommandValidator)` —
 * each concrete validator binds itself to the abstract `CommandValidator`
 * service identifier and self-declares which command class it handles
 * via its `command` field. Inspired by eShop's
 * `IEnumerable<IValidator<TRequest>>` pattern, adapted to TypeScript
 * (no open generics, so we filter at handle-time by ctor identity).
 *
 * Order matters: this behaviour MUST be registered BEFORE
 * `TransactionBehavior` so mediatr-ts puts it outside in the
 * pipelineBehaviors registry. Workspace pkg's `index.ts` enforces
 * this via the import order of the two behaviour files; a unit test
 * (`workspace.di.test.ts`) asserts the resulting order so a future
 * import auto-sort won't break the contract silently.
 *
 * Mirrors eShop's `Application/Behaviors/ValidatorBehavior.cs`
 * (FluentValidation in C#, Zod in TS); validators throw typed
 * domain errors (mapped to wire 400/409) instead of returning a
 * `ValidationResult` so the rest of the pipeline can short-circuit
 * uniformly via the standard async-throw path.
 */
@injectable()
export class ValidationBehavior implements PipelineBehavior {
  constructor(@multiInject(CommandValidator) private readonly validators: CommandValidator[]) {}

  async handle(request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    const ctor = (request as { constructor: unknown }).constructor;
    const matching = this.validators.filter((v) => v.command === ctor);
    // Run all matching validators in parallel; first rejection wins
    // (mirrors eShop's `Task.WhenAll(_validators.Select(v => v.ValidateAsync(...)))`).
    // For our current 1-validator-per-command commands this is identical to a
    // single await; the shape is here to admit a second validator (e.g. a
    // cross-aggregate business check) without touching the behaviour.
    await Promise.all(matching.map((v) => v.validate(request)));
    return await next();
  }
}

pipelineBehaviorDecorator(ValidationBehavior);
