// Maps raw backend OAuth error strings to user-facing Japanese guidance.
// The backend keeps its errors technical (English, includes HTTP status);
// this layer owns the human-readable presentation for the accounts dialog.

/** 429 class: the server refused the request; retrying the same code is pointless. */
export function isOauthRateLimited(raw: string): boolean {
  return /HTTP 429|rate.?limit/i.test(raw);
}

/** The pending login (and its one-time code) is dead; only a fresh authorize flow can recover. */
export function isOauthLoginExpired(raw: string): boolean {
  return /Unknown or expired login/i.test(raw);
}

/** Errors that require restarting from the authorize URL instead of re-pasting the code. */
export function needsFreshOauthLogin(raw: string): boolean {
  return isOauthRateLimited(raw) || isOauthLoginExpired(raw);
}

export function friendlyOauthError(raw: string): string {
  if (isOauthRateLimited(raw)) {
    return [
      "Anthropic 側のレート制限に達しています (HTTP 429)。",
      "このPCのIPからの認証リクエストが制限されている状態です。",
      "解除まで数時間〜1日以上かかる場合があります。再試行を繰り返すと制限が延長される可能性があるため、十分に時間を置いてから「+ アカウントを追加」でやり直してください。",
      "認証コードは短時間で失効するため、再試行時はブラウザ認証から取り直しが必要です。",
    ].join("\n");
  }
  if (/state mismatch/i.test(raw)) {
    return "貼り付けたコードが一致しません。認証後に表示された code#state 形式のコード全体をコピーし直してください。";
  }
  if (isOauthLoginExpired(raw)) {
    return "認証セッションの有効期限が切れました。「+ アカウントを追加」からやり直してください。";
  }
  if (/must contain '#'/.test(raw)) {
    return "コードの形式が違います。code#state のように「#」を含む文字列全体を貼り付けてください。";
  }
  return raw;
}
