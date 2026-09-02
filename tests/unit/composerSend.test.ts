import { describe, expect, it } from "vitest";

import {
  buildComposerPayload,
  composerKeyIntent,
  normalizeComposerText,
  resolveComposerAgentLabelKind,
  resolveComposerTarget,
  shiftEnterSequence,
  startsAsAgentTui,
} from "../../src/lib/composerSend";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CODEX_SHIFT_ENTER = "\x1b[13;2u";

describe("resolveComposerTarget", () => {
  it("trusts the declared agent kind first", () => {
    expect(resolveComposerTarget({ command: "pwsh.exe", agentKind: "claude" })).toBe("claude");
    expect(resolveComposerTarget({ command: "pwsh.exe", agentKind: "codex" })).toBe("codex");
  });

  it("routes claude-codex to the Claude input shape", () => {
    expect(resolveComposerTarget({ command: "pwsh.exe", agentKind: "claude-codex" })).toBe("claude");
  });

  it("reads the launch environment when nothing is declared", () => {
    expect(resolveComposerTarget({ command: "pwsh.exe", launchEnv: { MYCMUX_RESUME: "codex" } })).toBe("codex");
  });

  it("falls back to the command, its arguments and the live process title", () => {
    expect(resolveComposerTarget({ command: "C:/bin/claude.exe" })).toBe("claude");
    expect(resolveComposerTarget({ command: "cmd.exe", args: ["/c", "codex"] })).toBe("codex");
    expect(resolveComposerTarget({ command: "pwsh.exe", processTitle: "C:/bin/codex.exe" })).toBe("codex");
  });

  it("treats an ordinary shell as a shell", () => {
    expect(resolveComposerTarget({ command: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" })).toBe("shell");
    expect(startsAsAgentTui({ command: "powershell.exe" })).toBe(false);
    expect(startsAsAgentTui({ command: "claude" })).toBe(true);
  });
});

describe("shiftEnterSequence", () => {
  it("keeps the per-target sequences the terminal already relied on", () => {
    expect(shiftEnterSequence({ command: "codex" })).toBe(CODEX_SHIFT_ENTER);
    expect(shiftEnterSequence({ command: "claude" })).toBe(`${PASTE_START}\n${PASTE_END}`);
    expect(shiftEnterSequence({ command: "pwsh" })).toBe(`${PASTE_START}\n${PASTE_END}`);
  });
});

describe("normalizeComposerText", () => {
  it("normalises line endings, trailing spaces and the trailing newline", () => {
    expect(normalizeComposerText("a  \r\nb\t\r\n\n")).toBe("a\nb");
  });

  it("leaves multibyte text intact", () => {
    expect(normalizeComposerText("日本語のテキスト 🐈")).toBe("日本語のテキスト 🐈");
  });

  it("keeps blank lines inside the body", () => {
    expect(normalizeComposerText("a\n\nb")).toBe("a\n\nb");
  });
});

describe("buildComposerPayload", () => {
  it("wraps Claude input in a bracketed paste", () => {
    expect(buildComposerPayload({ text: "one\ntwo", target: "claude" })).toEqual({
      body: `${PASTE_START}one\ntwo${PASTE_END}`,
      submitKey: "\r",
      foldedNewlines: false,
    });
  });

  it("sends Codex newlines as its Shift+Enter key report", () => {
    expect(buildComposerPayload({ text: "one\ntwo", target: "codex" }).body)
      .toBe(`one${CODEX_SHIFT_ENTER}two`);
  });

  it("folds newlines to spaces for a shell and says so", () => {
    expect(buildComposerPayload({ text: "git add .\ngit commit", target: "shell" })).toEqual({
      body: "git add . git commit",
      submitKey: "\r",
      foldedNewlines: true,
    });
  });

  it("submits every target with a bare CR", () => {
    // The composers do not send submitKey themselves: they hand the body to
    // pane.send_text with enter:true, and that writes "\r". A target that ever
    // needs a different submit key has to stop using enter:true, so pin the
    // assumption here rather than discovering it as a pane that never submits.
    for (const target of ["claude", "codex", "shell"] as const) {
      expect(buildComposerPayload({ text: "x", target }).submitKey).toBe("\r");
    }
  });

  it("does not claim to have folded a single-line shell command", () => {
    expect(buildComposerPayload({ text: "ls", target: "shell" }).foldedNewlines).toBe(false);
  });

  it("sends nothing at all for empty or whitespace-only text", () => {
    for (const text of ["", "   ", "\n\n"]) {
      expect(buildComposerPayload({ text, target: "claude" })).toEqual({
        body: "",
        submitKey: "",
        foldedNewlines: false,
      });
    }
  });
});

describe("composerKeyIntent", () => {
  it("submits on Enter and breaks the line on Shift+Enter", () => {
    expect(composerKeyIntent({ key: "Enter" })).toBe("submit");
    expect(composerKeyIntent({ key: "Enter", shiftKey: true })).toBe("newline");
  });

  it("never submits while an IME conversion is open", () => {
    expect(composerKeyIntent({ key: "Enter", isComposing: true })).toBe("none");
    expect(composerKeyIntent({ key: "Enter", keyCode: 229 })).toBe("none");
    expect(composerKeyIntent({ key: "Escape", isComposing: true })).toBe("none");
  });

  it("closes on Escape and ignores everything else", () => {
    expect(composerKeyIntent({ key: "Escape" })).toBe("close");
    expect(composerKeyIntent({ key: "a" })).toBe("none");
    expect(composerKeyIntent({ key: "Enter", ctrlKey: true })).toBe("none");
  });
});

describe("resolveComposerAgentLabelKind", () => {
  it("names the agent even when it borrows another agent's input shape", () => {
    // Grok Build takes Claude's bracketed paste, but the composer must not
    // tell the operator they are typing at Claude.
    expect(resolveComposerTarget({ command: "pwsh.exe", agentKind: "grok" })).toBe("claude");
    expect(resolveComposerAgentLabelKind({ command: "pwsh.exe", agentKind: "grok" })).toBe("grok");
    expect(resolveComposerAgentLabelKind({ command: "pwsh.exe", agentKind: "claude-codex" })).toBe("claude-codex");
  });

  it("recognises grok from the launch command and resume env too", () => {
    expect(resolveComposerAgentLabelKind({ command: "C:/Users/x/.grok/bin/grok.exe" })).toBe("grok");
    expect(resolveComposerAgentLabelKind({ command: "pwsh.exe", launchEnv: { MYCMUX_RESUME: "grok" } })).toBe("grok");
  });

  it("falls back to the input shape for everything else", () => {
    expect(resolveComposerAgentLabelKind({ command: "pwsh.exe", agentKind: "claude" })).toBe("claude");
    expect(resolveComposerAgentLabelKind({ command: "pwsh.exe", agentKind: "codex" })).toBe("codex");
    expect(resolveComposerAgentLabelKind({ command: "pwsh.exe" })).toBe("shell");
  });
});
