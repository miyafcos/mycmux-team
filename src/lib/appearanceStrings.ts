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
  backgroundPresetAriaLabel: "背景の見え方",
  backgroundPresetSolid: "塗りつぶし",
  backgroundPresetFrosted: "すりガラス",
  backgroundPresetClear: "クリア",
  backgroundPresetCustom: "カスタム",
  backgroundPresetHint: "塗りつぶし: 壁紙を隠す ／ すりガラス: 壁紙をうっすら ／ クリア: 壁紙が素通し (文字が読みにくければすりガラスへ)",
  backgroundPresetCustomHint: "スライダーで調整中 (詳しく調整)",
  backgroundOpacityHint: "低いほど壁紙が見え、文字は読みにくくなります",
  solidSurfacesSlidersDisabled: "塗りつぶし中は効きません",
} as const;
