// Keep in sync with lib.rs startup removal and SocketListener persistence.
// A parent's one-shot instruction must never become a new tab's instruction.
export const EPHEMERAL_LAUNCH_ENV_KEYS = new Set([
  "MYCMUX_RESUME",
  "MYCMUX_SESSION_ID",
  "MYCMUX_AGENT_KIND",
  "MYCMUX_RESUME_FORK",
  "MYCMUX_LAUNCH_TARGET",
  "MYCMUX_LAUNCH_MODEL",
  "MYCMUX_LAUNCH_EFFORT",
  "MYCMUX_HANDOFF",
  "MYCMUX_HANDOFF_FROM",
  "MYCMUX_HANDOFF_PROMPT_FILE",
  "MYCMUX_HANDOFF_FROM_SESSION",
  "MYCMUX_PANE_SESSION_ID",
  "MYCMUX_TAB_ID",
  "MYCMUX_HTML_OUT",
  "MYCMUX_MARKDOWN_OUT",
  "MYCMUX_ARTIFACTS_DIR",
  "MYCMUX_RUNTIME_DIR",
  "MYCMUX_TEST_PROFILE",
  "MYCMUX_HOOK_CAP",
  "__CMUX_LAUNCHER_DONE",
]);

export function buildSpawnLaunchEnv(
  inherited: Record<string, string> | undefined,
  explicit?: Record<string, string>,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(inherited ?? {}).filter(([key]) => !EPHEMERAL_LAUNCH_ENV_KEYS.has(key.toUpperCase())),
  );
  // An explicit empty map also prevents the UI from falling back to pane env.
  return { ...env, ...explicit };
}
