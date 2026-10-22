import { formatCount, formatMoney, type AccountingTotals } from "../../lib/ailog";
import { noteStyle } from "./ui";

export function AccountingNote({ accounting, sessionOnly = false }: { accounting?: AccountingTotals; sessionOnly?: boolean }) {
  if (!accounting) return null;
  return (
    <div aria-label="集計の対象と除外" style={{ ...noteStyle, display: "flex", flexDirection: "column", gap: 4 }}>
      <div>{sessionOnly ? "以下はこの会話自身の集計内訳です。" : "合計は親と子の使用を含みます。子の行を開閉しても合計は変わりません。"}</div>
      {accounting.legacyUsd > 0 && <div>合計のうち、親子の区別なし（元ログなし）：{formatMoney(accounting.legacyUsd)}</div>}
      <div>合計外：写し・再通知の疑い {formatCount(accounting.suspectedDuplicateRows)}件・{formatMoney(accounting.suspectedDuplicateUsd)}／照合済みの写し {formatCount(accounting.confirmedDuplicateRows)}件・{formatMoney(accounting.confirmedDuplicateUsd)}／未確定 {accounting.unresolvedRows === undefined ? "" : `${formatCount(accounting.unresolvedRows)}件・`}{formatMoney(accounting.unresolvedUsd)}</div>
      <div>疑いは重複の確定ではありません。金額はログから計算した参考値で、請求額ではありません。</div>
    </div>
  );
}
