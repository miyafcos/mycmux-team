import { useEffect, useRef, useState } from "react";
import { useCliAccountStore } from "../../stores/cliAccountStore";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import {
  badgeLabel,
  hasAttention,
  liveForProvider,
  CLI_ACCOUNT_POLL_INTERVAL_MS,
  PROVIDER_SHORT,
} from "../../lib/cliAccounts";
import { CliAccountMenu } from "./CliAccountMenu";

type BadgeMode = "full" | "compact" | "hidden";

export function CliAccountBadge() {
  const live = useCliAccountStore((state) => state.live);
  const profiles = useCliAccountStore((state) => state.profiles);
  const fetchAccounts = useCliAccountStore((state) => state.fetch);
  const [isOpen, setIsOpen] = useState(false);
  const { mounted: menuMounted, closing: menuClosing } = useDeferredUnmount(isOpen, OVERLAY_EXIT_MS);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mode = useBadgeMode();

  useEffect(() => {
    void fetchAccounts();
    const interval = window.setInterval(() => {
      void fetchAccounts();
    }, CLI_ACCOUNT_POLL_INTERVAL_MS);
    const onFocus = () => void fetchAccounts();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchAccounts]);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  if (mode === "hidden" || live.length === 0) {
    return null;
  }

  const claude = liveForProvider(live, "claude");
  const codex = liveForProvider(live, "codex");
  const attention = hasAttention(live, profiles);
  const fullText = `${PROVIDER_SHORT.claude} ${badgeLabel(claude, profiles)} · ${PROVIDER_SHORT.codex} ${badgeLabel(codex, profiles)}`;

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}
    >
      <button
        onClick={() => setIsOpen((value) => !value)}
        title="CLI ログインアカウントの表示・切り替え"
        className="cmux-title-btn"
        style={{
          background: "none",
          border: "none",
          color: "var(--cmux-text-secondary)",
          cursor: "pointer",
          padding: "3px 6px",
          borderRadius: 3,
          fontSize: 11,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          whiteSpace: "nowrap",
          maxWidth: 220,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {mode === "full" ? fullText : `${PROVIDER_SHORT.claude}·${PROVIDER_SHORT.codex}`}
      </button>

      {attention && (
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--cmux-usage-warn)",
          }}
        />
      )}

      {menuMounted && (
        <CliAccountMenu closing={menuClosing} onClose={() => setIsOpen(false)} />
      )}
    </div>
  );
}

function useBadgeMode(): BadgeMode {
  const [mode, setMode] = useState<BadgeMode>(readBadgeMode);

  useEffect(() => {
    const compactQuery = window.matchMedia("(max-width: 900px)");
    const hiddenQuery = window.matchMedia("(max-width: 700px)");
    const update = () => setMode(readBadgeMode());
    compactQuery.addEventListener("change", update);
    hiddenQuery.addEventListener("change", update);
    update();
    return () => {
      compactQuery.removeEventListener("change", update);
      hiddenQuery.removeEventListener("change", update);
    };
  }, []);

  return mode;
}

function readBadgeMode(): BadgeMode {
  if (typeof window === "undefined") return "full";
  if (window.matchMedia("(max-width: 700px)").matches) return "hidden";
  if (window.matchMedia("(max-width: 900px)").matches) return "compact";
  return "full";
}
