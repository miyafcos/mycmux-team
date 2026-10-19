import { v4 as uuid } from "uuid";

const COMMAND_KEY = "MYCMUX_LAUNCH_COMMAND";
const pendingCommands = new Map<string, string>();

/** Limit is 4,096 UTF-16 code units, the same as the Rust and PowerShell guards. */
export function terminalCommandError(command: string): "single-line" | "too-long" | null {
  if (!command.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(command)) return "single-line";
  return command.length > 4096 ? "too-long" : null;
}

/** Only an opaque reference enters the tab model; command text stays in memory. */
export function buildTerminalShellLaunchEnv(command?: string): Record<string, string> {
  const env: Record<string, string> = { MYCMUX_LAUNCH_TARGET: "shell" };
  if (command !== undefined) {
    if (terminalCommandError(command)) throw new Error("Invalid terminal command");
    const reference = uuid();
    pendingCommands.set(reference, command);
    env[COMMAND_KEY] = reference;
  }
  return env;
}

/** Resolve only at the IPC boundary; the tab model never receives command text. */
export function resolveTerminalCommandEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env || !Object.prototype.hasOwnProperty.call(env, COMMAND_KEY)) return env;
  const resolved = { ...env };
  const command = env.MYCMUX_LAUNCH_TARGET === "shell" ? pendingCommands.get(env[COMMAND_KEY]) : undefined;
  delete resolved[COMMAND_KEY];
  if (command !== undefined) resolved[COMMAND_KEY] = command;
  return resolved;
}

/** Never replay automatically after a create whose acceptance may be uncertain. */
export function consumeTerminalCommandEnv(env: Record<string, string> | undefined): void {
  if (env?.[COMMAND_KEY]) pendingCommands.delete(env[COMMAND_KEY]);
}

export function takeTerminalCommandEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  const resolved = resolveTerminalCommandEnv(env);
  consumeTerminalCommandEnv(env);
  return resolved;
}
