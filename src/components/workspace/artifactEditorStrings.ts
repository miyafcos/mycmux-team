// 文書編集ツールバーの文言。
// この 1 本だけ最後まで英語で、ペインの他の操作が日本語になったあとは
// 開いた瞬間に言語が切り替わって見えていた。状態ピルの短い語 (処理中・
// 未保存・編集中・プレビュー) は幅が狭いので、tooltip と分けて持つ。
export const artifactEditorStrings = {
  statusBusy: "処理中",
  statusBusyPill: "処理中",
  statusDirty: "未保存の変更",
  statusDirtyPill: "未保存",
  statusEditing: "編集中",
  statusEditingPill: "編集中",
  statusPreview: "プレビュー表示",
  statusPreviewPill: "プレビュー",
  noSourceFile: "元ファイルなし",

  startEdit: "この文書を編集",
  openInDesktopApp: "既定のアプリで開く",
  showLocation: "ファイルの場所を表示",
  fileActions: "ファイル操作",
  reloadFromDisk: "ディスクから読み直す",
  discardEdits: "編集を破棄して閲覧に戻る",

  textFormatting: "文字の書式",
  bold: "太字",
  italic: "斜体",
  fontFamily: "フォント",
  fontFamilyPlaceholder: "フォント",
  fontSize: "文字サイズ",
  fontSizePlaceholder: "サイズ",

  paragraphFormatting: "段落の書式",
  alignLeft: "左揃え",
  alignCenter: "中央揃え",
  alignRight: "右揃え",
  outdent: "インデントを減らす",
  indent: "インデントを増やす",

  documentStructure: "文書の構造",
  heading: "見出し",
  bulletList: "箇条書き",
  numberedList: "番号付きリスト",

  insert: "挿入",
  link: "リンク",
  equation: "数式",

  tableEditing: "表の編集",
  addRow: "行を追加",
  addColumn: "列を追加",
  deleteRow: "行を削除",
  deleteColumn: "列を削除",
} as const;
