/**
 * 経過時間の日本語表記。分だけで押し通すと「3900分」のような読めない数字になるため、
 * 桁が上がったら時間・日へ繰り上げる。0 埋めや小数は出さない (読み上げも同じ語になる)。
 */
export function formatElapsedMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  if (minutes < 60) return `${minutes}分`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}時間${restMinutes}分` : `${hours}時間`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}日${restHours}時間` : `${days}日`;
}

/** ミリ秒版。負値と NaN は 0 分として扱う。 */
export function formatElapsedSince(nowMs: number, sinceMs: number): string {
  const diff = Number.isFinite(nowMs - sinceMs) ? nowMs - sinceMs : 0;
  return formatElapsedMinutes(diff / 60_000);
}
