import { findAgentTabSlashCandidate, type AgentTabSlashSuggestion } from "./agentTabSlashSuggest";

/** A slash command is a single line beginning with an ASCII command name. */
export function isAgentTabSlashCommand(text: string): boolean {
  return !/[\r\n\u2028\u2029]/.test(text) && /^\/[a-z]/i.test(text.trim());
}

/** Classify the sent token, including aliases, even without a suggestion pick. */
export function agentTabSlashCommandOpensTerminal(text: string, candidates: readonly AgentTabSlashSuggestion[]): boolean {
  const name = text.trim().split(/\s/, 1)[0].slice(1);
  const command = findAgentTabSlashCandidate(name, candidates);
  return !command || command.kind === "local" || command.kind === "local-jsx";
}
