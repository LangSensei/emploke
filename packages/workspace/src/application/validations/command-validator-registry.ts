import { injectable } from "inversify";
import type { CommandValidator } from "./command-validator.js";

type CommandCtor<T> = new (...args: never[]) => T;

@injectable()
export class CommandValidatorRegistry {
  private readonly validators = new Map<unknown, CommandValidator<unknown>>();

  register<T>(commandCtor: CommandCtor<T>, validator: CommandValidator<T>): void {
    this.validators.set(commandCtor, validator as CommandValidator<unknown>);
  }

  resolve<T>(command: T): CommandValidator<T> | undefined {
    const ctor = (command as { constructor: unknown }).constructor;
    return this.validators.get(ctor) as CommandValidator<T> | undefined;
  }
}
