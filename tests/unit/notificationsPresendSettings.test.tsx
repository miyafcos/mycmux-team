// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsLayoutTab } from "../../src/components/settings/tabs/NotificationsLayoutTab";
import { notificationSettingsStrings } from "../../src/components/settings/settingsStrings";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAiSettingsStore.setState({ aiEnabled: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

function render(presendReadingEnabled: boolean) {
  useSettingsStore.setState({ presendReadingEnabled, presendReadingProvider: "codex" });
  act(() => root.render(<NotificationsLayoutTab />));
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useSettingsStore.setState({ presendReadingEnabled: false, presendReadingProvider: "claude" });
  vi.unstubAllGlobals();
});

describe("pre-send reading disclosures", () => {
  it("lists the draft, reply tail, and folder name before consent", () => {
    render(false);
    const label = [...host.querySelectorAll("label")].find(label => label.textContent === notificationSettingsStrings.presendReadingLabel);
    expect(label?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(host.textContent).toContain(
      "入力欄に打った書きかけの文全体、そのタブの直前の返答の末尾（出どころを確認できた場合）、作業フォルダの名前を、送信の前に補助 AI へ渡します。"
    );
    expect(host.textContent).toContain(
      "停止を保存できたタブは、別のウィンドウへ移しても停止したままです。保存に失敗したときや移動を取り消したときは、編集を続けるウィンドウで停止を確認してください。読みが出るのは、そのタブの端末の中で、見分けられるエージェント (Claude Code・Codex・Grok・Antigravity・Hermes など) が動いていることを確かめられたときだけです。Cursor Agent のプロセスは見分けられないので、Cursor Agent だけが動いている間は読みは出ません。エージェントと同じ名前のプログラム (codex.js など) が端末で動いていると、エージェントが動いていると見なします。"
    );
  });

  it("discloses file reads alongside the selectable, saved Codex choice", () => {
    render(true);
    const option = host.querySelector<HTMLOptionElement>('option[value="codex"]')!;
    const select = option.closest("select")!;
    expect(option.disabled).toBe(false);
    expect(select.value).toBe("codex");
    expect(useSettingsStore.getState().presendReadingProvider).toBe("codex");
    const description = document.getElementById(select.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(
      "Codex を選ぶと、補助 AI はこの PC のファイルを読める状態で動きます（読み取りをすべて止める設定がないため）。"
    );
  });
});
