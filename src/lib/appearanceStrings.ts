// Japanese literals for the appearance quick-settings UI.
// Authored by the orchestrator session; implementation lanes reference these keys
// and must not add new non-ASCII literals elsewhere.
export const appearanceStrings = {
  quickTitle: "かんたん設定",
  quickNote: "テーマ・文字の大きさ・フォントをまとめて決められます。",
  sizeLabel: "文字の大きさ",
  sizeSmall: "小",
  sizeMedium: "中",
  sizeLarge: "大",
  sizeCustom: "カスタム",
  advancedToggle: "詳しく調整",
  advancedNote: "描画方式・微調整プリセット・壁紙・色の個別変更",
} as const;
