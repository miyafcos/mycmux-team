import type { HostBridge } from "../../adapters/host-bridge";

const REFRESH_INTERVAL_MS = 300_000;
const DEFAULT_LIMIT = 12;

export interface WorkContextSnapshot {
  generatedAtMs: number;
  sessions: WorkSessionSummary[];
  sources: string[];
  errors: string[];
}

export interface WorkSessionSummary {
  agent: "claude" | "codex" | string;
  sessionId: string | null;
  projectPath: string | null;
  title: string;
  lastActivityMs: number;
  recentText: string;
  sourcePath: string;
}

export class WorkContextStore {
  private snapshot: WorkContextSnapshot | null = null;
  private lastRefreshMs = 0;
  private pending: Promise<void> | null = null;

  constructor(private readonly host: HostBridge) {}

  getSnapshot(): WorkContextSnapshot | null {
    return this.snapshot;
  }

  async refresh(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.snapshot && now - this.lastRefreshMs < REFRESH_INTERVAL_MS) {
      return;
    }

    if (this.pending) {
      return this.pending;
    }

    this.pending = this.load()
      .catch((error) => {
        console.warn("[buddy] failed to load work context:", error);
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  toPromptText(): string {
    if (!this.snapshot || this.snapshot.sessions.length === 0) {
      return "Claude/Codex cross-session context: no recent sessions found.";
    }

    const lines = this.snapshot.sessions.slice(0, DEFAULT_LIMIT).map((session) => {
      const project = session.projectPath ? ` @ ${shortenPath(session.projectPath)}` : "";
      const id = session.sessionId ? ` ${session.sessionId.slice(0, 8)}` : "";
      const recent = previewText(session.recentText || session.title, 180);
      return `- [${session.agent}${id}]${project}: ${recent}`;
    });

    if (this.snapshot.errors.length > 0) {
      lines.push(`- context read warnings: ${this.snapshot.errors.slice(0, 2).join(" / ")}`);
    }

    return ["Claude/Codex cross-session context (newest first):", ...lines].join("\n");
  }

  private async load(): Promise<void> {
    const snapshot = await this.host.invoke<WorkContextSnapshot>("load_work_context", {
      limit: DEFAULT_LIMIT,
    });
    this.snapshot = snapshot;
    this.lastRefreshMs = Date.now();
  }
}

function previewText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  if (parts.length <= 3) {
    return normalized;
  }
  return `${parts[0]}\\...\\${parts.slice(-2).join("\\")}`;
}
