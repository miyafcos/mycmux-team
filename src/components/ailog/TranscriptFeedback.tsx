import { transcriptFailure } from "../../lib/ailogTranscript";
import { noteStyle, subtleButtonStyle } from "./ui";

export function TranscriptFeedback({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (!error) return null;
  const problem = transcriptFailure(error);
  return <div role="alert" style={{ ...noteStyle, color: "var(--cmux-red)" }}>
    {problem.message}
    {problem.retryable ? <button type="button" onClick={onRetry} style={{ ...subtleButtonStyle, marginLeft: 6 }}>再試行</button> : null}
    <details><summary>技術情報</summary>{problem.code}: {problem.technical}</details>
  </div>;
}
