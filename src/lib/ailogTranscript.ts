export interface TranscriptFailure {
  code: string;
  retryable: boolean;
  message: string;
  technical: string;
}

/** Keep backend reasons intact; legacy string failures remain transient. */
export function transcriptFailure(error: unknown): TranscriptFailure {
  if (error && typeof error === "object" && "code" in error && "retryable" in error && "message" in error) {
    const value = error as TranscriptFailure;
    return { code: value.code, retryable: value.retryable === true, message: value.message, technical: value.technical ?? "" };
  }
  if (typeof error === "string") {
    try { return transcriptFailure(JSON.parse(error)); } catch { /* Legacy backend. */ }
    if (/unsupported transcript kind/i.test(error)) return { code: "unsupported_kind", retryable: false, message: "この種類の会話は本文の表示に対応していません。", technical: error };
    if (/source not found|no such file|os error 2/i.test(error)) return { code: "not_found", retryable: false, message: "この会話の元の記録と控えが見つかりません。", technical: error };
  }
  return { code: "temporarily_unavailable", retryable: true, message: "会話の記録を一時的に読めません。時間をおいて再試行してください。", technical: String(error) };
}
