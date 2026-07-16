import type { AgentSessionKind, Pane, PaneTab, Workspace } from "../../types";

type SocketArgs = Record<string, unknown> | null | undefined;
type SpawnTarget = AgentSessionKind | "shell";
export type SpawnMode = "handoff" | "prompt" | "resume" | "shell" | "launch";

export interface SpawnPlan {
  target: SpawnTarget;
  mode: SpawnMode;
  launchEnv?: Record<string, string>;
  paneOptions: {
    agentId: "shell-starter";
    label?: string;
    cwd?: string;
    agentKind?: AgentSessionKind;
    agentSessionId?: string;
    launchEnv?: Record<string, string>;
  };
}

export interface SpawnTabPlan {
  mode: SpawnMode | "command";
  paneOptions: SpawnPlan["paneOptions"] & {
    commandArgv?: string[];
  };
}

function socketArgString(args: SocketArgs, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function socketArgBoolean(args: SocketArgs, key: string, fallback: boolean): boolean {
  const value = args?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function isAgentKind(value: string): value is AgentSessionKind {
  return value === "claude" || value === "codex" || value === "claude-codex";
}

function spawnTarget(args: SocketArgs): SpawnTarget {
  const target = socketArgString(args, "target");
  if (!target) throw new Error("pane.spawn requires target");
  if (target !== "shell" && !isAgentKind(target)) {
    throw new Error(`unsupported pane.spawn target: ${target}`);
  }
  return target;
}

function optionalAgentKind(args: SocketArgs, ...keys: string[]): AgentSessionKind | undefined {
  const value = socketArgString(args, ...keys);
  if (!value) return undefined;
  if (!isAgentKind(value)) throw new Error(`unsupported agent kind: ${value}`);
  return value;
}

export function resolveSpawnPlan(args: SocketArgs, handoffPromptPath?: string): SpawnPlan {
  const target = spawnTarget(args);
  const label = socketArgString(args, "label");
  const cwd = socketArgString(args, "cwd");
  const handoffFromSessionId = socketArgString(
    args,
    "handoffFromSessionId",
    "handoff_from_session_id",
  );
  const promptFile = socketArgString(args, "promptFile", "prompt_file");
  const resumeSessionId = socketArgString(args, "resumeSessionId", "resume_session_id");
  const paneOptions: SpawnPlan["paneOptions"] = {
    agentId: "shell-starter",
    ...(label ? { label } : {}),
    ...(cwd ? { cwd } : {}),
  };

  if (handoffFromSessionId) {
    if (target === "shell") throw new Error("pane.spawn handoff requires an agent target");
    if (!handoffPromptPath) throw new Error("pane.spawn handoff prompt path is unavailable");
    const handoffFromKind = optionalAgentKind(
      args,
      "handoffFromKind",
      "handoff_from_kind",
    );
    const launchEnv: Record<string, string> = {
      MYCMUX_AGENT_KIND: target,
      MYCMUX_HANDOFF: target,
      MYCMUX_HANDOFF_PROMPT_FILE: handoffPromptPath,
      MYCMUX_HANDOFF_FROM_SESSION: handoffFromSessionId,
      ...(handoffFromKind ? { MYCMUX_HANDOFF_FROM: handoffFromKind } : {}),
    };
    return { target, mode: "handoff", launchEnv, paneOptions: { ...paneOptions, launchEnv } };
  }

  if (promptFile) {
    if (target === "shell") throw new Error("pane.spawn prompt requires an agent target");
    const fromSessionId = socketArgString(args, "fromSessionId", "from_session_id") ?? "external";
    const fromKind = optionalAgentKind(args, "fromKind", "from_kind");
    const launchEnv: Record<string, string> = {
      MYCMUX_AGENT_KIND: target,
      MYCMUX_HANDOFF: target,
      MYCMUX_HANDOFF_PROMPT_FILE: promptFile,
      MYCMUX_HANDOFF_FROM_SESSION: fromSessionId,
      ...(fromKind ? { MYCMUX_HANDOFF_FROM: fromKind } : {}),
    };
    return { target, mode: "prompt", launchEnv, paneOptions: { ...paneOptions, launchEnv } };
  }

  if (resumeSessionId) {
    if (target === "shell") throw new Error("pane.spawn resume requires an agent target");
    const launchEnv: Record<string, string> = {
      MYCMUX_AGENT_KIND: target,
      MYCMUX_RESUME: target,
      MYCMUX_SESSION_ID: resumeSessionId,
    };
    return {
      target,
      mode: "resume",
      launchEnv,
      paneOptions: {
        ...paneOptions,
        agentKind: target,
        agentSessionId: resumeSessionId,
        launchEnv,
      },
    };
  }

  if (target === "shell") return { target, mode: "shell", paneOptions };

  const launchEnv = { MYCMUX_LAUNCH_TARGET: target };
  return { target, mode: "launch", launchEnv, paneOptions: { ...paneOptions, launchEnv } };
}

function hasSocketArg(args: SocketArgs, ...keys: string[]): boolean {
  return keys.some((key) => args != null && Object.prototype.hasOwnProperty.call(args, key));
}

export function resolveSpawnTabPlan(
  args: SocketArgs,
  handoffPromptPath?: string,
): SpawnTabPlan {
  const hasCommandArgv = hasSocketArg(args, "commandArgv", "command_argv");
  const target = socketArgString(args, "target");
  if (hasCommandArgv && target) {
    throw new Error("pane.spawn_tab accepts either commandArgv or target, not both");
  }

  if (hasCommandArgv) {
    const value = args?.commandArgv ?? args?.command_argv;
    if (
      !Array.isArray(value)
      || value.length === 0
      || value.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error("pane.spawn_tab commandArgv must be a non-empty array of non-empty strings");
    }
    const label = socketArgString(args, "label");
    const cwd = socketArgString(args, "cwd");
    return {
      mode: "command",
      paneOptions: {
        agentId: "shell-starter",
        ...(label ? { label } : {}),
        ...(cwd ? { cwd } : {}),
        commandArgv: value,
      },
    };
  }

  if (!target) throw new Error("pane.spawn_tab requires commandArgv or target");
  const plan = resolveSpawnPlan(args, handoffPromptPath);
  return { mode: plan.mode, paneOptions: plan.paneOptions };
}

export function clampPaneReadLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 80;
  return Math.min(400, Math.max(1, Math.trunc(value)));
}

function serializeWorkspaceForSocket(
  workspace: Workspace,
  activeWorkspaceId: string | null,
) {
  return {
    id: workspace.id,
    name: workspace.name,
    active: workspace.id === activeWorkspaceId,
    status: workspace.status,
    gridTemplateId: workspace.gridTemplateId,
    paneCount: workspace.panes.length,
    tabCount: workspace.panes.reduce((count, pane) => count + pane.tabs.length, 0),
  };
}

export function findPaneBySessionId(
  workspaces: Workspace[],
  sessionId: string,
): { workspace: Workspace; pane: Pane } | null {
  for (const workspace of workspaces) {
    const pane = workspace.panes.find((candidate) =>
      candidate.sessionId === sessionId
      || candidate.tabs.some((tab) => tab.sessionId === sessionId)
    );
    if (pane) return { workspace, pane };
  }
  return null;
}

async function startBackgroundTabSession(tab: PaneTab, pane: Pane): Promise<void> {
  const [{ getAgent, getDefaultAgent }, { ackFrontendData, createSession }] = await Promise.all([
    import("../../lib/agents"),
    import("../../lib/ipc"),
  ]);
  const agent = getAgent(tab.agentId) ?? getDefaultAgent();
  const command = tab.commandArgv?.[0] ?? agent.command;
  const commandArgs = tab.commandArgv?.length ? tab.commandArgv.slice(1) : agent.args;
  const launchEnv: Record<string, string> = {
    ...(tab.launchEnv ?? pane.launchEnv ?? {}),
    MYCMUX_PANE_SESSION_ID: tab.sessionId,
    MYCMUX_TAB_ID: tab.id,
  };
  if (tab.agentId === "shell-starter") {
    launchEnv.__CMUX_LAUNCHER_DONE = "1";
  }

  await createSession(
    tab.sessionId,
    command,
    commandArgs,
    80,
    24,
    (batch) => {
      void ackFrontendData(tab.sessionId, batch.generation, batch.seq, batch.bytes)
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn(`[mycmux-diag socket] headless PTY ack failed: ${tab.sessionId}`, error);
          }
        });
    },
    tab.cwd ?? pane.cwd,
    launchEnv,
  );
}

function isKnownPaneSession(workspaces: Workspace[], sessionId: string): boolean {
  return findPaneBySessionId(workspaces, sessionId) !== null;
}

async function resolveHandoffPromptPath(args: SocketArgs): Promise<string | undefined> {
  const handoffFromSessionId = socketArgString(
    args,
    "handoffFromSessionId",
    "handoff_from_session_id",
  );
  if (!handoffFromSessionId) return undefined;

  const { crsmCreateHandoff } = await import("../../lib/ipc");
  const target = spawnTarget(args);
  if (target === "shell") throw new Error("pane.spawn handoff requires an agent target");
  const handoffFromKind = optionalAgentKind(
    args,
    "handoffFromKind",
    "handoff_from_kind",
  );
  const result = await crsmCreateHandoff(
    handoffFromSessionId,
    handoffFromKind as AgentSessionKind,
    target,
    20,
  );
  return result.path;
}

async function spawnPane(args: SocketArgs) {
  const {
    useUiStore,
    useWorkspaceLayoutStore,
    useWorkspaceListStore,
  } = await import("../../stores/workspaceStore");
  const handoffPromptPath = await resolveHandoffPromptPath(args);

  const plan = resolveSpawnPlan(args, handoffPromptPath);
  const workspaceState = useWorkspaceListStore.getState();
  const workspaceId = socketArgString(args, "workspaceId", "workspace_id")
    ?? workspaceState.activeWorkspaceId
    ?? undefined;
  if (!workspaceId) throw new Error("pane.spawn requires an active workspace or workspaceId");
  const workspace = workspaceState.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
  if (workspace.panes.length === 0) throw new Error("pane.spawn requires a workspace with panes");

  const requestedAnchorId = socketArgString(args, "anchorPaneId", "anchor_pane_id");
  const activeSessionId = useUiStore.getState().activePaneId;
  const anchorPane = requestedAnchorId
    ? workspace.panes.find((pane) => pane.id === requestedAnchorId)
    : workspace.panes.find((pane) =>
        pane.sessionId === activeSessionId
        || pane.tabs.some((tab) => tab.sessionId === activeSessionId),
      ) ?? workspace.panes[0];
  if (!anchorPane) throw new Error("pane.spawn anchor pane not found");

  const directionArg = socketArgString(args, "direction") ?? "right";
  if (directionArg !== "right" && directionArg !== "down") {
    throw new Error(`unsupported pane.spawn direction: ${directionArg}`);
  }

  const beforePaneIds = new Set(workspace.panes.map((pane) => pane.id));
  useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions(
    workspaceId,
    anchorPane.id,
    directionArg,
    plan.paneOptions,
  );
  const updatedWorkspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
  const newPanes = updatedWorkspace?.panes.filter((pane) => !beforePaneIds.has(pane.id)) ?? [];
  if (newPanes.length !== 1) throw new Error("pane.spawn could not identify the new pane");
  const newPane = newPanes[0];

  if (socketArgBoolean(args, "activate", true)) {
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
  }
  return { workspaceId, paneId: newPane.id, sessionId: newPane.sessionId, mode: plan.mode };
}

async function spawnTab(args: SocketArgs) {
  const { useWorkspaceLayoutStore, useWorkspaceListStore } = await import(
    "../../stores/workspaceStore"
  );
  const anchorSessionId = socketArgString(args, "anchorSessionId", "anchor_session_id");
  if (!anchorSessionId) throw new Error("pane.spawn_tab requires anchorSessionId");

  const owner = findPaneBySessionId(
    useWorkspaceListStore.getState().workspaces,
    anchorSessionId,
  );
  if (!owner) throw new Error("pane.spawn_tab anchor session not found");

  const target = socketArgString(args, "target");
  const hasCommandArgv = hasSocketArg(args, "commandArgv", "command_argv");
  const plan = hasCommandArgv || !target
    ? resolveSpawnTabPlan(args)
    : resolveSpawnTabPlan(args, await resolveHandoffPromptPath(args));
  const { workspace, pane } = owner;
  const beforeTabIds = new Set(pane.tabs.map((tab) => tab.id));
  const activate = socketArgBoolean(args, "activate", false);
  useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(
    workspace.id,
    pane.id,
    {
      ...plan.paneOptions,
      activate,
    },
  );
  const updatedPane = useWorkspaceListStore.getState()
    .getWorkspace(workspace.id)
    ?.panes.find((candidate) => candidate.id === pane.id);
  const newTabs = updatedPane?.tabs.filter((tab) => !beforeTabIds.has(tab.id)) ?? [];
  if (newTabs.length !== 1) throw new Error("pane.spawn_tab could not identify the new tab");
  const newTab = newTabs[0];
  if (!activate && updatedPane) {
    await startBackgroundTabSession(newTab, updatedPane);
  }
  return {
    workspaceId: workspace.id,
    paneId: pane.id,
    tabId: newTab.id,
    sessionId: newTab.sessionId,
    mode: plan.mode,
  };
}

async function closeTab(args: SocketArgs) {
  const { useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.close_tab requires sessionId");

  let owner: { workspace: Workspace; pane: Pane; tab: Pane["tabs"][number] } | null = null;
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (tab) {
        owner = { workspace, pane, tab };
        break;
      }
    }
    if (owner) break;
  }
  if (!owner) throw new Error("pane.close_tab session not found");

  const { workspace, pane, tab } = owner;
  if (tab.type !== "terminal") throw new Error("pane.close_tab requires a terminal tab");
  if (pane.tabs.length === 1 && workspace.panes.length === 1) {
    throw new Error("refusing to close the last tab of the last pane");
  }

  const { pushClosedTab } = await import("../../stores/closedPaneStore");
  pushClosedTab(pane, tab);
  const [
    { evictTerminalCache },
    { killSession },
    { usePaneMetadataStore, useWorkspaceLayoutStore },
  ] = await Promise.all([
    import("../terminal/XTermWrapper"),
    import("../../lib/ipc"),
    import("../../stores/workspaceStore"),
  ]);
  evictTerminalCache(sessionId);
  killSession(sessionId).catch((err) =>
    console.warn("[mycmux] killSession failed", sessionId, err),
  );
  usePaneMetadataStore.getState().removeMetadata(sessionId);
  useWorkspaceLayoutStore.getState().removeTabFromPane(workspace.id, pane.id, tab.id);
  return { workspaceId: workspace.id, paneId: pane.id, tabId: tab.id };
}

async function sendPaneText(args: SocketArgs) {
  const [{ writeToSession }, { useWorkspaceListStore }] = await Promise.all([
    import("../../lib/ipc"),
    import("../../stores/workspaceStore"),
  ]);
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.send_text requires sessionId");
  const textValue = args?.text;
  const enter = socketArgBoolean(args, "enter", false);
  if (typeof textValue !== "string" || (!textValue && !enter)) {
    throw new Error("pane.send_text requires text, unless enter is true");
  }
  if (!isKnownPaneSession(useWorkspaceListStore.getState().workspaces, sessionId)) {
    throw new Error("pane.send_text session is not a known pane");
  }
  const data = textValue + (enter ? "\r" : "");
  await writeToSession(sessionId, data);
  return { sessionId, bytes: data.length };
}

async function readPane(args: SocketArgs) {
  const [{ getTerminalBufferLines, hasTerminalBuffer }, { useWorkspaceListStore }] = await Promise.all([
    import("../terminal/XTermWrapper"),
    import("../../stores/workspaceStore"),
  ]);
  const sessionId = socketArgString(args, "sessionId", "session_id");
  if (!sessionId) throw new Error("pane.read requires sessionId");
  if (!isKnownPaneSession(useWorkspaceListStore.getState().workspaces, sessionId)) {
    throw new Error("pane.read session is not a known pane");
  }
  if (!hasTerminalBuffer(sessionId)) throw new Error("no terminal buffer for session");
  const count = clampPaneReadLines(args?.lines);
  return { sessionId, lines: getTerminalBufferLines(sessionId, count) };
}

export async function handleSocketCommand(cmd: string, args: SocketArgs): Promise<unknown> {
  const { useUiStore, useWorkspaceListStore } = await import("../../stores/workspaceStore");
  const workspaceState = useWorkspaceListStore.getState();

  switch (cmd) {
    case "workspace.list":
    case "list_workspaces":
      return {
        activeWorkspaceId: workspaceState.activeWorkspaceId,
        workspaces: workspaceState.workspaces.map((workspace) =>
          serializeWorkspaceForSocket(workspace, workspaceState.activeWorkspaceId),
        ),
      };

    case "workspace.select":
    case "select_workspace": {
      const workspaceId = socketArgString(args, "workspaceId", "workspace_id", "id");
      if (!workspaceId) throw new Error("workspace.select requires workspaceId");
      const workspace = workspaceState.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      workspaceState.setActiveWorkspace(workspaceId);
      return { activeWorkspaceId: workspaceId };
    }

    case "workspace.rename":
    case "rename_workspace": {
      const workspaceId = socketArgString(args, "workspaceId", "workspace_id", "id");
      const name = socketArgString(args, "name");
      if (!workspaceId) throw new Error("workspace.rename requires workspaceId");
      if (!name) throw new Error("workspace.rename requires name");
      const workspace = workspaceState.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      workspaceState.renameWorkspace(workspaceId, name);
      return { id: workspaceId, name };
    }

    case "pane.list":
    case "list_panes": {
      const workspaceId = socketArgString(args, "workspaceId", "workspace_id", "id")
        ?? workspaceState.activeWorkspaceId
        ?? undefined;
      if (!workspaceId) throw new Error("pane.list requires an active workspace or workspaceId");
      const workspace = workspaceState.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      const activePaneId = useUiStore.getState().activePaneId;
      return {
        workspaceId,
        activePaneId,
        panes: workspace.panes.map((pane) => ({
          id: pane.id,
          active: pane.id === activePaneId,
          label: pane.label,
          cwd: pane.cwd,
          agentId: pane.agentId,
          agentKind: pane.agentKind,
          tabCount: pane.tabs.length,
          activeTabId: pane.activeTabId,
          tabs: pane.tabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            type: tab.type,
            cwd: tab.cwd,
            agentId: tab.agentId,
            agentKind: tab.agentKind,
          })),
        })),
      };
    }

    case "pane.spawn":
      return spawnPane(args);
    case "pane.spawn_tab":
      return spawnTab(args);
    case "pane.close_tab":
      return closeTab(args);
    case "pane.send_text":
      return sendPaneText(args);
    case "pane.read":
      return readPane(args);
    default:
      throw new Error(`Unknown socket command: ${cmd}`);
  }
}
