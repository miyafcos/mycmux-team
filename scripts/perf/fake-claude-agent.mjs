// Synthetic process identity for the isolated livebrief probe only.
// The monitor recognizes a node script containing "claude" and --session-id.
// No real agent CLI, account, or network request is involved.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const profileIndex=process.argv.indexOf('--profile-name');
const profile=profileIndex>=0?process.argv[profileIndex+1]:'perf3';
if(!/^[a-zA-Z0-9_-]+$/.test(profile??''))throw new Error('Invalid isolated profile name');
const expected=join(process.env.USERPROFILE,`.mycmux-${profile}`);
if(resolve(process.env.MYCMUX_RUNTIME_DIR??'')!==resolve(expected))throw new Error(`Requires ${profile} runtime`);
const index=process.argv.indexOf('--session-id');
const id=index>=0?process.argv[index+1]:'';
if(!/^[0-9a-f-]{36}$/.test(id??''))throw new Error('Requires synthetic session UUID');
const script=fileURLToPath(new URL('./fake-agent.ps1',import.meta.url));
const child=spawn('powershell.exe',['-NoProfile','-File',script,'-SessionId',id,'-Name',profile],{stdio:'inherit',windowsHide:true});
child.once('error',error=>{console.error(error);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
