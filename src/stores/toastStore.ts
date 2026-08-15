import { create } from "zustand";

export type ToastKind = "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
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

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast: (message, kind = "error", action, actions, durationMs) => {
    const id = createToastId();
    const toast: Toast = {
      id,
      message,
      kind,
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
