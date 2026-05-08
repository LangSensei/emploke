import { UnknownRuntimeError } from "./errors.js";
import type { Runtime } from "./types.js";

/**
 * In-memory registry of `Runtime` implementations, keyed by their `kind`.
 * Mutable: implementations register themselves at server bootstrap. Lookup
 * is the only operation used at request time.
 *
 * Not concurrent-safe in the strict sense, but registration only happens at
 * startup and lookup is `Map.get`, so practical concurrency is not a concern.
 */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, Runtime>();

  /**
   * Add `runtime` to the registry. If a runtime with the same `kind` is
   * already registered, throws — duplicate registration is always a bug
   * (rather than silently overwriting and losing the previous instance).
   */
  register(runtime: Runtime): void {
    if (this.runtimes.has(runtime.kind)) {
      throw new Error(`runtime ${JSON.stringify(runtime.kind)} is already registered`);
    }
    this.runtimes.set(runtime.kind, runtime);
  }

  /**
   * Look up the runtime with the given `kind`. Throws `UnknownRuntimeError`
   * if no such runtime is registered — callers typically map this onto a
   * 4xx response since it indicates the on-disk session was created with
   * a runtime that the running server does not know about.
   */
  get(kind: string): Runtime {
    const r = this.runtimes.get(kind);
    if (!r) throw new UnknownRuntimeError(kind);
    return r;
  }

  /** Returns true if `kind` is registered. Cheap; intended for validation. */
  has(kind: string): boolean {
    return this.runtimes.has(kind);
  }

  /**
   * List all registered runtime kinds. Iteration order matches registration
   * order. Useful for diagnostics ("server knows about: copilot, gemini").
   */
  kinds(): string[] {
    return [...this.runtimes.keys()];
  }
}
