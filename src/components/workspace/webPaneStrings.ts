// Web ペインの状態バーの文言 (2026-09-03)。
// TerminalPane / WebPaneStatusBar 側のハンドラは非 ASCII を持たず、文言はここに集約する
// (委譲先の文字化け防止・terminalPaneStrings と同じ方針)。
export const webPaneStrings = {
  shortcutWaiting: "AI の操作の返事を待っているので、mycmux のキーを止めています。",
  operatorFocus: {
    timeout: "移動先の窓から応答がありませんでした。もう一度押してください。",
    missing: "そのタブは見つかりませんでした。閉じたか、別の窓にあります。",
    notTerminal: "端末のタブではないので、前に出しませんでした。",
    closing: "そのタブは閉じている途中なので、前に出しませんでした。",
    blocked: "いまは前に出せません。開いている画面を閉じてから、もう一度押してください。",
    automation: "AI の道具がこの Web タブを操作したので、このタブのボタンでは前に出しません。タブを閉じて開き直すと、また使えます。",
  },
  // ログイン済みのときは何も出さない。出すのはサインアウト画面を掴んだときだけ。
  signedOut: (service: string) => `${service} にログインしていません。`,
  signInButton: "別の窓でログイン",
  // 一度きりであることを明示する。毎回出るなら不具合。
  signInHint: "この操作は 1 回だけです。ログイン状態はこのタブ専用のプロファイルに残ります。",
  signInRunning: (service: string) =>
    `${service} のログイン窓を開いています。ログインが終わったらその窓を閉じてください。`,
  signInFailed: "ログイン窓を開けませんでした",
  reopening: "ログイン窓を閉じたので、タブを開き直しています…",
} as const;
