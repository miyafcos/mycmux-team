import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useToastStore, type ToastKind } from "../../stores/toastStore";
import { toastStrings } from "../workspace/terminalPaneStrings";

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
        const actions = (toast.actions ?? (toast.action ? [toast.action] : [])).slice(0, 2);
        return (
          <div
            key={toast.id}
            onClick={() => dismissToast(toast.id)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              dismissToast(toast.id);
            }}
            role={toast.kind === "error" ? "alert" : "status"}
            style={{
              display: "grid",
              gridTemplateColumns: actions.length > 0 ? "18px minmax(0, 1fr) auto auto" : "18px minmax(0, 1fr) auto",
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
            {actions.length > 0 ? (
              <span style={{ display: "flex", gap: 6 }}>
                {actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      action.run();
                      dismissToast(toast.id);
                    }}
                    style={{
                      height: 26,
                      padding: "0 10px",
                      border: "1px solid var(--cmux-border)",
                      borderRadius: 5,
                      background: "transparent",
                      color: "var(--cmux-accent-text)",
                      fontFamily: "inherit",
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </span>
            ) : null}
            <button
              type="button"
              className="pane-action-btn"
              aria-label={toastStrings.close}
              title={toastStrings.close}
              onClick={(event) => {
                event.stopPropagation();
                dismissToast(toast.id);
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
