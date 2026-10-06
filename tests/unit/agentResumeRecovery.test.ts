import { describe, expect, it, vi } from "vitest";
import { createAgentResumeRecovery, type ResumeRecoveryDependencies } from "../../src/lib/agentResumeRecovery";

const conflict = { kind: "claude", agentSessionId: "conversation-a", ownerSessionId: "owner-pty" };
function setup(overrides: Partial<ResumeRecoveryDependencies> = {}) {
  const deps: ResumeRecoveryDependencies = {
    ownerPresent: vi.fn().mockResolvedValue(true), ownerVisible: () => true,
    ownerWorking: () => true, openOwner: vi.fn(), confirmStop: vi.fn().mockResolvedValue(false),
    stopOwner: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined),
    fresh: vi.fn().mockResolvedValue(undefined), reopened: vi.fn(), ...overrides,
  };
  return { deps, recovery: createAgentResumeRecovery(conflict, deps) };
}

describe("SI conflict recovery", () => {
  it("opens the owner without spawning or stopping anything", async () => {
    const { deps, recovery } = setup();
    await recovery.openOwner();
    expect(deps.openOwner).toHaveBeenCalledOnce();
    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });
  it("does not stop a working owner without confirmation", async () => {
    const { deps, recovery } = setup();
    await recovery.takeover();
    expect(deps.confirmStop).toHaveBeenCalledWith(true, false);
    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });
  it("stops exactly the owner PTY after confirmation then resumes", async () => {
    const { deps, recovery } = setup({ confirmStop: vi.fn().mockResolvedValue(true) });
    await recovery.takeover();
    expect(deps.stopOwner).toHaveBeenCalledExactlyOnceWith("owner-pty");
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.stopOwner).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.resume).mock.invocationCallOrder[0]);
  });
  it("starts a fresh conversation without stopping the owner", async () => {
    const { deps, recovery } = setup();
    await recovery.fresh();
    expect(deps.fresh).toHaveBeenCalledOnce();
    expect(deps.stopOwner).not.toHaveBeenCalled();
  });
  it("automatically resumes once when the owner ends", async () => {
    const { deps, recovery } = setup({ ownerPresent: vi.fn().mockResolvedValue(false) });
    await Promise.all([recovery.ownerEnded(), recovery.ownerEnded(), recovery.ownerEnded()]);
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(deps.reopened).toHaveBeenCalledOnce();
    expect(deps.stopOwner).not.toHaveBeenCalled();
  });
  it("confirms and stops an owner missing from every window", async () => {
    const { deps, recovery } = setup({ ownerVisible: () => false, ownerWorking: () => false, confirmStop: vi.fn().mockResolvedValue(true) });
    await recovery.takeover();
    expect(deps.confirmStop).toHaveBeenCalledWith(false, true);
    expect(deps.stopOwner).toHaveBeenCalledExactlyOnceWith("owner-pty");
    expect(deps.resume).toHaveBeenCalledOnce();
  });
  it("keeps recovery available after a failed restart and suppresses disposed callbacks", async () => {
    const { deps, recovery } = setup({ ownerPresent: vi.fn().mockResolvedValue(false), resume: vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined) });
    await expect(recovery.ownerEnded()).rejects.toThrow("failed");
    await recovery.takeover();
    expect(deps.resume).toHaveBeenCalledTimes(2);
    recovery.dispose();
    await recovery.fresh();
    expect(deps.fresh).not.toHaveBeenCalled();
  });
});
