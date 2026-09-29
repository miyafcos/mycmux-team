import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

export type ToastKind = "error" | "warning" | "info";
export type ToastCategory = "ai-activity" | "user-action" | "system" | "failure";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  category: ToastCategory;
  createdAt: number;
  action?: ToastAction;
  actions?: ToastAction[];
}

interface ToastState {
  toasts: Toast[];
  pushToast: (
    message: string,
    kind?: ToastKind,
    action?: ToastAction,
    actions?: ToastAction[],
    durationMs?: number,
    category?: ToastCategory,
  ) => string;
  dismissToast: (id: string) => void;
}

const TOAST_AUTO_DISMISS_MS = 8000;
/**
 * Undo is the only safety net for actions that already happened, so its toast
 * outlives the informational default.
 */
export const TOAST_UNDO_DISMISS_MS = 20000;
const TOAST_LIMIT = 3;
const toastDismissTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

function createToastId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clearToastTimer(id: string): void {
  const timer = toastDismissTimers.get(id);
  if (timer !== undefined) {
    globalThis.clearTimeout(timer);
    toastDismissTimers.delete(id);
  }
}

function resolveToastCategory(kind: ToastKind, category?: ToastCategory): ToastCategory {
  if (kind === "error") return "failure";
  if (category) return category;
  return kind === "warning" ? "failure" : "user-action";
}

function isToastCategoryEnabled(category: ToastCategory): boolean {
  if (category === "failure") return true;
  const settings = useSettingsStore.getState();
  if (!settings.notificationsEnabled) return false;
  if (category === "ai-activity") return settings.toastAiActivityEnabled;
  if (category === "system") return settings.toastSystemEnabled;
  return settings.toastUserActionEnabled;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast: (message, kind = "error", action, actions, durationMs, requestedCategory) => {
    const id = createToastId();
    const category = resolveToastCategory(kind, requestedCategory);
    if (!isToastCategoryEnabled(category)) return id;
    const toast: Toast = {
      id,
      message,
      kind,
      category,
      createdAt: Date.now(),
      action,
      actions: actions?.slice(0, 2),
    };

    set((state) => {
      const nextToasts = [...state.toasts, toast].slice(-TOAST_LIMIT);
      const visibleIds = new Set(nextToasts.map((item) => item.id));
      for (const existing of state.toasts) {
        if (!visibleIds.has(existing.id)) {
          clearToastTimer(existing.id);
        }
      }
      return { toasts: nextToasts };
    });

    const timer = globalThis.setTimeout(() => {
      get().dismissToast(id);
    }, durationMs ?? TOAST_AUTO_DISMISS_MS);
    toastDismissTimers.set(id, timer);

    return id;
  },
  dismissToast: (id) => {
    clearToastTimer(id);
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }));
  },
}));

export function __resetToastStoreForTests(): void {
  for (const id of toastDismissTimers.keys()) {
    clearToastTimer(id);
  }
  useToastStore.setState({ toasts: [] });
}
