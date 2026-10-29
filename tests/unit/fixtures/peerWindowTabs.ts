import type { WindowTabIndex } from "../../../src/lib/ipc";

export function peerIndex(label = "mycmux-w1", pending = false): WindowTabIndex[] {
  return [{ window_label: label, pending, workspaces: [{ id: "peer-workspace", name: "Peer workspace", panes: [{ id: "peer-pane", tabs: [
    { tab_id: "peer-tab", session_id: "peer-session", agent_id: "codex", type: "terminal", label: "Peer conversation",
      agent_kind: "codex", agent_session_id: "peer-conversation", pty_alive: true, live_agent_kind: "codex" },
  ] }] }] }];
}
