import { useToastStore, type ToastAction } from "../../stores/toastStore";
// Receiver attachment errors describe failed adoption; source rollback has restore-prefixed reasons.
export const recoveryReason = (reason: string): string => reason.includes("receipt") || reason.includes("receive") || reason.includes("adoption")
  || reason === "tearout_session_not_alive" || reason === "tearout_attachment_timeout"
  ? "\u79fb\u52d5\u5148\u306e\u7a93\u304c\u30da\u30a4\u30f3\u3092\u53d7\u3051\u53d6\u308c\u307e\u305b\u3093\u3067\u3057\u305f"
  : reason.includes("attachment") || reason.includes("session")
    ? "\u7aef\u672b\u306e\u4ed8\u3051\u76f4\u3057\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f"
    : "\u5207\u308a\u96e2\u3057\u5148\u306e\u7a93\u3092\u64cd\u4f5c\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f";
export function recoveryProgress(name: string, location: string): string {
  return useToastStore.getState().pushToast(`\u300c${name}\u300d\u3092${location}\u306b\u623b\u3057\u3066\u3044\u307e\u3059\u3002\u4ed8\u3051\u76f4\u3057\u306e\u78ba\u8a8d\u304c\u7d42\u308f\u308b\u307e\u3067\u304a\u5f85\u3061\u304f\u3060\u3055\u3044\u3002`, "warning", undefined, undefined, 60_000);
}
export function recoveryFinished(name: string, location: string, reason?: string, retry?: () => void, visit?: () => void): void {
  useToastStore.getState().pushToast(`${reason ? recoveryReason(reason) + "\u3002" : ""}\u300c${name}\u300d\u3092${location}\u306b\u623b\u3057\u307e\u3057\u305f\u3002`, reason ? "error" : "info", undefined, reason ? [
    ...(retry ? [{ label: "\u5207\u308a\u96e2\u3057\u3092\u3084\u308a\u76f4\u3059", run: retry }] : []),
    ...(visit ? [{ label: "\u30da\u30a4\u30f3\u306e\u5834\u6240\u3078\u79fb\u308b", run: visit }] : []),
  ] : undefined, undefined, "failure");
}
export function recoveryFailed(name: string, location: string, reason: string, retry: () => void, visit: () => void): void {
  const actions: ToastAction[] = [{ label: "\u4ed8\u3051\u76f4\u3057\u3092\u3084\u308a\u76f4\u3059", run: retry },
    { label: "\u30da\u30a4\u30f3\u306e\u5834\u6240\u3078\u79fb\u308b", run: visit }];
  useToastStore.getState().pushToast(`${recoveryReason(reason)}\u3002\u300c${name}\u300d\u306f${location}\u306b\u3042\u308a\u307e\u3059\u3002\u8868\u793a\u306e\u56de\u5fa9\u306f\u78ba\u8a8d\u3067\u304d\u3066\u3044\u307e\u305b\u3093\u3002`, "error", undefined, actions, 60_000);
}
export function recoveryBusy(): void {
  useToastStore.getState().pushToast("\u524d\u306e\u30da\u30a4\u30f3\u3092\u623b\u3057\u3066\u3044\u307e\u3059\u3002\u78ba\u8a8d\u304c\u7d42\u308f\u3063\u3066\u304b\u3089\u3082\u3046\u4e00\u5ea6\u64cd\u4f5c\u3057\u3066\u304f\u3060\u3055\u3044\u3002", "warning");
}
