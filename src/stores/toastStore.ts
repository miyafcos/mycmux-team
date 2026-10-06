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
const toastDismissDeadlines = new Map<string, number>();

function createToastId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clearToastTimer(id: string): void {
  const timer = toastDismissTimers.get(id);
  if (timer !== undefined) {
    globalThis.clearTimeout(timer);
    toastDismissTimers.delete(id);
  }
  toastDismissDeadlines.delete(id);
}

function getToastActions(toast: Pick<Toast, "action" | "actions">): ToastAction[] {
  return (toast.actions ?? (toast.action ? [toast.action] : [])).slice(0, 2);
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
    const category = resolveToastCategory(kind, requestedCategory);
    if (!isToastCategoryEnabled(category)) return createToastId();
    const nextActions = getToastActions({ action, actions });
    // Each action toast owns a distinct operation, even when its text and labels match.
    const existing = nextActions.length === 0 ? get().toasts.find((toast) =>
      toast.kind === kind && toast.message === message && getToastActions(toast).length === 0,
    ) : undefined;
    const id = existing?.id ?? createToastId();
    // A shorter repeat must not reduce an actionless notice's remaining time.
    const dismissAt = Math.max(toastDismissDeadlines.get(id) ?? 0, Date.now() + (durationMs ?? TOAST_AUTO_DISMISS_MS));
    const toast: Toast = {
      id,
      message,
      kind,
      category,
      createdAt: existing?.createdAt ?? Date.now(),
      action,
      actions: actions?.slice(0, 2),
    };

    set((state) => {
      const nextToasts = existing
        ? state.toasts.map((item) => item.id === id ? toast : item)
        : [...state.toasts, toast];
      while (nextToasts.length > TOAST_LIMIT) {
        const withoutActions = nextToasts.findIndex((item) => getToastActions(item).length === 0);
        nextToasts.splice(withoutActions === -1 ? 0 : withoutActions, 1);
      }
      const visibleIds = new Set(nextToasts.map((item) => item.id));
      for (const previous of state.toasts) {
        if (!visibleIds.has(previous.id)) {
          clearToastTimer(previous.id);
        }
      }
      return { toasts: nextToasts };
    });

    // An incoming plain notice can itself be evicted when all three visible notices have actions.
    if (get().toasts.some((item) => item.id === id)) {
      clearToastTimer(id);
      const timer = globalThis.setTimeout(() => {
        get().dismissToast(id);
      }, dismissAt - Date.now());
      toastDismissTimers.set(id, timer);
      toastDismissDeadlines.set(id, dismissAt);
    }

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
