import { expect, it } from "vitest";
import { persistenceStrings } from "../../src/lib/persistenceStrings";

it.each([
  ["unsupportedSchema", `対応していない保存データ（schema 999）を検出したため、この起動中は保存を停止しました。元の data.json は変更していません。`, () => persistenceStrings.unsupportedSchema(999)],
  ["hydrationFailed", "保存データの読み込みに失敗したため、この起動中は保存を停止しました。ワークスペースは保存できていません。", () => persistenceStrings.hydrationFailed],
  ["unsupportedPlatform", "この環境では data.json を安全に保存できないため、この起動中は保存を停止しました。元の data.json は変更していません。", () => persistenceStrings.unsupportedPlatform],
  ["invalidPayloadSchema", `保存しようとした data.json の schema 999 が現在の形式と一致しないため、この起動中は保存を停止しました。元の data.json は変更していません。`, () => persistenceStrings.invalidPayloadSchema(999)],
  ["unsavedQuit", "ワークスペースを保存できていません。保存せずに終了しますか？", () => persistenceStrings.unsavedQuit],
] as const)("preserves the approved %s diagnostic", (_key, expected, actual) => {
  expect(actual()).toBe(expected);
});
