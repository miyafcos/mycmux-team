# Notifications

## How Notifications Are Generated

The terminal approval scan generates notifications when:
1. `term.onWriteParsed()` fires (xterm.js finished parsing output)
2. Background scanning is throttled to 300ms
3. An approval or question prompt is detected in the terminal buffer
4. If notifications are enabled AND the pane is NOT active → `notifyWaiting(sessionId, patternId)` (deduplicated)

```typescript
// Simplified flow
term.onWriteParsed(() => {
  scheduleBackgroundScan(); // 300ms throttle
  // runScan detects approval/question prompts and calls notifyWaiting()
  // only for an inactive session while notificationsEnabled is true.
});
```

## Notification Store

```typescript
interface PaneMetadataState {
  metadata: Record<string, {
    lastLogLine?: string;
    notificationCount?: number;
  }>;
  lastLog: Record<string, string>;
  lastLogAt: Record<string, number>;
}
```

Actions:
- `notifyWaiting(sessionId, patternId)` — bump approval count once per waiting pattern
- `incrementNotification(sessionId)` — low-level count increment
- `clearNotification(sessionId)` — reset to 0
- `setMetadata(sessionId, data)` — update last log line

## Badge Display

**Sidebar tabs** (`TabBar`): Aggregated notification count across all panes in a workspace, displayed as a pill badge. Also shows the most recent `lastLogLine` as a preview.

**Pane tab bar** (`PaneTabBar`): Theme notification-colored border-bottom when `hasNotification` is true. Status dots (5px) distinguish waiting, working, and error states.

## Notification Clearing

Notifications are cleared when a pane receives focus:

```typescript
const handleFocus = () => {
  setActivePaneId(pane.sessionId);
  clearNotification(pane.sessionId);
};
```

## Flash / Attention (Historical)

The one-shot flash below was removed on 2026-04-10 (`a5ac2fc7`), including its shortcut and store API. Current inactive notification panes use a 2px themed border with a 2.5-second `notificationPulse` (reduced-motion aware).

Historical behavior: visual flash animation on a pane for 0.9 seconds:

```typescript
triggerFlash(sessionId) → {
  flashingPaneIds.add(sessionId);
  setTimeout(900ms, () => flashingPaneIds.delete(sessionId));
}
```

Renders a 3px accent-colored border overlay with `paneFlash` CSS animation.

Triggers:
- `Ctrl+Shift+H` — flash the currently focused pane
- Programmatic via `usePaneMetadataStore.getState().triggerFlash()`

## Suppression

`XTermWrapper` checks the active session ID and `notificationsEnabled`; ordinary output changes do not generate approval badges. `notificationSoundEnabled` controls the Web Audio chime.

The title-bar bell opens `NotificationPanel`: answer/approval-needed sessions and unread arrivals have separate sections. Clearing unread arrivals does not clear pending answers (HEAD change `dac6fc02`).
