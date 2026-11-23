import {acquireSupervisorLock} from './process-lock.mjs';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RestartPolicy,writeJson} from './resilience.mjs';
import {ensureConnections as refreshConnections} from './startup.mjs';
import {randomUUID} from 'node:crypto';
import {processIdentity} from '../mhub-community-assistant/process-identity.mjs';
import {runtimeVersion,controllerOverdue} from './runtime-version.mjs';
import {resolveMhubExecutable} from './startup.mjs';
import {terminateOwned} from '../mhub-community-assistant/process-identity.mjs';
import {readDeviceLink} from './device-link-mode.mjs';
import {VoiceRecovery} from './voice-recovery.mjs';
import {releaseExpired,waitForRelease} from './release-policy.mjs';
import {driverRetryDelay} from './controller-connection.mjs';
import {createSyncLogger} from './sync-logger.mjs';
const root=new URL('./',import.meta.url),pidFile=new URL('supervisor.pid',root),statusFile=new URL('supervisor-status.json',root);
const read=async file=>{try{return JSON.parse(await fs.readFile(new URL(file,root),'utf8'));}catch{return null;}};
const exists=async name=>{try{await fs.access(new URL(name,root));return true;}catch{return false;}};
const alive=pid=>{try{if(!Number.isSafeInteger(pid)||pid<1)return false;process.kill(pid,0);return true;}catch{return false;}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const singleton=await acquireSupervisorLock();if(!singleton)process.exit(0);
const oldSupervisor=await processIdentity(Number(await read('supervisor.pid')),fileURLToPath(import.meta.url));
if(oldSupervisor.matches!==false){singleton.release();process.exit(0);}
await fs.rm(pidFile,{force:true});await fs.writeFile(pidFile,String(process.pid),{flag:'wx'});
// Only the explicit startup transaction may clear a previous stop request.
const instanceId=randomUUID(),startedAt=Date.now(),version=runtimeVersion();
const executable=await resolveMhubExecutable().catch(()=>null);
let relaunch=false,lastVersionCheck=0;
let stopping=false,child=null,restarts=0,releaseStartedAt=null;singleton.child.once('exit',()=>{stopping=true;void fs.writeFile(new URL('stop.request',root),'mutex-lost');});
let connectionCheck=null,nextConnectionCheck=0,connectionFailures=0,supervisorLogFallback=null;
const logSync=createSyncLogger(new URL('sync.log',root));
function relay(chunk){
 try{logSync(chunk);supervisorLogFallback=null;}
 catch(error){supervisorLogFallback=String(error.message).slice(0,180);console.error(String(chunk));}
}
let connectionRepair={state:'checking',error:null};
let panelChild=null,panelChecking=false,lastPanelCheck=0,panelFailures=0,panelState='checking';
const voiceScript=fileURLToPath(new URL('voice-chat/server.mjs',root));
const voiceRecovery=new VoiceRecovery({
 wanted:async()=>!stopping&&readDeviceLink().enabled&&!await exists('stop.request')&&(await read('../mhub-community-assistant/state/runtime-intent.json'))?.voice===true,
 probe:async()=>{
  let response;try{response=await fetch('http://127.0.0.1:18780/status',{signal:AbortSignal.timeout(1500),redirect:'error'});}catch{return {phase:'missing'};}
  let status;try{status=await response.json();}catch{return {phase:'occupied',error:'语音端口由无法识别的服务占用。'};}
  if(!response.ok||!Number.isSafeInteger(status.pid)||!status.phone||typeof status.nativeReady!=='boolean')return {phase:'occupied',error:'语音端口由无法识别的服务占用。'};
  const busy=status.busy!==false||!!status.request||!!status.ttsOperation||['incoming','dialing','connecting','connected'].includes(status.phone.phase);
  const phase=status.ready?(status.streamReady&&status.nativeReady?'running':'waiting-dependency'):'preparing';
  return {phase,pid:status.pid,startedAt:status.startedAt,version:status.version,expectedVersion:version,busy,progress:status.phase,error:status.error??status.nativeError??status.channelError??null};
 },
 owner:async()=>Number(await read('voice-chat/server.pid')),
 identity:pid=>processIdentity(pid,voiceScript),
 restart:async identity=>{
  // Only reached after two fresh idle replies and a verified ownership probe.
  const response=await fetch('http://127.0.0.1:18780/shutdown',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ifIdle:true,expectedPid:identity.pid}),signal:AbortSignal.timeout(2000),redirect:'error'});
  if(!response.ok)throw Error('语音已进入使用状态，保留当前进程，稍后再检查。');
  const until=Date.now()+35000;
  while(alive(identity.pid)&&Date.now()<until)await wait(250);
  if(alive(identity.pid))await terminateOwned(identity,voiceScript);
 },
 launch:()=>new Promise((resolve,reject)=>{
  const launcher=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('voice-chat/Start.ps1',root)),'-Automatic'],{cwd:fileURLToPath(root),windowsHide:true,stdio:['ignore','inherit','inherit']});
  launcher.once('error',reject);launcher.once('exit',code=>code===0?resolve():reject(Error('语音自动启动失败，请检查启动日志。')));
 }),
});
async function ensurePanel(){
 if(panelChecking||Date.now()-lastPanelCheck<3000)return;lastPanelCheck=Date.now();panelChecking=true;
 try{
  const response=await fetch('http://127.0.0.1:18782/health',{signal:AbortSignal.timeout(1500),redirect:'error'});
  if(response.ok){const value=await response.json();if(value.service==='dafeiyu-panel'&&value.ok){panelFailures=0;panelState='running';return;}}
  // An old panel may still work. Never replace an unrecognized port owner.
  if(response.status===404){panelState='legacy';return;}
  panelState='unrecognized';return;
 }catch{
  panelFailures++;panelState='reconnecting';
  if(panelChild&&panelChild.exitCode===null)return;
  if(panelFailures<2)return;
  panelChild=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../mhub-community-assistant/scripts/watch-panel.ps1',root)),'-NodePath',process.execPath],{cwd:fileURLToPath(root),windowsHide:true,stdio:['ignore','inherit','inherit']});
  panelChild.once('error',()=>{panelChild=null;});panelChild.once('exit',()=>{panelChild=null;});panelState='starting';
 }finally{panelChecking=false;}
}
async function ensureConnections(){
 if(!readDeviceLink().enabled||connectionCheck||Date.now()<nextConnectionCheck)return;nextConnectionCheck=Date.now()+10000;
 if(await exists('stop.request'))return;
 connectionRepair={...connectionRepair,state:'checking'};
 connectionCheck=refreshConnections().then(()=>{connectionFailures=0;connectionRepair={state:'checked',error:null,at:Date.now()};}).catch(error=>{connectionRepair={state:'failed',error:String(error.message).slice(0,400),at:Date.now()};nextConnectionCheck=Date.now()+Math.max(10000,driverRetryDelay(++connectionFailures+4));relay(JSON.stringify({event:'dependency-repair-failed',...connectionRepair})+'\n');}).finally(()=>{connectionCheck=null;});
}
const policy=new RestartPolicy();
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
async function status(state,extra={}){await writeJson(statusFile,{pid:process.pid,instanceId,startedAt,version,mhubExecutable:executable,at:Date.now(),state,childPid:child?.pid??null,restarts,panelState,voiceRecovery:voiceRecovery.state,connectionRepair,supervisorLogFallback,...extra}).catch(()=>{});}
async function terminateController(reason,journal){
 await writeJson(new URL('shutdown-pending.json',root),{at:Date.now(),pid:child.pid,reason,journal});
 const script=fileURLToPath(new URL('optimized.mjs',root)),identity=await processIdentity(child.pid,script);
 if(identity.matches!==true){await status('release-blocked');return false;}
 await terminateOwned(identity,script);return true;
}
try{
 while(!stopping){
  ensureConnections();
  void voiceRecovery.tick();
  void ensurePanel();
  if(!readDeviceLink().enabled||await exists('stop.request'))break;
  policy.started();const startedAt=Date.now();
  child=spawn(process.execPath,[fileURLToPath(new URL('optimized.mjs',root)),'--hold'],{cwd:fileURLToPath(root),windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',relay);child.stderr.on('data',relay);
  let exited=false,exitCode=null;child.once('exit',code=>{exited=true;exitCode=code;});child.once('error',()=>{exited=true;exitCode=-1;});
  let askedAt=0,stopAt=0;releaseStartedAt=null;
  while(!stopping&&!exited){
   const health=await read('controller-health.json'),journal=await read('session.json');
   ensureConnections();
   void voiceRecovery.tick();
   void ensurePanel();
   const heartbeatFresh=health?.pid===child.pid&&Date.now()-health.at<45000;
   const slowPhase=journal?.pid===child.pid&&['preparing','installing-resident','restoring-original-screen'].includes(journal.phase);
   const overdue=controllerOverdue(health,child.pid,startedAt,Date.now(),slowPhase);
   if(Date.now()-lastVersionCheck>10000){
    lastVersionCheck=Date.now();
    if(runtimeVersion()!==version){relaunch=true;stopping=true;await fs.writeFile(new URL('handoff.request',root),'version-update');}
   }
   const stopRequested=!readDeviceLink().enabled||await exists('stop.request');
   if(stopRequested){
    stopAt ||= Date.now();releaseStartedAt??=stopAt;
    if(releaseExpired(releaseStartedAt,Date.now())){
     if(!await terminateController('release-timeout',journal))break;
    }
   }
   if(readDeviceLink().enabled&&!await exists('stop.request')){
    if(overdue&&!askedAt){askedAt=Date.now();releaseStartedAt??=askedAt;await fs.writeFile(new URL('handoff.request',root),'supervisor-recovery');}
    if(askedAt&&releaseExpired(releaseStartedAt,Date.now())&&!await terminateController('recovery-release-timeout',journal))break;
   }
   await status(overdue?'recovering':heartbeatFresh?(health.connection?.state==='ready'?'running':'reconnecting'):'starting',{heartbeatAt:health?.pid===child.pid?health.at:null});
   // The controller handles explicit stop and restores the previous scene.
   if(stopping&&!relaunch)await fs.writeFile(new URL('stop.request',root),'stop');
   await wait(1000);
  }
  if(stopping||!readDeviceLink().enabled||await exists('stop.request'))break;
  restarts++;const delay=policy.exited(),nextRetryAt=Date.now()+delay;
  await status('restarting',{exitCode,nextRetryAt});
  while(!stopping&&Date.now()<nextRetryAt){if(!readDeviceLink().enabled||await exists('stop.request')){stopping=true;break;}await wait(150);}
 }
}finally{
 if(child&&alive(child.pid)){releaseStartedAt??=Date.now();await fs.writeFile(new URL(relaunch?'handoff.request':'stop.request',root),relaunch?'version-update':'stop');await waitForRelease(()=>alive(child.pid),{startedAt:releaseStartedAt});}
 if(child&&alive(child.pid)){
  await terminateController('release-timeout',await read('session.json'));
 }
 await status(child&&alive(child.pid)?'release-blocked':'stopped');if(Number(await read('supervisor.pid'))===process.pid)await fs.rm(pidFile,{force:true});singleton.child.removeAllListeners('exit');singleton.release();
 if(relaunch&&!alive(child?.pid)&&readDeviceLink().enabled&&!await exists('stop.request')){
  await wait(1000);
  const next=spawn(process.execPath,[fileURLToPath(import.meta.url)],{cwd:fileURLToPath(root),windowsHide:true,detached:true,stdio:'ignore'});
  next.on('error',error=>console.error(error.message));next.unref();
 }
}
