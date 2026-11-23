// Optional host adapter. No dsh-dafeiyu, AuraBot or fish-buddy imports.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './config.mjs';

export class TaskFeed{
 constructor(file,{clock=Date.now}={}){this.file=file;this.clock=clock;this.turns=new Map();this.sequence=0;this.excluded=new Set();this.published=null;}
 event(session,event){const id=session?.id;if(typeof id!=='string'||this.excluded.has(id))return;const now=this.clock(),type=event?.type,data=event?.data;
  if(type==='turn/start')this.turns.set(id,{sessionId:id,direct:false,state:'THINKING',at:now});
  const t=this.turns.get(id);if(!t)return;
  if(type==='user/message'){const source=(data?.source??data?.message?.source);if(source?.kind==='user')t.direct=true;}
  if(type==='tool/call'||type==='tool/start'||type==='tool/execute')t.state='WORKING';
  if(type==='approval/request')t.state='WAITING';
  if(type==='turn/end'){const reason=data?.reason?.kind??'completed';t.state=reason==='completed'?'SUCCESS':reason==='aborted'?'IDLE':reason==='blocked'?'WAITING':'ERROR';t.finished=true;t.until=now+5000;}
  if(this.turns.size>64)this.turns.delete(this.turns.keys().next().value);this.publish();
 }
 publish(){
  const now=this.clock();
  for(const [id,t] of this.turns)if(t.finished&&t.until<now)this.turns.delete(id);
  const active=[...this.turns.values()].filter(t=>t.direct),t=active.find(t=>!t.finished&&t.state==='WAITING')??active.find(t=>!t.finished)??active.at(-1);
  const state=t?.state??'IDLE',sessionId=t?.sessionId??null,previous=this.published;
  if(previous?.state===state&&previous.sessionId===sessionId&&now>=previous.timestamp&&now-previous.timestamp<5000)return previous;
  const value={source:'mhub-internal',directInput:true,kind:'state',state,sessionId,timestamp:now,sequence:++this.sequence,hostOnline:true};
  atomicJson(this.file,value);
  this.published=value;
  return value;
 }
}
export function attachHarnessCompanion(ctx,stateDir){
 const dir=path.join(stateDir,'companion');
 const jobs=path.join(dir,'harness-jobs'),heartbeat=path.join(dir,'harness-host.json');
 const feed=new TaskFeed(path.join(dir,'task-source.json'));
 fs.mkdirSync(jobs,{recursive:true});
 const lifetime=new AbortController(),active=new Map(),running=new Map();
 const state={active,feed,sessions:new Map(),signal:lifetime.signal};
 const bridgeId=randomUUID();
 let lastHeartbeat=0,scanOffset=0;

 ctx.on('session/event',(session,event)=>{
  if(lifetime.signal.aborted)return;
  feed.event(session,event);
  const entry=active.get(session.id);
  if(entry&&event.type==='turn/end'){
   active.delete(session.id);
   entry.resolve((event.data?.reason?.kind??'completed')==='completed'?entry.text.trim():null);
  }
 });
 ctx.on('agent/assistant-stream',({agent,frame})=>{
  const entry=active.get(agent?.session?.id);
  if(!entry)return;
  const part=frame?.type==='chunk'?frame.chunk:frame;
  if(['text-delta','text_delta','text'].includes(part?.type)){
   const value=part.delta??part.text??part.content;
   if(typeof value==='string'&&entry.text.length<12000)entry.text+=value.slice(0,12000-entry.text.length);
  }
 });

 function receipt({file,out,job},result){
  if((!job||job.until>=Date.now())&&fs.existsSync(file)&&!fs.existsSync(out))atomicJson(out,result);
 }

 async function run(item){
  const {job}=item;
  try{
   const url=new URL('./harness-runtime.mjs',import.meta.url);
   url.searchParams.set('v',String(fs.statSync(url).mtimeMs));
   const {harnessJob}=await import(url.href);
   lifetime.signal.throwIfAborted();
   const value=await harnessJob(ctx,job,state);
   if(!lifetime.signal.aborted)receipt(item,{ok:true,value});
  }catch(error){
   if(!lifetime.signal.aborted)receipt(item,{ok:false,error:error.message});
  }finally{
   if(running.get(job.operation)===item)running.delete(job.operation);
  }
 }

 function tick(){
  if(lifetime.signal.aborted)return;
  const now=Date.now();
  if(now-lastHeartbeat>=3000||now<lastHeartbeat){
   atomicJson(heartbeat,{pid:process.pid,bridgeId,at:now,adapter:'mhub-companion-v1'});
   lastHeartbeat=now;
  }
  feed.publish();
  const names=fs.readdirSync(jobs,{withFileTypes:true})
   .filter(entry=>entry.isFile()&&/^[a-f0-9-]{36}\.json$/.test(entry.name)).map(entry=>entry.name);
  if(scanOffset>=names.length)scanOffset=0;
  // A completed or unreadable request can survive a client crash. Move the
  // scan window instead of letting its first 64 entries block later jobs.
  const batch=names.slice(scanOffset,scanOffset+64);
  scanOffset+=batch.length;
  const occupiedFiles=new Set([...running.values()].map(item=>item.file)),waiting=new Map();
  for(const name of batch){
   const file=path.join(jobs,name),out=file.replace(/\.json$/,'.result.json');
   if(occupiedFiles.has(file))continue;
   const item={file,out};
   try{
    const stat=fs.statSync(file);
    if(stat.size>3*1024*1024)throw Error('请求过大');
    if(fs.existsSync(out)&&now-stat.mtimeMs<90000)continue;
    const job=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Number.isFinite(job.until))throw Error('请求期限无效。');
    if(job.until<now){fs.rmSync(file,{force:true});fs.rmSync(out,{force:true});continue;}
    if(fs.existsSync(out))continue;
    if(!['chat','balance','balance-sources'].includes(job.operation))throw Error('未知的 Harness 内部操作。');
    if(job.id!==name.slice(0,-5))throw Error('请求标识无效。');
    if(job.bridgeId!==undefined&&job.bridgeId!==bridgeId)throw Error('Harness 接入已关闭，请重新发起请求。');
    if(!running.has(job.operation)){
     const queuedAt=Number.isFinite(job.createdAt)?job.createdAt:stat.mtimeMs;
     const next=waiting.get(job.operation);
     if(!next||queuedAt<next.queuedAt)waiting.set(job.operation,{...item,job,queuedAt});
    }
   }catch(error){
    try{receipt(item,{ok:false,error:error.message});}catch{}
   }
  }
  // Keep dialogue serialized. Independent, bounded slots for balance and
  // sources avoid making a short read wait for an entire assistant turn.
  for(const item of waiting.values()){
   const operation=item.job.operation;
   running.set(operation,item);
   void run(item).catch(()=>{});
  }
 }
 const poll=()=>{try{tick();}catch{}};
 const timer=setInterval(poll,1000);
 timer.unref();
 poll();
 const close=()=>{
  if(lifetime.signal.aborted)return;
  const error=Error('Harness 接入已关闭，请重新发起请求。');
  lifetime.abort(error);
  clearInterval(timer);
  for(const entry of active.values())entry.cancel(error);
  active.clear();
  for(const item of running.values()){
   try{receipt(item,{ok:false,error:error.message});}catch{}
  }
  running.clear();
  try{
   if(JSON.parse(fs.readFileSync(heartbeat,'utf8')).bridgeId===bridgeId)
    atomicJson(heartbeat,{pid:process.pid,bridgeId,at:0,stopped:true});
  }catch{}
 };
 ctx.effect(()=>close);
 return {feed,close};
}
