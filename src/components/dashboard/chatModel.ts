import type { SemanticEventEnvelope } from "../../lib/livebrief";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "question" | "error";
  text: string;
  at: number;
}

export function toChatMessages(events: readonly SemanticEventEnvelope[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const envelope of events) {
    const event = envelope.kind;
    if (event.type === "agentMessage") {
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") {
        previous.text = `${previous.text}\n\n${event.text}`;
        previous.at = envelope.occurredAt;
      } else {
        messages.push({ id: envelope.eventId, role: "assistant", text: event.text, at: envelope.occurredAt });
      }
      continue;
    }
    if (event.type === "userMessage") messages.push({ id: envelope.eventId, role: "user", text: event.text, at: envelope.occurredAt });
    else if (event.type === "question") messages.push({ id: envelope.eventId, role: "question", text: event.prompt, at: envelope.occurredAt });
    else if (event.type === "error") messages.push({ id: envelope.eventId, role: "error", text: event.text, at: envelope.occurredAt });
  }
  return messages;
}
