import type { LiveSessionBrief, SemanticEventEnvelope } from "../../lib/livebrief";
import type { AskQuestionSessionState } from "../../stores/askQuestionStore";
import { questionModel } from "./interventionRouting";

export interface AskStripSource {
  tabId: string;
  sessionId: string;
  label: string;
  brief: LiveSessionBrief | undefined;
  events: readonly SemanticEventEnvelope[] | undefined;
  ask?: AskQuestionSessionState;
}

export interface AskStripItem { tabId: string; sessionId: string; label: string; prompt: string; }

export function buildAskStripItems(sources: readonly AskStripSource[]): AskStripItem[] {
  return sources.flatMap((source) => {
    const screenPrompt = source.ask?.screen?.question?.trim();
    if (screenPrompt) {
      return [{ tabId: source.tabId, sessionId: source.sessionId, label: source.label, prompt: screenPrompt }];
    }
    const question = questionModel(source.brief, source.events);
    return question ? [{ tabId: source.tabId, sessionId: source.sessionId, label: source.label, prompt: question.prompt }] : [];
  });
}
