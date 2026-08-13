import { describe, expect, it } from "vitest";

import { detectPromptShape } from "../../src/lib/promptShape";

describe("detectPromptShape", () => {
  it("detects a question with an option within three following physical lines", () => {
    expect(detectPromptShape(["Would you like to run this command?", "", "1. Yes", "2. No"]))
      .toEqual({ line: 0, kind: "question" });
    expect(detectPromptShape(["Continue?", "", "", "", "[y/N]"]))
      .toBeNull();
  });

  it("detects two adjacent cursor choices without a question", () => {
    expect(detectPromptShape(["> Yes, I trust this folder", "> No"])).toEqual({ line: 0, kind: "choice" });
    expect(detectPromptShape(["> Yes, I trust this folder"])).toBeNull();
  });

  it("detects an unfinished field only when no later meaningful line exists", () => {
    expect(detectPromptShape(["Repository path:", "", "Context 20% used ·"]))
      .toEqual({ line: 0, kind: "field" });
    expect(detectPromptShape(["Repository path:", "entered value"])).toBeNull();
  });

  it("recognizes representative agent and shell prompts by shape", () => {
    expect(detectPromptShape(["Choose an action", "❯ 1. Yes", "  2. No"]))
      .toEqual({ line: 1, kind: "choice" });
    expect(detectPromptShape(["Would you like to run this command?", "1. Yes", "2. No"]))
      .toEqual({ line: 0, kind: "question" });
    expect(detectPromptShape(["Proceed?", "[y/N]"]))
      .toEqual({ line: 0, kind: "question" });
    expect(detectPromptShape(["Do you trust the contents of this project?", "> Yes, I trust this folder"]))
      .toEqual({ line: 0, kind: "question" });
  });

  it("excludes status and border decoration", () => {
    expect(detectPromptShape(["? for shortcuts", "────", "│ CTX 1 │ $1 │ API ok │"])).toBeNull();
  });
});
