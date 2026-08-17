import { describe, expect, it } from "vitest";
import { isExplicitLlmIntent } from "../../src/components/ailog/panelModel";

describe("ailog panel model", () => {
  it("keeps only explicit summarize intents behind the LLM gate", () => {
    expect(isExplicitLlmIntent("startSummarize")).toBe(true);
    expect(isExplicitLlmIntent("summarizeSession")).toBe(true);
    expect(isExplicitLlmIntent("regenerateDigest")).toBe(false);
    expect(isExplicitLlmIntent("openPanel")).toBe(false);
    expect(isExplicitLlmIntent("loadUsage")).toBe(false);
  });
});
