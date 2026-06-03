/**
 * Compile-time public API guard for `@emploke/terminal`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the pkg's public surface
 *   at the TYPE level. `@emploke/terminal` has no central Service
 *   class — its public surface is a set of free functions
 *   (`spawnTerminal`, `spawnTerminalWith`, `whichSyncDefault`), error
 *   classes (`NoTerminalFoundError`, `TerminalSpawnFailedError`,
 *   `UnsupportedPlatformError`), and DTOs / option shapes
 *   (`LaunchCommand`, `Launcher`, `SpawnHandle`, `SpawnTerminalDeps`,
 *   `SpawnTerminalResult`). Each gets a `expectTypeOf(...)` assertion
 *   below.
 *
 * WHY it is valuable:
 *   Silent renames (`spawnTerminal` → `launchTerminal`), accidental
 *   removals, and DTO-field drift on `LaunchCommand` break downstream
 *   pkgs at compile time — but only the downstream pkg's typecheck
 *   sees the failure, which means breakage surfaces in a sibling PR
 *   (or worse, in `dashboard`) instead of in the pkg that caused it.
 *   This guard pulls the failure forward:
 *   `pnpm --filter @emploke/terminal typecheck` fails the moment the
 *   public surface drifts, BEFORE the downstream consumer notices.
 *
 *   `@emploke/session` consumes terminal's `spawnTerminal` STRUCTURALLY
 *   via a `SpawnFn` port — locking `LaunchCommand` and
 *   `SpawnTerminalResult` here keeps that structural seam stable.
 *
 * WHEN it runs:
 *   - At `pnpm typecheck` time: every `expectTypeOf` assertion is
 *     evaluated by tsc — that is where the real check happens.
 *   - At `pnpm test` time: the file loads and the `describe(...)` /
 *     `it(...)` bodies execute, but `expectTypeOf` is a no-op at
 *     runtime — vitest reports the cases as passing trivially.
 *   - `expectTypeOf` has zero runtime cost; the cost is paid once at
 *     compile time.
 *
 * HOW to extend it:
 *   Every time you ADD / RENAME / REMOVE an exported function, error
 *   class, or DTO field, update the matching `expectTypeOf` line in
 *   the SAME PR. Review enforces the coupling — a public-surface
 *   change without a guard update is a missing assertion.
 *
 * Worked example: see `packages/catalog/test/public-api-guard.test.ts`
 * for a fully-populated version locking 25+ methods and 19 error
 * classes on a real BC.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  type LaunchCommand,
  type Launcher,
  NoTerminalFoundError,
  type SpawnHandle,
  type SpawnTerminalDeps,
  type SpawnTerminalResult,
  spawnTerminal,
  spawnTerminalWith,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
  whichSyncDefault,
} from "../src/index.js";

describe("@emploke/terminal public API guard", () => {
  it("exports the concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new NoTerminalFoundError(),
      new TerminalSpawnFailedError("wt", "ENOENT"),
      new UnsupportedPlatformError("aix"),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the public DTO + option shapes", () => {
    // LaunchCommand — the SHARED structural seam with @emploke/session
    // (consumed via the `SpawnFn` port) and @emploke/runtime (produced
    // by `Runtime.buildInteractiveLaunch`). Field renames here break
    // both producers and consumers simultaneously, so the assertions
    // act as a single chokepoint for the cross-pkg contract.
    expectTypeOf<LaunchCommand>().toHaveProperty("cmd");
    expectTypeOf<LaunchCommand>().toHaveProperty("args");
    expectTypeOf<LaunchCommand>().toHaveProperty("cwd");
    expectTypeOf<LaunchCommand>().toHaveProperty("display");
    expectTypeOf<LaunchCommand>().toHaveProperty("env");

    // Spawner ports / handles.
    expectTypeOf<SpawnHandle>().toHaveProperty("earlyFailure");
    expectTypeOf<SpawnTerminalResult>().toHaveProperty("launcher");

    // Dependency injection seam for spawnTerminalWith. Every field
    // must remain because test fixtures across the monorepo construct
    // a real `SpawnTerminalDeps` literal — a missing key would break
    // every consumer's test.
    expectTypeOf<SpawnTerminalDeps>().toHaveProperty("spawn");
    expectTypeOf<SpawnTerminalDeps>().toHaveProperty("exists");
    expectTypeOf<SpawnTerminalDeps>().toHaveProperty("whichSync");
    expectTypeOf<SpawnTerminalDeps>().toHaveProperty("platform");
    expectTypeOf<SpawnTerminalDeps>().toHaveProperty("env");
    expectTypeOf<SpawnTerminalDeps>().toHaveProperty("observationMs");

    // Launcher is a closed string union — dashboard renders it
    // verbatim, so any drift surfaces here first.
    expectTypeOf<Launcher>().toEqualTypeOf<
      | "wt"
      | "cmd"
      | "Terminal"
      | "gnome-terminal"
      | "kgx"
      | "konsole"
      | "xfce4-terminal"
      | "mate-terminal"
      | "tilix"
      | "wezterm"
      | "alacritty"
      | "kitty"
      | "lxterminal"
      | "xterm"
      | "x-terminal-emulator"
    >();
  });

  it("preserves the exported function signatures", () => {
    // spawnTerminal: zero-config wrapper used by api/server / session's spawnFn.
    expectTypeOf(spawnTerminal).toBeFunction();
    expectTypeOf(spawnTerminal).parameters.toEqualTypeOf<
      [LaunchCommand, Partial<SpawnTerminalDeps>?]
    >();
    expectTypeOf(spawnTerminal).returns.resolves.toEqualTypeOf<SpawnTerminalResult>();

    // spawnTerminalWith: testable variant exposing the dep-injection seam.
    expectTypeOf(spawnTerminalWith).toBeFunction();

    // whichSyncDefault: PATH lookup helper consumed by test fixtures.
    expectTypeOf(whichSyncDefault).toBeFunction();
  });
});
