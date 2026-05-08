import type { Launcher } from "./types.js";

export class NoTerminalFoundError extends Error {
  override readonly name = "NoTerminalFoundError";
  constructor() {
    super("No supported terminal emulator was found on this system.");
  }
}

export class TerminalSpawnFailedError extends Error {
  override readonly name = "TerminalSpawnFailedError";
  constructor(
    public readonly launcher: Launcher,
    public readonly reason: string,
  ) {
    super(`Failed to launch ${launcher}: ${reason}`);
  }
}

export class UnsupportedPlatformError extends Error {
  override readonly name = "UnsupportedPlatformError";
  constructor(public readonly platform: string) {
    super(`Unsupported platform for terminal launch: ${platform}`);
  }
}
