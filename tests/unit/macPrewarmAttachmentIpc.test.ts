// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createSession, SessionClosedError } from "../../src/lib/ipc";
import { expectTearoutAttachments } from "../../src/lib/tearout/sessionAttachment";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(), Channel: class { onmessage?: (frame: ArrayBuffer) => void; },
}));

beforeEach(() => { vi.mocked(invoke).mockReset(); });
describe("M4 prewarm channel ownership ordering", () => {
  it.each(["MacIntel", "Win32"])("keeps the channel contract on %s after a late source attach", async platform => {
    Object.defineProperty(navigator, "platform", { configurable:true, value:platform });
    const sessionId = "pty-m4-" + platform;
    const workspace = { id:"source", panes:[{ id:"pane", tabs:[{ id:"tab", type:"terminal", sessionId }] }] } as Workspace;
    useWorkspaceListStore.setState({ workspaces:[workspace], activeWorkspaceId:"source" });
    let resolve!: () => void;
    let route: unknown;
    let sourceAttaches = 0;
    const gate = new Promise<void>(yes => { resolve = yes; });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "create_session") { await gate; return; }
      if (command === "tearout_attach") {
        route = (args as { onData:unknown }).onData;
        if (route !== "destination") sourceAttaches++;
      }
    });
    const first = createSession(sessionId,"shell",[],80,24,()=>{});
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("create_session",expect.anything()), { timeout:10_000 });
    const warm = expectTearoutAttachments([sessionId], "prewarm", id =>
      useWorkspaceListStore.getState().workspaces.some(workspace => workspace.panes.some(pane => pane.tabs.some(tab => tab.sessionId===id))));
    const late = createSession(sessionId,"shell",[],80,24,()=>{},undefined,undefined,true).catch(error => error);
    // Destination attaches first, then the source loses its actual store row.
    await invoke("tearout_attach",{sessionId,onData:"destination"});
    useWorkspaceListStore.setState({workspaces:[],activeWorkspaceId:null});
    warm.dispose();
    resolve(); await first;
    const result = await late;
    if (platform === "MacIntel") {
      expect(sourceAttaches).toBe(0);
      expect(route).toBe("destination");
      expect(result).toBeInstanceOf(SessionClosedError);
    } else {
      expect(sourceAttaches).toBe(1);
      expect(route).not.toBe("destination");
      expect(result).toBeUndefined();
    }
  });
});

describe("M4 cancelled prewarm leases", () => {
  it("does not attach an already disposed prewarm even when its source still owns the session", async () => {
    Object.defineProperty(navigator, "platform", { configurable:true, value:"MacIntel" });
    const id="pty-cancelled-prewarm";
    useWorkspaceListStore.setState({workspaces:[{ id:"source",panes:[{ tabs:[{ id:"tab", sessionId:id }] }] } as Workspace]});
    let resolve!: () => void;
    const gate=new Promise<void>(yes=>{resolve=yes;});
    vi.mocked(invoke).mockImplementation(async command=>{if(command==="create_session") await gate;});
    const first=createSession(id,"shell",[],80,24,()=>{});
    await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith("create_session",expect.anything()),{timeout:10_000});
    const warm=expectTearoutAttachments([id],"prewarm");
    const late=createSession(id,"shell",[],80,24,()=>{},undefined,undefined,true).catch(error=>error);
    warm.dispose(); resolve(); await first;
    expect(await late).toBeInstanceOf(SessionClosedError);
    expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(["create_session"]);
  });
});
