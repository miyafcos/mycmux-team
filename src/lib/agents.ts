import type { AgentDefinition } from "../types";
import { getDefaultShell } from "./ipc";

// Resolved at runtime via IPC — falls back to /bin/bash until loaded
let _detectedShell = { command: "/bin/bash", args: [] as string[] };

export async function initDefaultShell(): Promise<void> {
  try {
    _detectedShell = await getDefaultShell();
  } catch { /* keep fallback */ }
}

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "shell-starter",
    name: "Shell",
    description: "Native startup chooser",
    command: "",
    args: [],
    icon: "$",
    color: "#a6e3a1",
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
    args: [],
    icon: "X",
    color: "#f5c2e7",
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
