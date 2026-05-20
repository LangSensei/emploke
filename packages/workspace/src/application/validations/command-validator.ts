import type { ZodIssue } from "zod";

export class CommandValidationError extends Error {
  readonly issues: readonly ZodIssue[];

  constructor(commandName: string, issues: readonly ZodIssue[]) {
    super(
      `${commandName} validation failed: ${issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "CommandValidationError";
    this.issues = issues;
  }
}

/**
 * Abstract base for per-command validators. Each concrete validator
 * declares which command class it validates via the `command` field —
 * this lets `ValidationBehavior` resolve the right validator for a
 * request by `request.constructor` lookup, without a separate registry
 * keyed map.
 *
 * Inspired by eShop's `AbstractValidator<TCommand>` (FluentValidation):
 * the validator's TYPE is the contract. We can't replicate C# open
 * generics in TS DI, so we surface the class reference at runtime via
 * `command` and use inversify multi-binding to enumerate validators.
 *
 * Concrete validators are bound with the abstract class as their
 * service identifier:
 *
 *     container.bind(CommandValidator).to(MyConcreteValidator);
 *
 * `ValidationBehavior` then `@multiInject(CommandValidator)`s the
 * full list and dispatches to the first match.
 */
// biome-ignore lint/suspicious/noExplicitAny: abstract class used as inversify token + structural shape; concrete validators narrow TCommand
export abstract class CommandValidator<TCommand = any> {
  /**
   * The command class this validator handles. Compared via reference
   * equality against `request.constructor` in `ValidationBehavior`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: command ctors take heterogeneous shapes
  abstract readonly command: new (...args: any[]) => TCommand;

  abstract validate(command: TCommand): Promise<void>;
}
