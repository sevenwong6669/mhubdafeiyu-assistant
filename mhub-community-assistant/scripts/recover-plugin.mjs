import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {PluginRecovery,recoveryVoiceResult,RecoveryBudget,RECOVERY_TOTAL_MS,RECOVERY_HEARTBEAT_MS} from '../recovery.mjs';
import {resolveNodeExecutable,startHostBackend} from '../host-startup.mjs';
import {processIdentity,terminateOwned} from '../process-identity.mjs';
import {SyncStartup} from '../../harness-mhub-sync/startup.mjs';
import {readDeviceLink} from '../../harness-mhub-sync/device-link-mode.mjs';
import {writeJson} from '../../harness-mhub-sync/resilience.mjs';
import {RELEASE_OBSERVE_MS,waitForRelease} from '../../harness-mhub-sync/release-policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=path.join(root,'state');
const sync=path.resolve(root,'../harness-mhub-sync');
const read=async file=>{try{return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch{return null;}};
let activeBudget=null;
const checkpoint=async()=>activeBudget?.check();
const pause=ms=>new Promise((resolve,reject)=>{
 const signal=activeBudget?.signal;signal?.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});
});
export function recoveryActivity(voice,companion){
  if(['incoming','dialing','connecting','connected'].includes(voice?.phone?.phase)||voice?.request||voice?.busy||voice?.ttsOperation||companion?.call===true||['preparing','connected'].includes(companion?.nativeCall?.phase))return '语音或通话正在使用，请结束后再重启插件。';
  const watch=companion?.watchStatus,phase=watch?.capture?.phase;
  const capturePresent=companion?.online!==false||watch?.fresh===true&&phase==='running';
  if((companion?.watch===true||watch?.on===true)&&capturePresent&&!['stopped','failed'].includes(phase))return '陪看正在使用，请先结束陪看再重启插件。';
  return null;
}
export const recoveryVoiceWanted=(intent,linkEnabled)=>linkEnabled===true&&intent?.voice===true;
export function recoveryHarnessResult(native,heartbeat,version,now=Date.now()){
  const age=now-Number(heartbeat?.at);
  if(native?.stage!=='attached'||!native.runtimeVersion||!version||native.pid!==heartbeat?.pid
      ||heartbeat.stopped===true||!(age>=0&&age<10000))return null;
  const ok=native.runtimeVersion===version;
  return {service:'harness',ok,message:ok?'Harness 已加载当前插件版本。':'Harness 仍在使用旧版插件，请重新打开 Harness 加载当前版本。'};
}
async function request(url,body) {
  await checkpoint();
  try {
    const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([AbortSignal.timeout(2000),...(activeBudget?[activeBudget.signal]:[])])});
    return response.ok?await response.json():null;
  } catch { activeBudget?.signal.throwIfAborted();return null; }
}
async function write(file,value){await writeJson(pathToFileURL(file),value);}
async function identityFromFile(file,script) {
  const pid=Number(await fs.readFile(file,'utf8').catch(()=>0));
  return processIdentity(pid,script);
}
async function finishProcess(identity,script,{waitMs=4000,force=true}={}) {
  if(identity.matches===null)throw Error('Windows 不允许核对旧进程，请从相同用户权限打开诊断入口。');
  if(identity.matches!==true)return;
  const released=await waitForRelease(async()=>{await checkpoint();try{process.kill(identity.pid,0);return true;}catch(error){return error.code!=='ESRCH';}},{budgetMs:waitMs});
  if(released)return;
  if(!force)throw Error('设备仍在完成灯效或屏幕恢复，请稍等后刷新状态。');
  await checkpoint();await terminateOwned(identity,script);
  for(let i=0;i<16;i++) {
    await checkpoint();
    if((await processIdentity(identity.pid,script)).matches===false)return;
    await pause(250);
  }
  throw Error('旧服务仍在释放资源，请稍后重新诊断。');
}

async function recover(ticketId) {
  const lock=path.join(state,'recovery.lock');
  const reservation=await read(lock);
  if(reservation?.ticketId!==ticketId)throw Error('恢复任务已失效。');
  const startedAt=Date.now(),workerStartedAt=Math.round(Date.now()-process.uptime()*1000),results=[];
  const deadlineAt=Math.min(reservation.deadlineAt??Infinity,startedAt+RECOVERY_TOTAL_MS);
  const budget=new RecoveryBudget({deadlineAt,cancelled:async()=>{
    const current=await read(lock),cancel=await read(path.join(state,'recovery-cancel.json'));
    return current?.ticketId!==ticketId||current.pid!==process.pid||cancel?.ticketId===ticketId&&cancel.pid===process.pid&&Math.abs(cancel.startedAt-workerStartedAt)<2000;
  }});activeBudget=budget;
  await write(lock,{...reservation,pid:process.pid,worker:true,startedAt:workerStartedAt,deadlineAt});
  let phase='checking',message='正在核对占用和进程身份。',progressAt=startedAt,statusTail=Promise.resolve();
  const pulse=()=>{const value={ticketId,phase,message,startedAt,deadlineAt,at:Date.now(),heartbeatAt:Date.now(),lastProgressAt:progressAt,results:[...results]};
    const task=statusTail.catch(()=>{}).then(async()=>{if((await read(lock))?.ticketId===ticketId)await write(path.join(state,'recovery-status.json'),value);});statusTail=task;return task;
  };
  const status=async(next,text)=>{if(!['failed','partial','completed'].includes(next))await budget.check();phase=next;message=text;progressAt=Date.now();await pulse();};
  const heartbeat=setInterval(()=>{void budget.check().catch(()=>{});void pulse().catch(()=>{});},RECOVERY_HEARTBEAT_MS);heartbeat.unref();
  try {
    await status('checking','正在核对占用和进程身份。');
    const [voice,companion]=await Promise.all([request('http://127.0.0.1:18780/status'),request('http://127.0.0.1:18782/api/mhub-community/companion/state')]);
    const busy=recoveryActivity(voice,companion);if(busy)throw Error(busy);
    const voiceScript=path.join(sync,'voice-chat/server.mjs');
    const voiceIdentity=voice?await processIdentity(voice.pid,voiceScript):null;
    if(voice&&voiceIdentity.matches!==true)throw Error('语音端口上的进程身份无法核对，请检查本机权限和端口。');
    const upload=await read(path.join(sync,'device-asset-upload.lock'));
    if(upload&&Date.now()-upload.at<180000)throw Error('音箱可能正在上传，请等本次上传结束再重启。');
    const intent=await read(path.join(state,'runtime-intent.json'))??{};
    const wantSync=intent.sync!==false;
    const wantVoice=intent.voice===true || intent.voice!==false&&!!voice;
    await write(path.join(state,'runtime-intent.json'),{...intent,sync:wantSync,voice:wantVoice,at:Date.now()});
    const guard=await read(path.join(state,'panel-guard.json'));
    const guardScript=path.join(root,'scripts/watch-panel.ps1');
    const guardIdentity=await processIdentity(guard?.pid,guardScript);
    if(guardIdentity.matches===null)throw Error('无法核对网页守护权限，请从本机诊断入口重试。');
    // Recheck the desktop before stopping services. The voice service performs
    // its own conditional shutdown if a call began after the earlier snapshot.
    const latestActivity=recoveryActivity(null,await request('http://127.0.0.1:18782/api/mhub-community/companion/state'));if(latestActivity)throw Error(latestActivity);
    if(voice){
      const quit=await request('http://127.0.0.1:18780/shutdown',{ifIdle:true,expectedPid:voice.pid});
      if(quit?.ok!==true)throw Error('语音状态已变化或未确认退出，已保留当前服务，请稍后重试。');
    }
    // Stop the guard first, otherwise it could restart the panel mid-recovery.
    await checkpoint();if(guardIdentity.matches===true)await terminateOwned(guardIdentity,guardScript);
    await status('releasing','正在释放旧服务和设备控制权。');
    const controllerScript=path.join(sync,'optimized.mjs'),supervisorScript=path.join(sync,'supervisor.mjs');
    const controller=await identityFromFile(path.join(sync,'run.pid'),controllerScript);
    const supervisor=await identityFromFile(path.join(sync,'supervisor.pid'),supervisorScript);
    if(controller.matches===null||supervisor.matches===null)throw Error('无法核对联动进程身份，请检查本机权限。');
    await checkpoint();await fs.writeFile(path.join(sync,'stop.request'),'stop');
    await Promise.all([finishProcess(controller,controllerScript,{waitMs:RELEASE_OBSERVE_MS,force:false}),finishProcess(supervisor,supervisorScript,{waitMs:RELEASE_OBSERVE_MS,force:false}),...(voice?[finishProcess(voiceIdentity,voiceScript,{waitMs:35000})]:[])]);
    results.push({service:'devices',ok:true,message:'旧控制会话已结束。'});
    const health=await request('http://127.0.0.1:18782/health');
    const instance=await read(path.join(state,'panel-instance.json'));
    const panelScript=path.join(root,'scripts/start-panel.mjs');
    const panel=await processIdentity(health?.pid??instance?.pid,panelScript);
    if(panel.matches===null)throw Error('无法核对网页进程，请检查本机权限。');
    await checkpoint();if(panel.matches===true)await terminateOwned(panel,panelScript);
    else if(health)throw Error('18782 上的服务无法核实为本插件，请检查端口占用。');
    await status('starting','正在重新打开后台。');
    const guardChild=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',guardScript,'-NodePath',resolveNodeExecutable({root})],{windowsHide:true,stdio:'ignore'});
    guardChild.on('error',()=>{});guardChild.unref();
    let fresh;
    for(let i=0;i<60;i++) {
      const h=await request('http://127.0.0.1:18782/health');
      if(h?.service==='dafeiyu-panel'&&h.ok&&h.instanceId&&h.instanceId!==health?.instanceId&&h.startedAt>=startedAt){fresh=h;break;}
      await pause(500);
    }
    if(!fresh)throw Error('后台启动超时，请查看 panel-error.log；诊断入口可以再次重试。');
    results.push({service:'panel',ok:true,message:'新的后台实例已启动。'});
    const currentIntent=await read(path.join(state,'runtime-intent.json'));
    if(wantSync&&currentIntent?.sync!==false&&readDeviceLink(sync).enabled) {
      await status('starting','后台已恢复，正在接入 M HUB 和设备。');
      const startup=new SyncStartup(),cancel=()=>startup.cancel();budget.signal.addEventListener('abort',cancel,{once:true});
      try{await checkpoint();await startup.request();await startup.pending;await checkpoint();}finally{budget.signal.removeEventListener('abort',cancel);}
      const outcome=await read(path.join(sync,'startup-status.json'));
      let ready=false;
      if(outcome?.phase==='started')for(let i=0;i<90;i++) {
        const current=await read(path.join(sync,'controller-health.json'));
        if(!readDeviceLink(sync).enabled)break;
        if(current?.at>=startedAt&&current.phase==='running'&&current.connection?.state==='ready'){ready=true;break;}
        await pause(500);
      }
      results.push({service:'devices',ok:ready,message:ready?'设备控制心跳已恢复。':outcome?.phase==='failed'?outcome.message:'设备仍在初始化，请查看设备状态。'});
    }
    if(wantVoice&&recoveryVoiceWanted(await read(path.join(state,'runtime-intent.json')),readDeviceLink(sync).enabled)) {
      await status('warming-voice','后台已恢复，语音正在单独准备。');
      const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(sync,'voice-chat/Start.ps1'),'-Automatic'],{windowsHide:true,stdio:'ignore'});
      child.on('error',()=>{});child.unref();
      let voiceResult=null;
      for(let i=0;i<60;i++) {
        const value=await request('http://127.0.0.1:18780/status');
        if(!recoveryVoiceWanted(await read(path.join(state,'runtime-intent.json')),readDeviceLink(sync).enabled))break;
        voiceResult=recoveryVoiceResult(value);
        if(voiceResult)break;
        await pause(1000);
      }
      results.push({service:'voice',...(voiceResult??{ok:false,message:'后台已恢复，语音仍在准备或需要修复。'})});
    }
    const [native,bridgeHeartbeat]=await Promise.all([
      read(path.join(state,'companion/native-host-status.json')),
      read(path.join(state,'companion/harness-host.json'))
    ]);
    const harness=recoveryHarnessResult(native,bridgeHeartbeat,fresh.version);
    if(harness)results.push(harness);
    await status(results.some(x=>!x.ok)?'partial':'completed',results.some(x=>!x.ok)?'后台已恢复，部分服务需要处理，请查看详情。':'插件重启完成。');
  } catch(error) {
    if((await read(lock))?.ticketId!==ticketId)return;
    await status('failed',error.message);
    // A failed/cancelled device transaction may still restore its management
    // shell, but a superseded ticket must never start another worker.
    if((await read(lock))?.ticketId===ticketId){
      const shell=await startHostBackend({root,stateDir:state});const outcome=await shell.ready;
      if(outcome.phase==='failed')await status('failed',error.message+'；'+outcome.error);
    }
  } finally {
    clearInterval(heartbeat);budget.close();await statusTail.catch(()=>{});if(activeBudget===budget)activeBudget=null;
    if((await read(lock))?.ticketId===ticketId)await fs.unlink(lock).catch(()=>{});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const at=process.argv.indexOf('--ticket');
 if(at>=0)await recover(process.argv[at+1]);
 else {
   const result=await new PluginRecovery({root}).request();
   console.log(JSON.stringify(result));
 }
}
