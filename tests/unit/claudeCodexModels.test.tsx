/** @vitest-environment jsdom */

/**
 * claude-codex's chips come from its installed models.json (read by the
 * claude_codex_model_choices command); every other agent, and claude-codex
 * without a readable table, keeps the catalog's own list.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  getCatalogEntry,
  isValidLaunchSpecValue,
  type AgentCatalogEntry,
  type ModelChoice,
} from "../../src/lib/agentCatalog";
import { loadClaudeCodexModels, useLaunchModels } from "../../src/lib/claudeCodexModels";

const INSTALLED: ModelChoice[] = [
  { value: "gpt-6-astra", label: "GPT-6 Astra" },
  { value: "claude-opus-5", label: "Claude Opus 5" },
  { value: "anthropic/gateway/fcc/open_router/x-ai/grok-4.3", label: "Grok 4.3" },
];

let container: HTMLDivElement;
let root: Root;
let seen: readonly ModelChoice[] = [];

function Probe({ entry }: { entry: AgentCatalogEntry | undefined }) {
  seen = useLaunchModels(entry);
  return null;
}

async function render(entry: AgentCatalogEntry | undefined) {
  await act(async () => {
    root.render(<Probe entry={entry} />);
  });
  // Let the invoke promise and the state update it triggers settle.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seen = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useLaunchModels", () => {
  it("offers claude-codex the models its install names", async () => {
    invokeMock.mockResolvedValue(INSTALLED);
    await render(getCatalogEntry("claude-codex"));
    expect(invokeMock).toHaveBeenCalledWith("claude_codex_model_choices");
    expect(seen).toEqual(INSTALLED);
  });

  it.each([
    ["an empty table", () => invokeMock.mockResolvedValueOnce([])],
    ["no Tauri host", () => invokeMock.mockRejectedValueOnce(new Error("no tauri"))],
    ["a malformed answer", () => invokeMock.mockResolvedValueOnce(null)],
  ])("keeps the catalog list for %s", async (_name, arrange) => {
    const entry = getCatalogEntry("claude-codex")!;
    arrange();
    await render(entry);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(entry.models);
  });

  it("never asks for other agents", async () => {
    await render(getCatalogEntry("codex"));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(seen).toEqual(getCatalogEntry("codex")!.models);
  });

  it("offers nothing without an entry", async () => {
    await render(undefined);
    expect(seen).toEqual([]);
  });

  it("re-reads the table when the panel comes back", async () => {
    invokeMock.mockResolvedValueOnce(INSTALLED);
    await render(getCatalogEntry("claude-codex"));
    await render(getCatalogEntry("codex"));
    invokeMock.mockResolvedValueOnce(INSTALLED.slice(0, 1));
    await render(getCatalogEntry("claude-codex"));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(INSTALLED.slice(0, 1));
  });
});

describe("loadClaudeCodexModels", () => {
  it("turns a failed or malformed answer into no chips", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await expect(loadClaudeCodexModels()).resolves.toEqual([]);
    invokeMock.mockResolvedValueOnce({ not: "a list" });
    await expect(loadClaudeCodexModels()).resolves.toEqual([]);
  });
});

describe("isValidLaunchSpecValue", () => {
  // Pinned beside the gateway ids that needed "/" — the same boundary the
  // Rust, PowerShell and POSIX checks apply.
  it("takes a gateway picker id and anything up to 128 characters", () => {
    expect(isValidLaunchSpecValue("anthropic/gateway/fcc/open_router/x-ai/grok-4.3")).toBe(true);
    expect(isValidLaunchSpecValue("a".repeat(128))).toBe(true);
  });

  it("refuses flags, shell syntax, a leading slash, 129 characters and letters that only fold to ASCII", () => {
    for (const value of ["--model", "/etc/passwd", "a;b", "$(x)", "a b", "a".repeat(129), "\u212Aimi", ""]) {
      expect(isValidLaunchSpecValue(value)).toBe(false);
    }
  });
});
