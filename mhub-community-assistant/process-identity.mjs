import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

// A numeric PID can be reused. Inspect the command and creation time before
// treating a process as one of this installation's workers.
export async function processIdentity(pid, script, {execImpl=exec,expectedTicket}={}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return {pid, matches:false};
  const expected = path.resolve(script).toLowerCase();
  try {
    const {stdout}=await execImpl('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('scripts/inspect-process.ps1',import.meta.url)),'-TargetId',String(pid)],{windowsHide:true,timeout:6000,maxBuffer:8192});
    if (!stdout.trim()) return {pid, matches:false};
    const info = JSON.parse(stdout.replace(/^\uFEFF/,''));
    if (!info.command) return {pid, matches:null};
    const args = (info.command.match(/"[^"]*"|[^\s]+/g) ?? []).map(arg=>arg.replace(/^"|"$/g,''));
    const executable=String(info.name).toLowerCase();
    const scriptArgument=script.endsWith('.ps1')?args[args.findIndex(arg=>arg.toLowerCase()==='-file')+1]:args[1];
    const allowed=script.endsWith('.ps1')?['powershell.exe','pwsh.exe'].includes(executable):executable==='node.exe';
    const ticketIndex=args.indexOf('--ticket');
    const matches = allowed&&!!scriptArgument&&path.resolve(scriptArgument).toLowerCase()===expected&&(expectedTicket===undefined||ticketIndex>=0&&args[ticketIndex+1]===expectedTicket);
    return {pid, matches, startedAt:info.startedAt};
  } catch { return {pid, matches:null,reason:'native-inspection-failed'}; }
}

export async function terminateOwned(identity, script) {
  if (identity?.matches !== true || !Number.isFinite(identity.startedAt)) throw Error('无法核对进程身份，已保留该进程。');
  const current = await processIdentity(identity.pid, script);
  if (current.matches === false) return;
  if (current.matches !== true || current.startedAt !== identity.startedAt) throw Error('进程身份已变化，请重试恢复。');
  process.kill(identity.pid);
}
