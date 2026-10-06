import { expect, it, vi } from 'vitest';
import { createAgentResumeRecovery, type ResumeRecoveryDependencies } from '../../src/lib/agentResumeRecovery';
import { buildAgentRecoveryLaunch } from '../../src/components/terminal/terminalLaunchParams';

const oldId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const conflict = {kind:'claude',agentSessionId:oldId,ownerSessionId:'owner'};
function setup(overrides: Partial<ResumeRecoveryDependencies> = {}) {
  const deps: ResumeRecoveryDependencies = {
    ownerPresent: vi.fn().mockResolvedValue(true),ownerVisible:()=>true,ownerWorking:()=>true,
    openOwner:vi.fn(),confirmStop:vi.fn().mockResolvedValue(false),stopOwner:vi.fn().mockResolvedValue(undefined),
    resume:vi.fn().mockResolvedValue(undefined),fresh:vi.fn().mockResolvedValue(undefined),reopened:vi.fn(),...overrides,
  };
  return {deps,controller:createAgentResumeRecovery(conflict,deps)};
}
it('VR no stop before delayed confirmation; cancel and concurrent polls do not stop any PTY',async()=>{
  let resolve!:(yes:boolean)=>void;
  const {deps,controller}=setup({confirmStop:()=>new Promise(r=>resolve=r)});
  const action=controller.takeover();
  await vi.waitFor(()=>expect(resolve).toBeDefined(),{timeout:1000});
  await Promise.all([controller.takeover(),controller.ownerEnded(),controller.fresh()]);
  expect(deps.stopOwner).not.toHaveBeenCalled();
  resolve(false);await action;
  expect(deps.stopOwner).not.toHaveBeenCalled();expect(deps.resume).not.toHaveBeenCalled();
});
it('VR disappearance during confirmation does not stop a replacement or any unrelated PTY',async()=>{
  let present=true;
  const {deps,controller}=setup({ownerPresent:async()=>present,confirmStop:async()=>{present=false;return true;}});
  await controller.takeover();expect(deps.stopOwner).not.toHaveBeenCalled();expect(deps.resume).toHaveBeenCalledOnce();
});
it('VR stop failure prevents restart and retains manual retry',async()=>{
  const {deps,controller}=setup({confirmStop:async()=>true,stopOwner:vi.fn().mockRejectedValueOnce(Error('stop failed')).mockResolvedValue(undefined)});
  await expect(controller.takeover()).rejects.toThrow('stop failed');expect(deps.resume).not.toHaveBeenCalled();
  await controller.takeover();expect(deps.resume).toHaveBeenCalledOnce();expect(deps.stopOwner).toHaveBeenNthCalledWith(2,'owner');
});
it('VR failed automatic attempt is not repeated by later polls',async()=>{
  const {deps,controller}=setup({ownerPresent:async()=>false,resume:vi.fn().mockRejectedValue(Error('attach failed'))});
  await expect(controller.ownerEnded()).rejects.toThrow('attach failed');
  for(let i=0;i<30;i++)await controller.ownerEnded();expect(deps.resume).toHaveBeenCalledOnce();
});
it('VR disposal while confirmation is pending prevents termination',async()=>{
  let resolve!:(yes:boolean)=>void;
  const {deps,controller}=setup({confirmStop:()=>new Promise(r=>resolve=r)});
  const action=controller.takeover();await vi.waitFor(()=>expect(resolve).toBeDefined(),{timeout:1000});
  controller.dispose();resolve(true);await action;expect(deps.stopOwner).not.toHaveBeenCalled();
});
it.each(['claude','grok','codex'])('VR direct %s recovery retains model/effort and replaces the old id',kind=>{
  const args=kind==='codex'?['resume',oldId,'--model','fake-model']:['--resume',oldId,'--model','fake-model'];
  const result=buildAgentRecoveryLaunch({command:kind+'.exe',args,launchEnv:{MYCMUX_EFFORT:'max'}},kind,newId,false);
  expect(result.args).not.toContain(oldId);expect(result.args).toContain(newId);expect(result.args).toContain('fake-model');expect(result.launchEnv?.MYCMUX_EFFORT).toBe('max');
});
it('VR choosing another existing Claude conversation must remove the short resume flag',()=>{
  const result=buildAgentRecoveryLaunch({command:'claude.exe',args:['-r',oldId,'--model','fake-model']},'claude',newId,false);
  expect(result.args).not.toContain(oldId);expect(result.args).not.toContain('-r');expect(result.args).toContain(newId);
});
it('VR npm Claude recovery must replace its explicit script argv identity',()=>{
  const result=buildAgentRecoveryLaunch({command:'node.exe',args:['C:/fixture/claude-code/cli.js','--resume',oldId]},'claude',newId,true);
  expect(result.args).not.toContain(oldId);expect(result.args).toContain(newId);
});
it('VR direct hybrid recovery must replace its explicit argv identity',()=>{
  const result=buildAgentRecoveryLaunch({command:'claude-codex',args:['--resume',oldId]},'claude-codex',newId,true);
  expect(result.args).not.toContain(oldId);expect(result.args).toContain(newId);
});

// All supported direct launch forms must agree with the recovery selection.
it.each(['claude.cmd', 'claude-codex.cmd', 'grok.cmd', 'CLAUDE.EXE'])(
  'F4 rewrites shim identity for %s', command => {
    const kind = command.toLowerCase().startsWith('grok') ? 'grok' : command.startsWith('claude-codex') ? 'claude-codex' : 'claude';
    const result = buildAgentRecoveryLaunch({command, args: ['--resume=' + oldId, '--model', 'fake-model']}, kind, newId, true);
    expect(result.args).toEqual(['--model', 'fake-model', '--session-id', newId]);
    expect(result.launchEnv?.MYCMUX_SESSION_ID).toBe(newId);
    expect(result.launchEnv?.MYCMUX_LAUNCH_TARGET).toBeUndefined();
  },
);
it.each(['--resume', '--resume=', '-r', '-r=', '--session-id', '--session-id='])(
  'F4 removes the old identity value for %s', flag => {
    const stale = flag.endsWith('=') ? [flag + oldId] : [flag, oldId];
    const params = {command: 'claude.exe', args: [...stale, '--effort', 'max']};
    const result = buildAgentRecoveryLaunch(params, 'claude', newId, false);
    expect(result.args).toEqual(['--effort', 'max', '--resume', newId]);
    expect(params.args).toEqual([...stale, '--effort', 'max']);
  },
);
it.each(['bash.exe', '/bin/sh', '/bin/zsh', 'pwsh.exe', 'powershell.exe', 'cmd.exe'])(
  'F4 preserves the shell launcher command for %s', command => {
    const args = ['-c', 'source launcher; exec shell'];
    const result = buildAgentRecoveryLaunch({command, args}, 'claude', newId, true);
    expect(result.args).toEqual(args);
    expect(result.launchEnv?.MYCMUX_LAUNCH_TARGET).toBe('claude');
    expect(result.launchEnv?.MYCMUX_SESSION_ID).toBe(newId);
  },
);
it.each(['node.exe', 'bun'])(
  'F4 preserves the package script prefix for %s', command => {
    const script = 'C:/fixture/claude-code/cli.js';
    const result = buildAgentRecoveryLaunch({command, args: [script, '-r=' + oldId, '--model', 'fake-model']}, 'claude', newId, false);
    expect(result.args).toEqual([script, '--model', 'fake-model', '--resume', newId]);
  },
);
it('F4 keeps codex npm script and profile when changing a resume target', () => {
  const result = buildAgentRecoveryLaunch({command: 'node', args: ['C:/fixture/codex/bin/codex.js', 'resume', oldId, '-p', 'sample-profile']}, 'codex', newId, false);
  expect(result.args).toEqual(['C:/fixture/codex/bin/codex.js', 'resume', newId, '-p', 'sample-profile']);
});
it('F4 leaves an unknown interpreter script on the launcher path', () => {
  const params = {command: 'node', args: ['C:/fixture/tool.js', '--resume', oldId]};
  const result = buildAgentRecoveryLaunch(params, 'claude', newId, true);
  expect(result.args).toEqual(params.args);
  expect(result.launchEnv?.MYCMUX_LAUNCH_TARGET).toBe('claude');
});

it('F4 replaces a Codex resume target after global profile and directory options', () => {
  const result = buildAgentRecoveryLaunch({command: 'codex.cmd', args: ['-p', 'sample-profile', 'resume', '--no-alt-screen', '-C', 'C:/fixture', oldId, '--model', 'fake-model']}, 'codex', newId, false);
  expect(result.args).toEqual(['resume', newId, '-p', 'sample-profile', '--no-alt-screen', '-C', 'C:/fixture', '--model', 'fake-model']);
});
it('F4 does not confuse a Codex profile named resume with the subcommand', () => {
  const result = buildAgentRecoveryLaunch({command: 'codex', args: ['-p', 'resume', 'resume', oldId]}, 'codex', newId, false);
  expect(result.args).toEqual(['resume', newId, '-p', 'resume']);
});

it('F4 keeps the known Codex helper runtime out of direct agent recovery', () => {
  const params = {command: 'C:/fixture/openai/codex/runtimes/cua_node/node.exe', args: ['C:/fixture/codex.js', '--resume', oldId]};
  const result = buildAgentRecoveryLaunch(params, 'codex', newId, false);
  expect(result.args).toEqual(params.args);
  expect(result.launchEnv?.MYCMUX_LAUNCH_TARGET).toBe('codex');
});
