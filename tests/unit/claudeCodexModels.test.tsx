/** @vitest-environment jsdom */

/**
 * Codex and claude-codex read their installed lists and fall back to the
 * fixed launcher catalog when those lists are unavailable.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  getCatalogEntry,
  getLaunchEfforts,
  isValidLaunchSpecValue,
  type AgentCatalogEntry,
  type ModelChoice,
} from "../../src/lib/agentCatalog";
import { loadClaudeCodexModels, useLaunchModels } from "../../src/lib/claudeCodexModels";

const INSTALLED: ModelChoice[] = [
  { value: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
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
    expect(seen.map((choice) => choice.value)).toContain("gpt-6.1-terra");
  });

  it("never asks for other agents", async () => {
    await render(getCatalogEntry("agy"));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(seen).toEqual(getCatalogEntry("agy")!.models);
  });

  it("offers nothing without an entry", async () => {
    await render(undefined);
    expect(seen).toEqual([]);
  });

  it("re-reads the table when the panel comes back", async () => {
    invokeMock.mockResolvedValueOnce(INSTALLED);
    await render(getCatalogEntry("claude-codex"));
    await render(getCatalogEntry("grok"));
    invokeMock.mockResolvedValueOnce(INSTALLED.slice(0, 1));
    await render(getCatalogEntry("claude-codex"));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(INSTALLED.slice(0, 1));
  });
});

describe("Codex cache choices", () => {
  const choices: ModelChoice[] = [
    { value: "gpt-next", label: "Next", efforts: [] },
    { value: "gpt-6-luna", label: "Luna", efforts: ["low", "max"] },
  ];

  it("uses the cache order and each model's effort choices", async () => {
    const entry = getCatalogEntry("codex")!;
    invokeMock.mockResolvedValueOnce(choices);
    await render(entry);
    expect(invokeMock).toHaveBeenCalledWith("codex_model_choices");
    expect(seen).toEqual(choices);
    expect(getLaunchEfforts(entry, "gpt-next", seen)).toEqual([]);
    expect(getLaunchEfforts(entry, "gpt-6-luna", seen)).toEqual(["low", "max"]);
    expect(getLaunchEfforts(entry, "gpt-5.6-luna", seen)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it.each([
    ["empty cache", () => invokeMock.mockResolvedValueOnce([])],
    ["invalid IPC payload", () => invokeMock.mockResolvedValueOnce({ models: [] })],
    ["failed read", () => invokeMock.mockRejectedValueOnce(new Error("unavailable"))],
  ])("keeps the fixed Codex entries for %s", async (_name, arrange) => {
    const entry = getCatalogEntry("codex")!;
    arrange();
    await render(entry);
    expect(seen).toEqual(entry.models);
    expect(seen.map((choice) => choice.value).slice(0, 2)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra"]);
    expect(getLaunchEfforts(entry, "gpt-6-luna", seen)).not.toContain("ultra");
  });

  it("discards a Codex response after the picker switches agents", async () => {
    let resolve: (models: ModelChoice[]) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise<ModelChoice[]>(res => { resolve = res; }));
    await render(getCatalogEntry("codex"));
    invokeMock.mockResolvedValueOnce(INSTALLED);
    await render(getCatalogEntry("claude-codex"));
    await act(async () => resolve(choices));
    expect(seen).toEqual(INSTALLED);
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
