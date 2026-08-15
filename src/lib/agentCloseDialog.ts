export function agentCloseDialogOptions(title: string) {
  return {
    title,
    kind: "warning" as const,
    okLabel: "終了",
    cancelLabel: "キャンセル",
  };
}
