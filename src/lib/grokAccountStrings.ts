// Japanese literals for the grok account/usage integration.
// Authored by the orchestrator session; implementation lanes reference these keys
// and must not add new non-ASCII literals elsewhere.
export const grokAccountStrings = {
  identityUnreadable: "grok の認証情報 (auth.json) を読み取れませんでした",
  identityInvalid: "grok の認証情報の形式が想定と異なります",
  reloginRequired: "grok login での再ログインが必要です",
  usageUnsupported: "この grok アカウントは使用量の取得に対応していません",
  weeklyWindowLabel: "週間",
  breakdownLabel: "内訳",
  authLockTimeout: "grok の認証ファイルが他のプロセスにロックされています",
} as const;
