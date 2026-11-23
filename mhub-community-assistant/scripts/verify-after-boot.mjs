// One-shot read-only evidence collector. It never starts or stops any service.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {atomicJson} from '../companion/config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),state=path.join(root,'state');
export function differentBoot(request,now=Date.now(),uptime=os.uptime()){
 return Number.isFinite(request?.bootEpoch)&&Math.abs(now-uptime*1000-request.bootEpoch)>120000;
}
export function bootSample(c,since,now=Date.now()){
 const balanceFresh=Number.isFinite(c?.balance?.updatedAt)&&c.balance.updatedAt>=since&&c.balance.updatedAt<=now+1000;
 const error=c?.voice?.error??c?.sync?.connection?.error??c?.sync?.screen?.error??(c?.sync?.startup?.phase==='failed'?c.sync.startup.message:null)??c?.balance?.error??null;
 return {at:now,hostOnline:c?.live2d?.task?.hostOnline===true,driver:c?.sync?.ready===true,screen:c?.sync?.screen?.ready===true,captions:c?.sync?.screen?.captionsReady===true,balance:c?.balance?.visible===true&&balanceFresh,balanceFresh,balanceOld:c?.balance?.view?.stale===true,balanceReadback:balanceFresh?c?.balance?.diagnostics?.paletteReadback:null,voice:c?.voice?.ready===true,input:c?.voice?.nativeReady===true,recognition:c?.voice?.streamReady===true,error};
}
export function bootVersions(expected,records,bootEpoch,{hostProductVersion}={}){
 const keys=['panel','voice','controller','supervisor','host'];
 const versions=Object.fromEntries(keys.map(k=>[k,records[k]?.version??null]));
 const fresh=keys.every(k=>Number.isFinite(records[k]?.startedAt??records[k]?.at)&&(records[k].startedAt??records[k].at)>=bootEpoch);
 // The native host publishes a product version (PANEL_VERSION), not the
 // runtime hash used by the standalone workers. Never compare unlike fields.
 const hostMatch=typeof records.host?.runtimeVersion==='string'?records.host.runtimeVersion===expected:
  typeof hostProductVersion==='string'&&records.host?.version===hostProductVersion;
 return {versions,hostProductVersion:hostProductVersion??null,hostRuntimeFingerprintAvailable:typeof records.host?.runtimeVersion==='string',
  versionsMatch:typeof expected==='string'&&keys.filter(k=>k!=='host').every(k=>versions[k]===expected)&&hostMatch&&fresh};
}
export async function verifyAfterBoot(){
 const file=path.join(state,'boot-verification-request.json');let request;
 try{request=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return;}
 if(!/^[a-f0-9-]{36}$/.test(request.id??'')||request.kind!=='next-boot'||!differentBoot(request))return;
 try{fs.renameSync(file,path.join(state,'boot-verification-running-'+request.id+'.json'));}catch{return;}
 const started=Date.now(),samples=[];let ready=false;
 while(Date.now()-started<180000){
  try{
   const r=await fetch('http://127.0.0.1:18782/api/mhub-community/state',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('HTTP '+r.status);const s=await r.json(),c=s.controls;
   const sample=bootSample(c,started);
   if(request.expectedVersion){
    const json=async url=>{try{return await fetch(url,{signal:AbortSignal.timeout(2000)}).then(r=>r.ok?r.json():null);}catch{return null;}};
    const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
    const [panel,voice]=await Promise.all([json('http://127.0.0.1:18782/health'),json('http://127.0.0.1:18780/status')]);
    Object.assign(sample,bootVersions(request.expectedVersion,{panel,voice,controller:read(path.resolve(root,'../harness-mhub-sync/controller-health.json')),supervisor:read(path.resolve(root,'../harness-mhub-sync/supervisor-status.json')),host:read(path.join(state,'companion/native-host-status.json'))},Date.now()-os.uptime()*1000,{hostProductVersion:request.expectedHostProductVersion??read(path.join(root,'package.json'))?.version}));
   }
   samples.push(sample);ready=(!request.expectedVersion||sample.versionsMatch)&&sample.hostOnline&&sample.driver&&sample.screen&&sample.captions&&sample.balance&&sample.balanceReadback==='verified'&&sample.voice&&sample.input&&sample.recognition;if(ready)break;
  }catch(e){samples.push({at:Date.now(),error:e.message});}
  await new Promise(r=>setTimeout(r,2000));
 }
 atomicJson(path.join(state,'boot-verification-result.json'),{id:request.id,scope:'status-only',startedAt:started,finishedAt:Date.now(),differentBoot:true,phase:ready?'ready':'partial',elapsedMs:Date.now()-started,samples});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await verifyAfterBoot();
