import { formatCount } from "../../lib/ailog";
import { jobDisplayError, useAilogJobStore } from "../../stores/useAilogJobStore";
import { Chip } from "./ui";

/** Quiet one-line index status. No bar, ETA, or byte counts. */
export function IndexBadge() {
  const index = useAilogJobStore((state) => state.index);
  const running = index.status?.running ?? false;
  const progress = index.progress;
  const error = jobDisplayError(index);

  if (running) {
    const discovering = !progress || (progress.phase !== "parsing" && progress.phase !== "done");
    if (discovering) return <Chip>ファイルを確認中…</Chip>;
    const done = progress?.filesDone ?? index.status?.filesDone ?? 0;
    const total = progress?.filesTotal ?? index.status?.filesTotal ?? 0;
    return <Chip>{`分析中… ${formatCount(done)}/${formatCount(total)}`}</Chip>;
  }

  if (error && index.autoStarted) {
    return (
      <Chip tone="warn">
        自動取り込みに失敗 · メニューから再実行
      </Chip>
    );
  }

  return null;
}
