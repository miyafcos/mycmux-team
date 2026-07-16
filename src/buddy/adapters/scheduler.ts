export interface Scheduler {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export class BrowserScheduler implements Scheduler {
  setTimeout(handler: () => void, ms: number): number {
    return window.setTimeout(handler, ms);
  }

  clearTimeout(id: number): void {
    window.clearTimeout(id);
  }
}
