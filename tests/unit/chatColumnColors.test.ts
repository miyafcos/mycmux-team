import { describe, expect, it } from "vitest";

import { KIND_COLORS } from "../../src/lib/agentKindColors";
import { CHAT_COLUMN_COLORS, chatColumnColor } from "../../src/lib/chatColumnColors";

const ACCENT = "#0A84FF";
const AGENT_COLORS = Object.values(KIND_COLORS).map((color) => color.fg.toLowerCase());

describe("chatColumnColor", () => {
  it("returns five mutually distinct colors", () => {
    expect(CHAT_COLUMN_COLORS).toHaveLength(5);
    expect(new Set(CHAT_COLUMN_COLORS.map((color) => color.toLowerCase())).size).toBe(5);
    expect(CHAT_COLUMN_COLORS.map((_, index) => chatColumnColor(index))).toEqual([...CHAT_COLUMN_COLORS]);
  });

  it("returns undefined for out-of-range indexes", () => {
    expect(chatColumnColor(-1)).toBeUndefined();
    expect(chatColumnColor(5)).toBeUndefined();
    expect(chatColumnColor(1.5)).toBeUndefined();
    expect(chatColumnColor(Number.NaN)).toBeUndefined();
  });

  it("does not reuse the accent or agent-kind palette", () => {
    const reserved = new Set([ACCENT.toLowerCase(), ...AGENT_COLORS]);
    for (const color of CHAT_COLUMN_COLORS) {
      expect(reserved.has(color.toLowerCase())).toBe(false);
    }
  });
});
