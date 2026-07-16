export const BUDDY_CONFIG_UPDATED_EVENT = "buddy-config-updated";
export const BUDDY_KEYSTROKE_EVENT = "mycmux:keystroke";

export interface KeystrokeEventDetail {
  sessionId: string;
  data: string;
}

export interface BuddyDomEvents {
  subscribeKeystroke(handler: (detail: KeystrokeEventDetail) => void): () => void;
  dispatchBuddyConfigUpdated(): void;
  subscribeBuddyConfigUpdated(handler: () => void): () => void;
}

export class BrowserDomEvents implements BuddyDomEvents {
  subscribeKeystroke(handler: (detail: KeystrokeEventDetail) => void): () => void {
    const listener = (event: Event): void => {
      const custom = event as CustomEvent<KeystrokeEventDetail>;
      handler(custom.detail);
    };
    window.addEventListener(BUDDY_KEYSTROKE_EVENT, listener);
    return () => window.removeEventListener(BUDDY_KEYSTROKE_EVENT, listener);
  }

  dispatchBuddyConfigUpdated(): void {
    window.dispatchEvent(new CustomEvent(BUDDY_CONFIG_UPDATED_EVENT));
  }

  subscribeBuddyConfigUpdated(handler: () => void): () => void {
    window.addEventListener(BUDDY_CONFIG_UPDATED_EVENT, handler);
    return () => window.removeEventListener(BUDDY_CONFIG_UPDATED_EVENT, handler);
  }
}
