export interface PathJumperWatchApi {
  watchRoot(path: string): Promise<void>;
  unwatchRoot(path: string): Promise<void>;
}

export class PathJumperWatchController {
  private desiredPaths = new Set<string>();
  private watchedPaths = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly api: PathJumperWatchApi) {}

  sync(isOpen: boolean, paths: Iterable<string>): Promise<void> {
    this.desiredPaths = isOpen ? new Set(paths) : new Set();
    this.queue = this.queue.then(() => this.reconcile());
    return this.queue;
  }

  dispose(): Promise<void> {
    return this.sync(false, []);
  }

  private async reconcile(): Promise<void> {
    for (const path of this.watchedPaths) {
      if (!this.desiredPaths.has(path)) {
        this.watchedPaths.delete(path);
        await this.api.unwatchRoot(path).catch(() => {});
      }
    }

    for (const path of this.desiredPaths) {
      if (!this.watchedPaths.has(path)) {
        const watched = await this.api.watchRoot(path).then(() => true).catch(() => false);
        if (watched) {
          if (this.desiredPaths.has(path)) {
            this.watchedPaths.add(path);
          } else {
            await this.api.unwatchRoot(path).catch(() => {});
          }
        }
      }
    }
  }
}
