import type { AgentDefinition } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { getDefaultShell } from "./ipc";

// Resolved at runtime via IPC — falls back to /bin/bash until loaded
let _detectedShell = { command: "/bin/bash", args: [] as string[] };
let _runtimeLeaf: string | undefined;

function bashLauncherScript(): string {
  return _runtimeLeaf ? `$HOME/${_runtimeLeaf}/bin/launcher.sh` : "";
}

function powerShellLauncherCommand(): string {
  if (!_runtimeLeaf) return "Write-Host 'mycmux launcher profile could not be verified; refusing to launch it.'";
  return `$launcher = Join-Path $HOME '${_runtimeLeaf}\\bin\\launcher.ps1'; if (Test-Path -LiteralPath $launcher) { & $launcher } else { Write-Host 'mycmux launcher is not installed. Restart mycmux or reinstall the latest version.' }`;
}

function cmdLauncherCommand(): string {
  if (!_runtimeLeaf) return "echo mycmux launcher profile could not be verified; refusing to launch it.";
  return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\\${_runtimeLeaf}\\bin\\launcher.ps1"`;
}

export async function initDefaultShell(): Promise<void> {
  try {
    _detectedShell = await getDefaultShell();
  } catch { /* keep fallback */ }
  try {
    const profile = await invoke<string | null>("get_test_profile");
    _runtimeLeaf = profile ? `.mycmux-${profile}` : ".mycmux";
  } catch { /* Unknown profile state must not launch through production paths. */ }
}

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "shell-starter",
    name: "Launch Menu",
    description: "Choose Claude, Codex, Grok, claude-codex, or a shell",
    get command() { return _detectedShell.command; },
    get args() {
      if (isBashLikeShell(_detectedShell.command)) {
        if (!bashLauncherScript()) return _detectedShell.args;
        return [
          "-i",
          "-c",
          `if [ -f "${bashLauncherScript()}" ]; then source "${bashLauncherScript()}"; fi; exec "\${SHELL:-/bin/bash}" -i`,
        ];
      }
      if (isPowerShellLikeShell(_detectedShell.command)) {
        return [
          "-NoLogo",
          "-NoExit",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          powerShellLauncherCommand(),
        ];
      }
      if (isCmdLikeShell(_detectedShell.command)) {
        return ["/d", "/k", cmdLauncherCommand()];
      }
      return _detectedShell.args;
    },
    icon: ">",
    color: "#f9e2af",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Default system shell",
    get command() { return _detectedShell.command; },
    get args() { return _detectedShell.args; },
    icon: "$",
    color: "#a6e3a1",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic AI coding agent",
    command: "claude",
    args: [],
    icon: "C",
    color: "#89b4fa",
  },
  {
    id: "codex",
    name: "Codex CLI",
    description: "OpenAI coding agent",
    command: "codex",
    args: ["--no-alt-screen"],
    icon: "X",
    color: "#f5c2e7",
  },
  {
    id: "grok",
    name: "Grok Build",
    description: "xAI coding agent",
    command: "grok",
    args: ["--no-alt-screen"],
    icon: "K",
    color: "#f38ba8",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google AI coding agent",
    command: "gemini",
    args: [],
    icon: "G",
    color: "#f9e2af",
  },
  {
    id: "aider",
    name: "Aider",
    description: "AI pair programming",
    command: "aider",
    args: [],
    icon: "A",
    color: "#94e2d5",
  },
];

export function getAgent(id: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS.find((a) => a.id === id);
}

export function getDefaultAgent(): AgentDefinition {
  return BUILT_IN_AGENTS[0];
}

function shellLeaf(command: string): string {
  return command.toLowerCase().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|com)$/, "") ?? command.toLowerCase();
}

function isBashLikeShell(command: string): boolean {
  const leaf = shellLeaf(command);
  return leaf === "bash" || leaf === "sh";
}

function isPowerShellLikeShell(command: string): boolean {
  const leaf = shellLeaf(command);
  return leaf === "powershell" || leaf === "pwsh";
}

function isCmdLikeShell(command: string): boolean {
  return shellLeaf(command) === "cmd";
}
