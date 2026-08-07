import type { CliProvider } from "./ipc";

export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let normalized = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    normalized += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : trimmed[index];
  }
  return normalized;
}

export function accountKey(
  provider: CliProvider,
  identityKey: string | null | undefined,
  usageAccountId?: string | null,
): string | null {
  if (identityKey) return `${provider}:id:${identityKey}`;
  if (usageAccountId) return `${provider}:usage:${usageAccountId}`;
  return null;
}
