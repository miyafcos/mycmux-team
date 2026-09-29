import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanAskQuestion, type AskScreen } from "../../src/lib/askQuestionScan";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/askQuestionScreens.json", import.meta.url), "utf8"),
) as Record<"single" | "tabbed" | "review" | "multiSelect", string[]>;

const expectedSingle: AskScreen = {
  kind: "single",
  multiSelect: false,
  tabs: [],
  header: "Fixture",
  question: "Which layout do you prefer?",
  options: [
    {
      index: 1,
      label: "Compact",
      description:
        "余白を削って情報を詰め込むレイアウト。一画面に多くの項目が入るが、行間が狭く視認性は下がる。",
      current: true,
      role: "option",
    },
    {
      index: 2,
      label: "Roomy",
      description:
        "余白と行間を広く取って読みやすさを優先するレイアウト。一画面の情報量は減るが、長時間の閲覧でも疲れにくい。",
      current: false,
      role: "option",
    },
    {
      index: 3,
      label: "Auto",
      description:
        "ウィンドウ幅と項目数に応じて Compact と Roomyを自動切り替え。調整不要だが、切り替わるタイミングが読みにくい場面もある。",
      current: false,
      role: "option",
    },
    {
      index: 4,
      label: "Type something.",
      current: false,
      role: "typeSomething",
    },
    {
      index: 5,
      label: "Chat about this",
      current: false,
      role: "chatAbout",
    },
  ],
};

const expectedTabbed: AskScreen = {
  kind: "tabbed",
  multiSelect: false,
  tabs: [
    { label: "Theme", answered: false, active: true },
    { label: "Density", answered: false, active: false },
  ],
  header: "Theme",
  question: "Which theme?",
  options: [
    {
      index: 1,
      label: "Light",
      description: "明るい背景に暗い文字。明るい場所向き",
      current: true,
      role: "option",
    },
    {
      index: 2,
      label: "Dark",
      description: "暗い背景に明るい文字。夜間・長時間向き",
      current: false,
      role: "option",
    },
    {
      index: 3,
      label: "Type something.",
      current: false,
      role: "typeSomething",
    },
    {
      index: 4,
      label: "Chat about this",
      current: false,
      role: "chatAbout",
    },
  ],
};

const expectedReview: AskScreen = {
  kind: "review",
  multiSelect: false,
  tabs: [
    { label: "Theme", answered: true, active: false },
    { label: "Density", answered: true, active: false },
  ],
  question: "Ready to submit your answers?",
  options: [
    {
      index: 1,
      label: "Submit answers",
      current: true,
      role: "submit",
    },
    {
      index: 2,
      label: "Cancel",
      current: false,
      role: "option",
    },
  ],
};

const expectedMultiSelect: AskScreen = {
  kind: "tabbed",
  multiSelect: true,
  tabs: [{ label: "Modules", answered: false, active: true }],
  header: "Modules",
  question: "Which modules to enable?",
  options: [
    {
      index: 1,
      label: "Auth",
      description: "ログイン・セッション・権限管理",
      checked: false,
      current: true,
      role: "option",
    },
    {
      index: 2,
      label: "Billing",
      description: "課金・請求・サブスク管理",
      checked: false,
      current: false,
      role: "option",
    },
    {
      index: 3,
      label: "Search",
      description: "全文検索・インデックス機能",
      checked: false,
      current: false,
      role: "option",
    },
    {
      index: 4,
      label: "Type something",
      checked: false,
      current: false,
      role: "typeSomething",
    },
    {
      index: null,
      label: "Submit",
      current: false,
      role: "submit",
    },
    {
      index: 5,
      label: "Chat about this",
      current: false,
      role: "chatAbout",
    },
  ],
};

describe("scanAskQuestion", () => {
  it.each([
    ["single", expectedSingle],
    ["tabbed", expectedTabbed],
    ["review", expectedReview],
    ["multiSelect", expectedMultiSelect],
  ] as const)("parses the %s fixture in full", (key, expected) => {
    expect(scanAskQuestion(fixtures[key])).toEqual(expected);
  });

  it("accepts the legacy arrow tab grammar", () => {
    const legacy = fixtures.tabbed.map((line) => (
      line === "☐  ☐ Theme  ☐ Density  ✔ Submit  ▶"
        ? "←  ☐ Theme  ☐ Density  ✔ Submit  →"
        : line
    ));
    expect(scanAskQuestion(legacy)).toEqual(expectedTabbed);
  });

  it("preserves tab labels that contain spaces", () => {
    const lines = fixtures.tabbed.map((line) => (
      line === "☐  ☐ Theme  ☐ Density  ✔ Submit  ▶"
        ? "☐  ☐ Output format  ☐ Density  ✔ Submit  ▶"
        : line === "Which theme?"
          ? "Which Output format?"
          : line
    ));
    expect(scanAskQuestion(lines)?.tabs).toEqual([
      { label: "Output format", answered: false, active: true },
      { label: "Density", answered: false, active: false },
    ]);
  });

  it("joins wrapped question lines before the option cluster", () => {
    const lines = fixtures.single.flatMap((line) => (
      line === "Which layout do you prefer?"
        ? ["Which layout do", "you prefer?"]
        : [line]
    ));
    expect(scanAskQuestion(lines)?.question).toBe("Which layout do you prefer?");
  });

  it("keeps a numbered question out of the option cluster", () => {
    const lines = fixtures.single.map((line) => (
      line === "Which layout do you prefer?" ? "2026. Which layout do you prefer?" : line
    ));
    expect(scanAskQuestion(lines)?.question).toBe("2026. Which layout do you prefer?");
  });

  it("does not let an older review marker classify a newer question", () => {
    expect(scanAskQuestion([
      ...fixtures.review,
      ...fixtures.single,
    ])?.kind).toBe("single");
  });

  it.each([
    ["empty input", []],
    ["ordinary shell output", ["PS C:\\>", "git status", "On branch master", "nothing to commit"]],
    ["truncated prompt (footer scrolled off)", fixtures.single.slice(0, -1)],
    ["stale prompt followed by ordinary output", [...fixtures.single, "command completed"]],
    [
      "tab bar present but unparseable",
      [
        "────────────────────────────────────────",
        "\u2190  \u2610   \u2192",
        "Which theme?",
        "\u276F 1. Light",
        "Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel",
      ],
    ],
  ])("returns null for %s", (_name, lines) => {
    expect(scanAskQuestion(lines)).toBeNull();
  });

  it("rejects an old prompt when newer output follows its footer", () => {
    expect(scanAskQuestion([...fixtures.single, "Working on the next turn"])).toBeNull();
  });
});
