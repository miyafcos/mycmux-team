import { useMemo } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { NotificationBellFilter } from "../lib/notificationPanelModel";

const SILENT: NotificationBellFilter = {
  question: false,
  approval: false,
  workDone: false,
  unread: false,
};

/**
 * What the top-left bell is allowed to report right now.
 *
 * Kept in one hook because the bell badge and the panel below it build their
 * models separately; letting each read the settings on its own is how they
 * would drift into disagreeing about what is unread.
 */
export function useNotificationBellFilter(): NotificationBellFilter {
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const question = useSettingsStore((s) => s.bellQuestionEnabled);
  const approval = useSettingsStore((s) => s.bellApprovalEnabled);
  const workDone = useSettingsStore((s) => s.bellWorkDoneEnabled);
  const unread = useSettingsStore((s) => s.bellUnreadEnabled);
  return useMemo(
    () => notificationsEnabled ? { question, approval, workDone, unread } : SILENT,
    [notificationsEnabled, question, approval, workDone, unread],
  );
}
