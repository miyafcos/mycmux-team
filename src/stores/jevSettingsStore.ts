import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export interface JevSettings {
  enabled: boolean;
  model: string;
  hasApiKey: boolean;
  revision: string;
}
export const DEFAULT_JEV_SETTINGS: JevSettings = {
  enabled: false, model: DEFAULT_JEV_MODEL, hasApiKey: false, revision: "initial",
};
interface JevSettingsState extends JevSettings { loaded: boolean; error: string | null }
export const useJevSettingsStore = create<JevSettingsState>(() => ({
  ...DEFAULT_JEV_SETTINGS, loaded: false, error: null,
}));
let loading: Promise<void> | null = null;

function accept(value: JevSettings): void {
  if (!value || typeof value.enabled !== "boolean" || typeof value.hasApiKey !== "boolean"
    || typeof value.model !== "string" || typeof value.revision !== "string") {
    throw new Error("invalid_settings");
  }
  const { enabled, model, hasApiKey, revision } = value;
  useJevSettingsStore.setState({ enabled, model, hasApiKey, revision, loaded: true, error: null });
}
export async function loadJevSettings(): Promise<void> {
  if (useJevSettingsStore.getState().loaded) return;
  if (!loading) {
    loading = invoke<JevSettings>("get_jev_settings").then(accept).catch((error: unknown) => {
      useJevSettingsStore.setState({ error: jevErrorMessage(error) });
      throw error;
    }).finally(() => { loading = null; });
  }
  return loading;
}
export async function saveJevSettings(enabled: boolean, model: string, apiKey: string): Promise<void> {
  const value = await invoke<JevSettings>("save_jev_settings", {
    enabled, model: model.trim(), apiKey: apiKey.trim() || null,
  });
  accept(value);
}
export async function testJevConnection(model: string, apiKey: string): Promise<number> {
  const result = await invoke<{ ok: boolean; elapsedMs: number }>("test_jev_connection", {
    model: model.trim(), apiKey: apiKey.trim() || null,
  });
  if (!result?.ok || !Number.isFinite(result.elapsedMs)) throw new Error("invalid_response");
  return result.elapsedMs;
}
export function jevErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message
    : typeof error === "string" ? error
    : typeof error === "object" && error && "detail" in error ? String(error.detail) : "";
  const messages: Record<string, string> = {
    missing_key: "OpenRouterのAPIキーを設定 > AI > Jevで登録してください。",
    authentication: "OpenRouterの認証に失敗しました。APIキーと利用権限を確認してください。",
    invalid_key: "APIキーに空白や改行が含まれていないか確認してください。",
    invalid_model: "JevのモデルIDを確認してください（例: typesafe/jev-1.13）。",
    credits: "OpenRouterの利用残高が不足しています。",
    rate_limit: "OpenRouterの利用上限に達しました。少し待って再度お試しください。",
    timeout: "Jevの応答が時間内に届きませんでした。現在の案は保持しています。",
    network: "OpenRouterに接続できませんでした。ネットワークを確認してください。",
    key_storage: "APIキーの保護保存を利用できません。OSの資格情報ストアを確認してください。",
    settings_storage: "Jevの設定を読み書きできませんでした。",
    invalid_settings: "Jevの設定を取得できませんでした。アプリを更新して再度お試しください。",
    invalid_response: "Jevの応答を検証できませんでした。再度お試しください。",
    invalid_request: "Jevに送るデータを準備できませんでした。",
    provider_error: "OpenRouterでエラーが発生しました。少し待って再度お試しください。",
    jev_disabled: "設定 > AIでJevによるペイン再配置を有効にしてください。",
    cancelled: "再配置の分析を中止しました。",
  };
  return messages[value] ?? "Jevに接続できませんでした。設定 > AIの接続テストで確認してください。";
}
