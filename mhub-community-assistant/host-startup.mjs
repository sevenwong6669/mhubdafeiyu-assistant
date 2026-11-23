import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './companion/config.mjs';

export function createHostStatusWriter({file,version,runtimeVersion,clock=Date.now}){
 const instanceId=randomUUID();let claimed=false,closed=false;
 return {instanceId,close(){closed=true;},record(stage,backend,error){
  if(closed)return false;
  let current;try{current=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  if(claimed&&current?.instanceId&&current.instanceId!==instanceId)return false;
  claimed=true;atomicJson(file,{instanceId,pid:process.pid,at:clock(),version,...(runtimeVersion?{runtimeVersion}:{}),stage,backend,...(error?{error:String(error.message).slice(0,250)}:{})});return true;
 }};
}

export function resolveNodeExecutable({root,env=process.env,execPath=process.execPath,exists=file=>{try{return fs.statSync(file).isFile();}catch{return false;}}}={}){
 let settings={};try{settings=JSON.parse(fs.readFileSync(path.resolve(root,'../runtime.settings.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('运行环境配置无法读取，请检查 runtime.settings.json。');}
 const configured=env.DAFEIYU_NODE_EXECUTABLE??settings.node;
 if(configured!==undefined){if(typeof configured!=='string'||!configured.trim()||!exists(configured))throw Error('配置的 Node.js 路径不存在，请修正运行环境设置。');return configured;}
 if(/^node(?:\.exe)?$/i.test(path.basename(execPath))&&exists(execPath))return execPath;
 for(const dir of String(env.PATH??env.Path??'').split(path.delimiter).filter(Boolean)){
  const file=path.join(dir.replace(/^"|"$/g,''),process.platform==='win32'?'node.exe':'node');if(exists(file))return file;
 }
 throw Error('找不到 Node.js，后台未启动。请安装 Node.js 或配置 DAFEIYU_NODE_EXECUTABLE。');
}
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
 signal?.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});
});
export async function startHostBackend({root,stateDir=path.join(root,'state'),spawnImpl=spawn,resolveNode=resolveNodeExecutable,onState=()=>{},signal,clock=Date.now,wait=pause,schedule=setTimeout,clear=clearTimeout,spawnTimeoutMs=3000,probe=async()=>{
 const r=await fetch('http://127.0.0.1:18782/health',{signal:AbortSignal.any([AbortSignal.timeout(1500),...(signal?[signal]:[])])});return r.ok?r.json():null;
},budgetMs=30000}={}){
 const startedAt=clock();let nodeExecutable,child,spawnError=null,evidenceWarning=null,latestState;
 const publish=value=>{latestState=value;onState({...value,...(evidenceWarning?{evidenceWarning}:{})});};
 try{
  signal?.throwIfAborted();nodeExecutable=resolveNode({root});
  publish({phase:'starting',startedAt,nodeExecutable,deadlineAt:startedAt+budgetMs});
  child=spawnImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/watch-panel.ps1'),'-NodePath',nodeExecutable],{windowsHide:true,stdio:'ignore'});
  child.on('error',error=>{spawnError=error;});child.once('exit',code=>{if(code!==0&&code!==null)spawnError=Error('后台守护提前退出，请查看 panel-error.log。');});
  await new Promise((resolve,reject)=>{
   const cleanup=()=>{clear(timer);signal?.removeEventListener('abort',abort);child.off('spawn',started);child.off('error',failed);};
   const started=()=>{cleanup();resolve();},failed=error=>{cleanup();reject(error);},abort=()=>failed(signal.reason);
   const timer=schedule(()=>failed(Error('Windows 启动后台无回应，请重新检查。')),spawnTimeoutMs);
   child.once('spawn',started);child.once('error',failed);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });child.unref();
 }catch(error){const state={phase:signal?.aborted?'cancelled':'failed',startedAt,error:String(error.message).slice(0,240)};publish(state);return {accepted:false,ready:Promise.resolve(state)};}
 const ready=(async()=>{
  try{
   while(clock()-startedAt<budgetMs){
    signal?.throwIfAborted();if(spawnError)throw spawnError;let value;try{value=await probe();}catch{signal?.throwIfAborted();}signal?.throwIfAborted();
    if(value?.service==='dafeiyu-panel'&&value.ok===true){const state={phase:'ready',startedAt,at:clock(),nodeExecutable,guardPid:child.pid,panelPid:value.pid};publish(state);return state;}
    await wait(1000,signal);
   }
   throw Error('后台启动超时，请查看 panel-error.log，再重新检查启动。');
  }catch(error){const state={phase:signal?.aborted?'cancelled':'failed',startedAt,at:clock(),nodeExecutable,error:String(error.message).slice(0,240)};publish(state);return state;}
 })();
 // This is an optional, armed, read-only collector; failure must be reported
 // separately without taking down an otherwise working backend.
 if(fs.existsSync(path.join(stateDir,'boot-verification-request.json'))){
  const failed=()=>{evidenceWarning='启动验收记录器未运行；后台连接状态将单独检查。';publish(latestState);};
  try{const check=spawnImpl(nodeExecutable,[path.join(root,'scripts/verify-after-boot.mjs')],{windowsHide:true,stdio:'ignore'});check.on('error',failed);check.unref();}catch{failed();}
 }
 return {accepted:true,ready};
}
