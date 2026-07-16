import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useToastStore, type ToastKind } from "../../stores/toastStore";

const kindStyles: Record<ToastKind, { color: string; Icon: LucideIcon }> = {
  error: { color: "var(--cmux-red, #ff6b6b)", Icon: XCircle },
  warning: { color: "var(--cmux-yellow, #f5c542)", Icon: AlertTriangle },
  info: { color: "var(--cmux-accent, #7aa2f7)", Icon: Info },
};

export default function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 240,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: "min(360px, calc(100vw - 32px))",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => {
        const { color, Icon } = kindStyles[toast.kind];
        return (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismissToast(toast.id)}
            role={toast.kind === "error" ? "alert" : "status"}
            style={{
              display: "grid",
              gridTemplateColumns: "18px 1fr",
              gap: 10,
              alignItems: "center",
              width: "100%",
              padding: "10px 12px",
              background: "var(--cmux-popover, #161616)",
              border: "1px solid var(--cmux-border, rgba(255,255,255,0.12))",
              borderRadius: 6,
              boxShadow: "var(--cmux-shadow-popover, 0 12px 32px rgba(0,0,0,0.4))",
              color: "var(--cmux-text, #ededed)",
              fontFamily: "inherit",
              fontSize: 12,
              lineHeight: 1.4,
              textAlign: "left",
              cursor: "pointer",
              pointerEvents: "auto",
            }}
          >
            <Icon size={16} color={color} aria-hidden="true" />
            <span style={{ overflowWrap: "anywhere" }}>{toast.message}</span>
          </button>
        );
      })}
    </div>
  );
}
