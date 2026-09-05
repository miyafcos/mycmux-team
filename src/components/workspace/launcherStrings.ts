// ランチャーペインの文言 (2026-09-04)。
// LauncherPane.tsx 側は非 ASCII を持たず、文言はここに集約する
// (委譲先の文字化け防止・webPaneStrings / terminalPaneStrings と同じ方針)。
export const launcherStrings = {
  // 打っても打たなくても選べる、が S2 の狙い。
  searchPlaceholder: "打って探す / そのまま選ぶ",
  launch: "新規に起動",
  web: "Web",
  dev: "開発",
  anken: "案件",
  showAll: (total: number) => `すべて (${total})`,
  collapse: "たたむ",
  // セクションの壁が消えたことを明示する (S4)。
  flatCount: (count: number) => `— 横断 ${count} 件 (セクションなし) —`,
  noMatch: (query: string) => `「${query}」に一致なし`,
  // model / effort は delegation のティア運用が依存しているので必ず残す (§6.3)。
  specTooltip: (label: string) => `${label} のモデル・effort を選ぶ (Tab / Shift+Enter)`,
  specKeyHint: "←→ 選ぶ　↑↓ Tab 行　Enter 起動　Esc 戻る",
  modelLabel: "モデル",
  modelDefault: "モデル (既定)",
  effortLabel: "effort",
  effortDefault: "effort (既定)",
  // チップとして並べるときは「既定」だけで足りる (見出しが直前にある)。
  specDefault: "既定",
  launchButton: "起動",
  cancel: "やめる",
  cwdUnset: "(起動先は既定)",
  changeCwd: "変更",
  changeCwdTooltip: "起動先を変える (開発・案件をすべて開く)",
  resume: "続きから",
  resumeEmpty: "再開できるセッションがありません",
  // セクションに登録が無いとき (2026-09-05)。候補の件数は Phase 2 で足す。
  dirEmpty: "登録なし —",
  dirEmptyAction: "設定で登録",
  dirEmptyTooltip: "設定 → ランチャー を開く",
  // 候補があるときだけ件数を添える (Phase 2)。
  dirEmptyCandidates: (n: number) => `(候補 ${n} 件)`,
  // 右端に収まる長さで。日付より「どれくらい前か」の方が探しやすい。
  relativeWhen: (iso: string, now: number = Date.now()): string => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const minutes = Math.floor((now - at) / 60000);
    if (minutes < 1) return "たった今";
    if (minutes < 60) return `${minutes}分前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "昨日";
    if (days < 7) return `${days}日前`;
    return `${Math.floor(days / 7)}週間前`;
  },
} as const;
