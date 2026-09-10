// キーボードショートカット画面の文言。
// 画面全体が英語のまま残っていて、行の名前だけが 38 件中 7 件だけ日本語という
// 状態だった。文言はここに集約し、行の名前は KEYBINDING_DEFINITIONS 側が持つ。
export const keybindingStrings = {
  title: "キーボードショートカット",
  restoreDefaults: "既定に戻す",
  done: "閉じる",
  hint: "「変更」を押してからキーを押します。Backspace か Delete で解除します。",
  conflictHeading: "重複しているショートカット:",
  rebind: "変更",
  reset: "戻す",
  pressKeys: "キーを押してください…",
} as const;
