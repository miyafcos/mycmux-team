// Japanese literals for the sidebar resize UI.
// Authored by the orchestrator session; implementation lanes reference these keys
// and must not add new non-ASCII literals elsewhere.
export const sidebarStrings = {
  resizerLabel: "サイドバーの幅を変更",
  workspacesHeading: "ワークスペース",
  newWorkspace: "新しいワークスペース",
  // Chrome's own wording for the same action, and the same register as
  // newWorkspace above. Not "…で開く": the button opens an empty peer window,
  // it does not move anything into one.
  newWindow: "新しいウィンドウ",
  newWindowFailed: "新しいウィンドウを開けませんでした",
} as const;
