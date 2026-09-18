export const persistenceStrings = {
  unsupportedSchema: (schemaVersion: number): string => `対応していない保存データ（schema ${schemaVersion}）を検出したため、この起動中は保存を停止しました。元の data.json は変更していません。`,
  hydrationFailed: "保存データの読み込みに失敗したため、この起動中は保存を停止しました。ワークスペースは保存できていません。",
  unsupportedPlatform: "この環境では data.json を安全に保存できないため、この起動中は保存を停止しました。元の data.json は変更していません。",
  invalidPayloadSchema: (schemaVersion: number): string => `保存しようとした data.json の schema ${schemaVersion} が現在の形式と一致しないため、この起動中は保存を停止しました。元の data.json は変更していません。`,
  unsavedQuit: "ワークスペースを保存できていません。保存せずに終了しますか？",
  detachedWindowFallback: (count: number): string =>
    `前回ウィンドウに切り離していた ${count} 件を、ウィンドウを開けなかったためこの画面に戻しました。`,
} as const;
