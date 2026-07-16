import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export interface HostBridge {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

export class TauriHostBridge implements HostBridge {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(cmd, args);
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    const unlisten = await tauriListen<T>(event, (eventPayload) => {
      handler(eventPayload.payload);
    });
    return unlisten;
  }
}
