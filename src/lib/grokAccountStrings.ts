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

// Every per-product window the billing API names starts with "Grok"
// (GrokBuild / GrokChat / GrokImagine), so a first-letter label renders three
// identical "G"s and the meter row stops saying which limit is which. The
// meter shows these short names instead; the full English product name stays
// in the hover copy.
export const GROK_PRODUCT_LABELS: Record<string, string> = {
  GrokBuild: "開発",
  GrokChat: "対話",
  GrokImagine: "画像",
};

/** "GrokBuild" -> "開発 (GrokBuild)" where there is room for both. */
export function grokProductName(key: string): string {
  const label = GROK_PRODUCT_LABELS[key];
  return label ? `${label} (${key})` : key;
}
