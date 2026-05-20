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

export interface CommandValidator<TCommand> {
  validate(command: TCommand): Promise<void>;
}
