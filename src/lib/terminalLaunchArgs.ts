import type { AgentSessionKind } from "../types";

function isShellLauncher(agentId: string | undefined, command: string): boolean {
  if (agentId === "shell" || agentId === "shell-starter") return true;
  const leaf = command.toLowerCase().split(/[\\/]/).pop()?.replace(/\.exe$/, "");
  return leaf === "bash" || leaf === "sh";
}

export function buildLaunchArgs(
  command: string,
  args: string[],
  agentId: string | undefined,
  savedSession: { kind: AgentSessionKind; sessionId: string } | null,
  newSessionId: string | undefined,
  cwd: string | undefined,
  initialPrompt: string | undefined,
): string[] {
  if (isShellLauncher(agentId, command)) return args;
  if (!savedSession) {
    if (agentId === "claude-code" && newSessionId) {
      const launchArgs = [
        ...args,
        "--allow-dangerously-skip-permissions",
        "--permission-mode",
        "auto",
        "--session-id",
        newSessionId,
      ];
      return initialPrompt ? [...launchArgs, initialPrompt] : launchArgs;
    }
    return initialPrompt ? [...args, initialPrompt] : args;
  }
  switch (savedSession.kind) {
    case "claude":
      return [
        ...args.flatMap((arg, index) =>
          (arg === "--model" || arg === "--effort") && args[index + 1]
            ? [arg, args[index + 1]]
            : /^(--model|--effort)=/.test(arg) ? [arg] : [],
        ),
        "--allow-dangerously-skip-permissions",
        "--permission-mode",
        "auto",
        "--resume",
        savedSession.sessionId,
      ];
    case "codex":
      return [
        "resume",
        "--no-alt-screen",
        ...(cwd ? ["-C", cwd] : []),
        savedSession.sessionId,
      ];
    case "grok":
      return ["--no-alt-screen", "--resume", savedSession.sessionId];
    case "claude-codex":
      return ["--resume", savedSession.sessionId];
  }
  return args;
}
