import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/types";

const mocks = vi.hoisted(() => ({
  getDefaultShell: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../../src/lib/ipc", () => ({
  getDefaultShell: mocks.getDefaultShell,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

async function loadLauncherAgent(
  shell: { command: string; args: string[] },
  platform: string,
  integratedShell = false,
): Promise<AgentDefinition> {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform });
  mocks.getDefaultShell.mockResolvedValue(shell);
  mocks.invoke.mockResolvedValue(null);

  const { getAgent, getDefaultAgent, initDefaultShell } = await import("../../src/lib/agents");
  await initDefaultShell();
  const launcher = integratedShell ? getDefaultAgent(true) : getAgent("shell-starter");
  if (!launcher) throw new Error("Launch Menu agent is missing");
  return launcher;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Launch Menu shell wiring", () => {
  it("sources the bash launcher when macOS reports zsh as the default shell", async () => {
    const launcher = await loadLauncherAgent({ command: "/bin/zsh", args: [] }, "MacIntel");

    expect(launcher.command).toBe("/bin/bash");
    expect(launcher.args).toEqual([
      "-i",
      "-c",
      'if [ -f "$HOME/.mycmux/bin/launcher.sh" ]; then source "$HOME/.mycmux/bin/launcher.sh"; fi; exec "${SHELL:-/bin/zsh}" -i',
    ]);
  });

  it("sources the bash launcher for zsh even when the platform does not read as mac", async () => {
    // The macOS WKWebView reported a non-mac platform here, which dropped every
    // launcher pane back to a bare `zsh -i`: the menu drew, and picking an
    // agent started nothing. The shell leaf alone has to decide.
    const launcher = await loadLauncherAgent({ command: "/bin/zsh", args: ["-l"] }, "");

    expect(launcher.command).toBe("/bin/bash");
    expect(launcher.args).toEqual([
      "-i",
      "-c",
      'if [ -f "$HOME/.mycmux/bin/launcher.sh" ]; then source "$HOME/.mycmux/bin/launcher.sh"; fi; exec "${SHELL:-/bin/zsh}" -i',
    ]);
  });

  it("keeps wrapper definitions in the interactive Bash instead of execing back to zsh", async () => {
    const launcher = await loadLauncherAgent({ command: "/bin/zsh", args: [] }, "MacIntel", true);
    expect(launcher.command).toBe("/bin/bash");
    expect(launcher.args.slice(0, 4)).toEqual(["--noprofile", "--norc", "-i", "-c"]);
    expect(launcher.args.at(-1)).toContain('exec "$BASH" --noprofile --rcfile "$HOME/.mycmux/bin/launcher.sh" -i');
    expect(launcher.args.at(-1)).not.toContain("/bin/zsh");
  });

  it.each(["powershell.exe", "pwsh.exe", "cmd.exe"])("uses interactive PowerShell directly for terminal mode with %s", async command => {
    const launcher = await loadLauncherAgent({ command, args: [] }, "Win32", true);
    expect(launcher.command).toBe(command === "cmd.exe" ? "powershell.exe" : command);
    expect(launcher.args).toContain("-NoExit");
    expect(launcher.args).toContain("-NoProfile");
    expect(launcher.args.at(-1)).toContain("{ . $launcher }");
    expect(launcher.args.at(-1)).not.toContain("& $launcher");
  });

  it("leaves a non-bash, non-zsh shell on the bare-shell path", async () => {
    const launcher = await loadLauncherAgent({ command: "/usr/bin/fish", args: ["-l"] }, "Linux x86_64");

    expect(launcher.command).toBe("/usr/bin/fish");
    expect(launcher.args).toEqual(["-l"]);
  });
});
