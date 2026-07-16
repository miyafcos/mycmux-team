import { open, save } from "@tauri-apps/plugin-dialog";
import { onlineStrings } from "../components/online/onlineStrings";
import { useOnlineSavepointStore } from "../stores/onlineSavepointStore";
import {
  exportSavepointTransfer,
  importSavepointTransfer,
  type ExportSavepointTransferResult,
  type ImportSavepointTransferResult,
} from "./ipc";

export const SAVEPOINT_RECEIVED_EVENT = "mycmux:savepoint-received";
export const SAVEPOINT_TRANSFER_EXTENSION = ".mycmux-transfer";

export function isSavepointTransferPath(path: string): boolean {
  return path.toLowerCase().endsWith(SAVEPOINT_TRANSFER_EXTENSION);
}

export function savepointTransferFileName(label: string): string {
  const stem = label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 72) || onlineStrings.transferDefaultFileName;
  return `${stem}${SAVEPOINT_TRANSFER_EXTENSION}`;
}

function withTransferExtension(path: string): string {
  return isSavepointTransferPath(path) ? path : `${path}${SAVEPOINT_TRANSFER_EXTENSION}`;
}

export async function shareSavepointTransfer(
  bundleDir: string,
  label: string,
): Promise<ExportSavepointTransferResult | null> {
  const destination = await save({
    title: onlineStrings.transferSaveDialogTitle,
    defaultPath: savepointTransferFileName(label),
    filters: [{
      name: onlineStrings.transferFileType,
      extensions: [SAVEPOINT_TRANSFER_EXTENSION.slice(1)],
    }],
  });
  if (!destination) return null;
  return exportSavepointTransfer(bundleDir, withTransferExtension(destination));
}

export async function receiveSavepointTransfer(
  sourcePath: string,
): Promise<ImportSavepointTransferResult> {
  const result = await importSavepointTransfer(sourcePath);
  await useOnlineSavepointStore.getState().refresh();
  window.dispatchEvent(new CustomEvent(SAVEPOINT_RECEIVED_EVENT, { detail: result }));
  return result;
}

export async function chooseAndReceiveSavepointTransfer(): Promise<ImportSavepointTransferResult | null> {
  const selected = await open({
    title: onlineStrings.transferOpenDialogTitle,
    multiple: false,
    directory: false,
    filters: [{
      name: onlineStrings.transferFileType,
      extensions: [SAVEPOINT_TRANSFER_EXTENSION.slice(1)],
    }],
  });
  const sourcePath = Array.isArray(selected) ? selected[0] : selected;
  if (!sourcePath) return null;
  return receiveSavepointTransfer(sourcePath);
}
