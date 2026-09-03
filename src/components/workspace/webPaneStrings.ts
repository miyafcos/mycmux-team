// Web ペインの状態バーの文言 (2026-09-03)。
// TerminalPane / WebPaneStatusBar 側のハンドラは非 ASCII を持たず、文言はここに集約する
// (委譲先の文字化け防止・terminalPaneStrings と同じ方針)。
export const webPaneStrings = {
  // ログイン済みのときは何も出さない。出すのはサインアウト画面を掴んだときだけ。
  signedOut: (service: string) => `${service} にログインしていません。`,
  signInButton: "別の窓でログイン",
  // 一度きりであることを明示する。毎回出るなら不具合。
  signInHint: "この操作は 1 回だけです。ログイン状態はこのペイン専用のプロファイルに残ります。",
  signInRunning: (service: string) =>
    `${service} のログイン窓を開いています。ログインが終わったらその窓を閉じてください。`,
  signInFailed: "ログイン窓を開けませんでした",
  reopening: "ログイン窓を閉じたので、ペインを開き直しています…",
} as const;
