import { useEffect, useRef, useState } from "react";
import "./SettingsDialog.css";
import { useUsageStore } from "../../stores/usageStore";
import { AppearanceTab } from "./tabs/AppearanceTab";
import { NotificationsLayoutTab } from "./tabs/NotificationsLayoutTab";
import { ResumeTab } from "./tabs/ResumeTab";
import { SavepointsTab } from "./tabs/SavepointsTab";
import { RemoteTab } from "./tabs/RemoteTab";
import { UsageTab } from "./tabs/UsageTab";
import { KeybindingsTab } from "./tabs/KeybindingsTab";
import { AppInfoTab } from "./tabs/AppInfoTab";
import { tabBodyStyle } from "./tabStyles";
import { onlineStrings } from "../online/onlineStrings";
import { settingsStrings } from "./settingsStrings";

type SettingsTabId =
  | "appearance"
  | "notifications"
  | "resume"
  | "savepoints"
  | "remote"
  | "usage"
  | "keybindings"
  | "appInfo";

interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
}

interface SettingsSectionDef {
  label: string;
  tabs: SettingsTabDef[];
}

// Keep local history, asynchronous handoff, and live remote control as
// separate destinations. They solve different user jobs and share no state.
const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    label: "表示",
    tabs: [
      { id: "appearance", label: "外観" },
      { id: "notifications", label: "通知とレイアウト" },
    ],
  },
  {
    label: "作業",
    tabs: [
      { id: "resume", label: "このPCの履歴から再開" },
      { id: "savepoints", label: onlineStrings.settingsTabLabel },
    ],
  },
  {
    label: "接続",
    tabs: [{ id: "remote", label: settingsStrings.remoteTabLabel }],
  },
  {
    label: "アカウント",
    tabs: [{ id: "usage", label: "アカウント・使用量" }],
  },
  {
    label: "その他",
    tabs: [
      { id: "keybindings", label: "キーボードショートカット" },
      { id: "appInfo", label: "アプリ情報" },
    ],
  },
];

interface NavItemProps {
  label: string;
  isActive: boolean;
  badge: number | null;
  onSelect: () => void;
}

function NavItem({ label, isActive, badge, onSelect }: NavItemProps) {
  return (
    <button
      type="button"
      className="cmux-settings-nav-item"
      data-active-settings-tab={isActive ? "true" : undefined}
      onClick={onSelect}
      style={{
        width: "100%",
        padding: "8px 14px",
        border: "none",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span style={{ lineHeight: 1.4 }}>
        {label}
      </span>
      {badge !== null && (
        <span
          style={{
            color: "var(--cmux-usage-warn)",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          要再認証 {badge}
        </span>
      )}
    </button>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="cmux-settings-close-button"
      onClick={onClose}
      aria-label="設定を閉じる"
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: "transparent",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1,
      }}
    >
      ✕
    </button>
  );
}

interface SettingsDialogProps {
  onClose: () => void;
  onOpenCrsmPalette?: () => void;
  onOpenOnlinePanel: () => void;
}

export default function SettingsDialog({ onClose, onOpenCrsmPalette, onOpenOnlinePanel }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("appearance");
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const usageAccounts = useUsageStore((s) => s.accounts);
  const usageReauthCount = usageAccounts.filter((a) => a.enabled && a.needs_reauth).length;

  // Focus capture on open / restore on close, mirroring the pattern used by
  // KeybindingsModal.tsx and UsageAccountsDialog.tsx.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && document.contains(prev)) {
        prev.focus();
      }
    };
  }, []);

  // Escape closes the dialog. Nested confirms (Remote tab's token rotation,
  // the accounts panel's delete) all use window.confirm(), which blocks JS
  // execution entirely while open, so they can never race with this listener.
  // A rebind capture in the keybindings tab intercepts Escape in the capture
  // phase (stopPropagation) before it reaches this bubble-phase handler.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="cmux-overlay-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--cmux-backdrop)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="cmux-overlay-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 920,
          maxWidth: "calc(100vw - 32px)",
          // Fixed height: the dialog frame must not resize (and re-center)
          // when switching tabs — tab content scrolls inside instead.
          height: "min(640px, calc(100vh - 80px))",
          background: "var(--cmux-popover)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 10,
          boxShadow: "var(--cmux-shadow-dialog)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          color: "var(--cmux-text)",
          fontFamily: "'JetBrains Mono', monospace",
          outline: "none",
        }}
      >
        <div
          style={{
            padding: "16px 18px",
            borderBottom: "1px solid var(--cmux-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700 }}>設定</div>
          <CloseButton onClose={onClose} />
        </div>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
          <nav
            style={{
              width: "clamp(148px, 23vw, 208px)",
              flexShrink: 0,
              borderRight: "1px solid var(--cmux-border)",
              overflowY: "auto",
              padding: "2px 0 10px",
            }}
          >
            {SETTINGS_SECTIONS.map((section, sectionIndex) => (
              <div key={section.label}>
                <div
                  style={{
                    padding: sectionIndex === 0 ? "10px 16px 4px" : "18px 16px 4px",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--cmux-text-dim, rgba(255,255,255,0.5))",
                  }}
                >
                  {section.label}
                </div>
                {section.tabs.map((tab) => (
                  <NavItem
                    key={tab.id}
                    label={tab.label}
                    isActive={tab.id === activeTab}
                    badge={tab.id === "usage" && usageReauthCount > 0 ? usageReauthCount : null}
                    onSelect={() => setActiveTab(tab.id)}
                  />
                ))}
              </div>
            ))}
          </nav>

          <div style={activeTab === "appearance" ? { flex: 1, minWidth: 0, minHeight: 0 } : tabBodyStyle}>
            {activeTab === "appearance" && <AppearanceTab />}
            {activeTab === "notifications" && <NotificationsLayoutTab />}
            {activeTab === "resume" && <ResumeTab onOpenCrsmPalette={onOpenCrsmPalette} onClose={onClose} />}
            {activeTab === "savepoints" && (
              <SavepointsTab
                onOpen={() => {
                  onOpenOnlinePanel();
                  onClose();
                }}
              />
            )}
            {activeTab === "remote" && <RemoteTab />}
            {activeTab === "usage" && <UsageTab />}
            {activeTab === "keybindings" && <KeybindingsTab />}
            {activeTab === "appInfo" && <AppInfoTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
