import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const rust = read("src-tauri/src/commands/webpane.rs");
const manifests = JSON.parse(read("src-tauri/gen/schemas/acl-manifests.json"));
// Complete registration is checked by the independent Rust compiler oracle in
// app_ipc_acl.rs; this JS check reconciles every generated individual grant.
const registered = Object.values(manifests["__app-acl__"].permissions)
  .flatMap((permission) => (permission as { commands: { allow: string[] } }).commands.allow);
const generatedCapabilities = JSON.parse(read("src-tauri/gen/schemas/capabilities.json"));
const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
const childCapability = JSON.parse(read("src-tauri/capabilities/web-pane.json"));

function key(overrides: Partial<ReturnType<typeof baseKey>> = {}) {
  return { ...baseKey(), ...overrides };
}
function baseKey() {
  return {
    isTrusted: true, defaultPrevented: false, isComposing: false, keyCode: 9,
    key: "Tab", code: "Tab", location: 0, ctrlKey: true, altKey: false,
    shiftKey: false, metaKey: false, repeat: false,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
  };
}
function injectedShortcutHandler(shortcuts: string[]) {
  const functionSource = rust.slice(rust.indexOf("fn shortcut_initialization_script("),
    rust.indexOf("fn shortcut_update_script("));
  const raw = /r#"([\s\S]*?)"#/.exec(functionSource)![1]!;
  const script = raw.replaceAll("{state_name}", JSON.stringify("__MYCMUX_WEB_PANE_SHORTCUT_STATE__"))
    .replaceAll("{shortcuts}", JSON.stringify(shortcuts))
    .replaceAll("{tab_id}", JSON.stringify("tab_1"))
    .replaceAll("{{", "{").replaceAll("}}", "}");
  const invoke = vi.fn().mockResolvedValue(undefined);
  let handle: (event: ReturnType<typeof key>) => void = () => { throw new Error("handler missing"); };
  const window: {
    __TAURI_INTERNALS__: { invoke: typeof invoke };
    __MYCMUX_WEB_PANE_SHORTCUT_STATE__?: { shortcuts: Set<string> };
  } = { __TAURI_INTERNALS__: { invoke } };
  vm.runInNewContext(script, {
    window,
    document: { addEventListener: (name: string, handler: typeof handle, capture: boolean) => {
      expect(name).toBe("keydown"); expect(capture).toBe(true); handle = handler;
    } },
  });
  return { handle, invoke, window };
}

describe("C59-01 generated app policy", () => {
  it("includes every generated per-command allow in the local set without extras", () => {
    const app = manifests["__app-acl__"];
    expect(app).toBeDefined();
    expect(new Set(registered).size).toBe(registered.length);
    const grants = app.permission_sets["app-local"].permissions as string[];
    expect(new Set(grants)).toEqual(new Set(registered.map((command) => `allow-${command.replaceAll("_", "-")}`)));
    for (const command of registered) {
      const permission = app.permissions[`allow-${command.replaceAll("_", "-")}`];
      expect(permission.commands.allow).toEqual([command]);
      expect(permission.commands.deny).toEqual([]);
    }
    expect(defaultCapability.permissions).toContain("app-local");
  });

  it("keeps privileged local grants on primary webview labels without a window selector", () => {
    expect(defaultCapability.windows).toBeUndefined();
    expect(defaultCapability.webviews).toEqual(["main", "mycmux-w*"]);
    expect(defaultCapability.remote).toBeUndefined();
    expect(defaultCapability.local).toBe(true);
    expect(generatedCapabilities.default).toEqual(defaultCapability);
  });

  it("gives children exactly three replies and the dedicated shortcut command", () => {
    expect(childCapability.windows).toBeUndefined();
    expect(childCapability.webviews).toEqual(["web-pane-*"]);
    expect(childCapability.permissions).toEqual([
      "allow-webpane-read-result", "allow-webpane-push-result", "allow-webpane-eval-result",
      "allow-webpane-forward-shortcut",
    ]);
    expect(generatedCapabilities["web-pane"]).toEqual(childCapability);
  });
});

describe("actual injected Web pane shortcut script", () => {
  it("sends a registered trusted key only through the dedicated app command", () => {
    const { handle, invoke } = injectedShortcutHandler(["ctrl+tab"]);
    const event = key(); handle(event);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("webpane_forward_shortcut", {
      payload: {
        tabId: "tab_1", key: "Tab", code: "Tab", location: 0, ctrlKey: true,
        altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false,
      },
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("drops unregistered, synthetic, already-handled and composing key events", () => {
    const { handle, invoke } = injectedShortcutHandler(["ctrl+tab"]);
    for (const event of [key({ key: "r", code: "KeyR" }), key({ isTrusted: false }),
      key({ defaultPrevented: true }), key({ isComposing: true }), key({ keyCode: 229 })]) {
      handle(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the refreshed registration and preserves the Control+Shift+Tab payload", () => {
    const { handle, invoke, window } = injectedShortcutHandler(["ctrl+tab"]);
    window.__MYCMUX_WEB_PANE_SHORTCUT_STATE__!.shortcuts = new Set(["ctrl+shift+tab"]);
    handle(key()); expect(invoke).not.toHaveBeenCalled();
    handle(key({ shiftKey: true }));
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![1].payload.shiftKey).toBe(true);
  });
});


it("F5 reapplies current registration after remap, navigation and reload", () => {
  const pageLoad = rust.slice(rust.indexOf(".on_page_load("), rust.indexOf(".on_new_window("));
  expect(pageLoad).toMatch(/PageLoadEvent::Finished[\s\S]*restore_shortcut_registration/);
  const updateFunction = rust.slice(rust.indexOf("fn shortcut_update_script("), rust.indexOf("fn composer_push_script("));
  const rawUpdate = /r#"([\s\S]*?)"#/.exec(updateFunction)![1]!;
  const update = rawUpdate.replaceAll("{state_name}", JSON.stringify("__MYCMUX_WEB_PANE_SHORTCUT_STATE__"))
    .replaceAll("{shortcuts}", JSON.stringify(["ctrl+shift+pageup"]))
    .replaceAll("{{", "{").replaceAll("}}", "}");
  const oldDocument = injectedShortcutHandler(["ctrl+tab"]);
  vm.runInNewContext(update, { window: oldDocument.window });
  for (const document of [oldDocument, injectedShortcutHandler(["ctrl+tab"]), injectedShortcutHandler(["ctrl+tab"])]) {
    // New documents still run the creation-time initialization; load must apply current registration.
    vm.runInNewContext(update, { window: document.window });
    document.handle(key()); expect(document.invoke).not.toHaveBeenCalled();
    document.handle(key({ key: "PageUp", code: "PageUp", shiftKey: true }));
    expect(document.invoke).toHaveBeenCalledExactlyOnceWith("webpane_forward_shortcut", {
      payload: {
        tabId: "tab_1", key: "PageUp", code: "PageUp", location: 0, ctrlKey: true,
        altKey: false, shiftKey: true, metaKey: false, repeat: false, isComposing: false,
      },
    });
  }
});
