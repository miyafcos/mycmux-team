/**
 * PTY launch parameters for a terminal session, plus the pure mapping onto the
 * createSession() argument shape.
 *
 * Why this exists (B-1 stale closure):
 * XTermWrapper's terminal effect is deliberately keyed on [sessionId] only — it
 * must NOT re-run when launch parameters change, because re-running disposes and
 * respawns the terminal. But the effect attaches the PTY asynchronously, and
 * TerminalPane recomputes `launchEnv` / `args` when the saved agent session for
 * the tab resolves after mount (the agent-session-mapping IPC in App.tsx races
 * the first render of the pane). Reading the props straight out of the effect
 * closure freezes them at mount time, so a resume that resolves during the
 * attach window silently degrades `claude --resume` to a fresh session.
 *
 * The fix is a latest-value ref: the effect keeps its [sessionId] deps, but the
 * launch-time reads go through a ref that every render refreshes, so the values
 * handed to the backend are the freshest ones that exist at the moment the PTY
 * is actually spawned.
 */
export interface TerminalLaunchParams {
  command: string;
  args: string[];
  cwd?: string;
  launchEnv?: Record<string, string>;
}

export interface TerminalLaunchRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Map the current launch parameters onto the createSession() arguments.
 * Pure by design so the "uses the latest values" behavior is unit-testable
 * without mounting a terminal.
 */
export function buildLaunchRequest(params: TerminalLaunchParams): TerminalLaunchRequest {
  return {
    command: params.command,
    args: params.args ?? [],
    cwd: params.cwd,
    // Historical behavior: an absent env is sent as undefined (backend treats it
    // as "no frontend env"); an empty object is still forwarded as-is.
    env: params.launchEnv || undefined,
  };
}

// Match the supported executable/shim and node/bun entry points used by the
// launcher and the Rust process detector. Arbitrary script paths are not agents.
function recoveryAgentPrefix(command: string, args: string[]): number | null {
  const leaf = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
  if (["claude", "claude-codex", "codex", "grok"].includes(leaf ?? "")) return 0;
  if (leaf !== "node" && leaf !== "bun") return null;
  if ([command, args[0] ?? ""].some(path => path.replace(/\\/g, "/").toLowerCase().includes("/openai/codex/runtimes/cua_node/"))) return null;
  const script = args[0]?.replace(/\\/g, "/").toLowerCase().split("/");
  const name = script?.[script.length - 1], parent = script?.[script.length - 2];
  if (["claude.js", "claude-codex.js", "codex.js", "grok.js"].includes(name ?? "")
    || (name === "cli.js" && ["claude", "claude-code", "claude-codex", "grok"].includes(parent ?? ""))
    || (name === "wrapper.js" && parent === "claude")) return 1;
  return null;
}

function withoutRecoveryIdentity(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--resume", "-r", "--session-id"].includes(arg)) {
      if (args[index + 1] && !args[index + 1].startsWith("-")) index++;
    } else if (!/^(--resume|-r|--session-id)=/.test(arg)) {
      result.push(arg);
    }
  }
  return result;
}

// Skip option values before interpreting a Codex subcommand or resume target.
function nextCodexPositional(args: string[], start = 0): number | null {
  const values = ["-p", "--profile", "-c", "--config", "-m", "--model", "-s", "--sandbox",
    "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--local-provider",
    "--enable", "--disable", "-i", "--image"];
  for (let index = start; index < args.length; index++) {
    if (args[index] === "--") return null;
    if (values.includes(args[index])) index++;
    else if (!args[index].startsWith("-")) return index;
  }
  return null;
}

export function buildAgentRecoveryLaunch(params: TerminalLaunchParams, kind: string, sessionId: string, fresh: boolean): TerminalLaunchParams {
  const env: Record<string, string> = { ...params.launchEnv, MYCMUX_AGENT_KIND: kind, MYCMUX_SESSION_ID: sessionId, MYCMUX_RESUME: kind };
  const prefix = recoveryAgentPrefix(params.command, params.args);
  let args = [...params.args];
  if (prefix !== null) {
    const executableArgs = args.slice(0, prefix);
    args = withoutRecoveryIdentity(args.slice(prefix));
    if (kind === "codex") {
      const subcommand = nextCodexPositional(args);
      if (subcommand !== null && args[subcommand] === "resume") {
        const target = nextCodexPositional(args, subcommand + 1);
        if (target !== null) args.splice(target, 1);
        args.splice(subcommand, 1);
      }
      if (!fresh) args.unshift("resume", sessionId);
    } else {
      args.push(fresh ? "--session-id" : "--resume", sessionId);
    }
    args = [...executableArgs, ...args];
    delete env.MYCMUX_LAUNCH_TARGET;
  } else {
    // The existing launcher owns shell quoting and provider-specific options.
    env.MYCMUX_LAUNCH_TARGET = kind;
  }
  return { ...params, args, launchEnv: env };
}
