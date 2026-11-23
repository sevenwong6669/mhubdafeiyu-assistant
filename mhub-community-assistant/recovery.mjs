import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {processIdentity,terminateOwned} from './process-identity.mjs';
import {atomicJson} from './companion/config.mjs';

export const RECOVERY_TOTAL_MS=10*60*1000;
export const RECOVERY_HEARTBEAT_MS=3000;
export function recoveryTiming(owner,record,now=Date.now()){
 const startedAt=Number.isFinite(owner?.at)?owner.at:now;
 const deadlineAt=Math.min(Number.isFinite(owner?.deadlineAt)?owner.deadlineAt:Infinity,startedAt+RECOVERY_TOTAL_MS);
 const observed=record?.ticketId===owner?.ticketId?(record.heartbeatAt??record.at):null;
 const heartbeatAt=Number.isFinite(observed)&&observed<=now+1000?observed:startedAt;
 return {deadlineAt,heartbeatAt,stalled:now>=deadlineAt||now-heartbeatAt>45000};
}
export class RecoveryBudget{
 constructor({deadlineAt,clock=Date.now,cancelled=async()=>false,schedule=setTimeout,clear=clearTimeout}){
  Object.assign(this,{deadlineAt,clock,cancelled,clear});this.abort=new AbortController();this.signal=this.abort.signal;
  this.timer=schedule(()=>this.abort.abort(Error('本次恢复已超时，请重新检查恢复任务。')),Math.max(0,deadlineAt-clock()));this.timer?.unref?.();
 }
 async check(){if(this.clock()>=this.deadlineAt)this.abort.abort(Error('本次恢复已超时，请重新检查恢复任务。'));if(await this.cancelled())this.abort.abort(Error('本次恢复已取消，未继续执行后续操作。'));this.signal.throwIfAborted();}
 close(){this.clear(this.timer);}
}

export async function cancelStalledRecovery({root,owner,identity=processIdentity,terminate=terminateOwned,clock=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),graceMs=3000}){
 const directory=path.join(root,'state'),lock=path.join(directory,'recovery.lock'),script=path.join(root,'scripts/recover-plugin.mjs');
 const current=()=>{try{return JSON.parse(readLock(lock));}catch{return null;}};
 const owns=()=>{const x=current();return x?.ticketId===owner.ticketId&&x.pid===owner.pid;};
 if(!owns())return {stopped:false};
 const known=await identity(owner.pid,script,{expectedTicket:owner.ticketId});
 if(known.matches!==true||!Number.isFinite(known.startedAt))return {stopped:false,message:'无法核对旧恢复任务身份，已保留该任务；可以重新检查。'};
 atomicJson(path.join(directory,'recovery-cancel.json'),{ticketId:owner.ticketId,pid:owner.pid,startedAt:known.startedAt,at:clock()});
 const ended=async()=>{const x=await identity(owner.pid,script,{expectedTicket:owner.ticketId});return x.matches===false||x.matches===true&&x.startedAt!==known.startedAt;};
 const until=clock()+graceMs;while(clock()<until){if(await ended())break;await wait(100);}
 if(!await ended()){
  const fresh=await identity(owner.pid,script,{expectedTicket:owner.ticketId});if(!owns()||fresh.matches!==true||fresh.startedAt!==known.startedAt)return {stopped:false};
  atomicJson(path.join(directory,'recovery-interrupted.json'),{ticketId:owner.ticketId,pid:owner.pid,at:clock(),reason:'stalled-worker',unfinished:readRecovery(directory)});
  await terminate(fresh,script);
  const stopDeadline=clock()+graceMs;while(!await ended()&&clock()<stopDeadline)await wait(100);
  if(!await ended())return {stopped:false,message:'旧恢复任务尚未退出，未启动新任务；请稍后重新检查。'};
 }
 if(owns())try{fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
 const record=readRecovery(directory);if(record?.ticketId===owner.ticketId&&!['completed','failed','partial'].includes(record.phase))atomicJson(path.join(directory,'recovery-status.json'),{...record,phase:'failed',at:clock(),message:'旧恢复任务无进展，已停止；可以重新恢复。'});
 return {stopped:true};
}

export function recoveryVoiceResult(value){
  if(!value?.ready||!value.streamReady)return null;
  if(value.nativeReady===true)return {ok:true,message:'语音组件和输入通道已就绪。'};
  const error=value.nativeError||value.error;
  return error?{ok:false,message:'语音模型已加载，输入设备仍未就绪：'+String(error).slice(0,300)}:null;
}

export function readRecovery(directory) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(directory,'recovery-status.json'),'utf8'));
    if (!record || typeof record.ticketId !== 'string') return null;
    return record;
  } catch { return null; }
}

function readLock(file){try{return fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}

// The lock owner, rather than an old progress message, determines whether a
// recovery is still executing. Unknown identities remain protected.
export async function recoveryLockState(root,{identity=processIdentity,now=Date.now(),raw}={}) {
  const file=path.join(root,'state/recovery.lock');
  if(raw===undefined){try{raw=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return {active:false,canRetry:true,ownerAlive:false,reason:'no-worker'};throw error;}}
  let owner;
  try{owner=JSON.parse(raw);}catch{
    let modifiedAt;
    try{modifiedAt=fs.statSync(file).mtimeMs;}catch(error){if(error.code==='ENOENT')return {active:false,canRetry:true,ownerAlive:false,reason:'no-worker'};throw error;}
    const deadlineAt=modifiedAt+30000;
    return {active:now<deadlineAt,canRetry:now>=deadlineAt,ownerAlive:null,reason:'invalid-reservation',deadlineAt};
  }
  const age=now-owner?.at;
  const reserved=Number.isFinite(age)&&age>=0&&age<5000;
  const script=path.join(root,owner?.worker?'scripts/recover-plugin.mjs':'scripts/start-panel.mjs');
  const info=await identity(owner?.pid,script,owner?.worker?{expectedTicket:owner.ticketId}:{});
  const same=owner?.worker===true&&info.matches!==false&&(!owner.startedAt||info.startedAt===undefined||Math.abs(info.startedAt-owner.startedAt)<2000);
  const active=same||reserved,timing=recoveryTiming(owner,readRecovery(path.join(root,'state')),now),stalled=same&&timing.stalled;
  return {active,canRetry:!active,canRecheck:stalled,stalled,ownerAlive:same?info.matches===true?true:null:false,ticketId:owner?.ticketId,reason:stalled?'worker-stalled':same?'worker-running':reserved?'launching':'worker-exited',...timing,...(reserved&&!same?{deadlineAt:owner.at+5000}:{}),...(stalled?{phase:'stalled',message:info.matches===true?'恢复任务长时间无进展，请点击重新检查，安全停止旧任务后重试。':'旧恢复任务身份暂时无法确认，请重新检查；未启动新任务。'}:{})};
}

function previousTickets(directory) {
  try {
    const records=JSON.parse(fs.readFileSync(path.join(directory,'recovery-history.json'),'utf8'));
    return Array.isArray(records)?records.filter(row=>row&&typeof row.ticketId==='string'&&Number.isFinite(row.at)).slice(0,30):[];
  } catch { return []; }
}

export function recentOperations(directory,accepted,current) {
  const byTicket=new Map();
  for(const row of [current,...previousTickets(directory)]){
    if(!row?.ticketId||!Number.isFinite(row.at)||!Number.isFinite(new Date(row.at).getTime())||byTicket.has(row.ticketId))continue;
    byTicket.set(row.ticketId,{
      at:new Date(row.at).toISOString(),action:'重启插件',ticketId:row.ticketId,
      phase:row.phase,ok:!['failed','partial'].includes(row.phase),message:row.message,
      durationMs:Number.isFinite(row.startedAt)&&['completed','partial','failed'].includes(row.phase)?Math.max(0,row.at-row.startedAt):null,
    });
  }
  const others=accepted.filter(row=>!row.ticketId||!byTicket.has(row.ticketId));
  return [...byTicket.values(),...others].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,30);
}

function archiveLastTicket(directory) {
  const last=readRecovery(directory);
  if(!last||!['completed','partial','failed'].includes(last.phase))return;
  const records=previousTickets(directory).filter(row=>row.ticketId!==last.ticketId);
  const file=path.join(directory,'recovery-history.json'),tmp=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify([last,...records].slice(0,30)));
  fs.renameSync(tmp,file);
}

export class PluginRecovery {
  constructor({root, launch, identity = processIdentity,cancelStalled=cancelStalledRecovery,launchBudgetMs=3000}) {
    this.root = root;
    this.directory = path.join(root,'state');
    this.identity = identity;
    this.cancelStalled=cancelStalled;
    this.launchBudgetMs=launchBudgetMs;
    this.launch = launch ?? ((ticketId) => {
      const child = spawn(process.execPath,[path.join(root,'scripts/recover-plugin.mjs'),'--ticket',ticketId],{
        cwd:root,windowsHide:true,detached:true,stdio:'ignore',
      });
      child.unref();
      return new Promise((resolve,reject) => {
        child.once('spawn',()=>resolve(child.pid));
        child.once('error',reject);
      });
    });
  }
  request() {
    if (this.pending) return this.pending;
    const task = this.reserve();
    this.pending = task;
    void task.finally(()=>{if(this.pending===task)this.pending=null;}).catch(()=>{});
    return task;
  }
  async status(){
    const record=readRecovery(this.directory);
    let raw;try{raw=fs.readFileSync(path.join(this.directory,'recovery.lock'),'utf8');}catch(error){if(error.code!=='ENOENT')return {...record,active:true,canRetry:false,ownerAlive:null,reason:'inspection-failed',phase:'checking',message:'无法核对恢复任务状态，请检查本机权限后重试。'};}
    const now=Date.now();
    if(!this.observation||this.observation.raw!==raw||now-this.observation.at>=2000){
      const observation={raw,at:now};
      observation.pending=recoveryLockState(this.root,{identity:this.identity,now,raw}).catch(()=>({active:true,canRetry:false,ownerAlive:null,reason:'inspection-failed',phase:'checking',message:'无法核对恢复任务状态，请检查本机权限后重试。'}));
      this.observation=observation;
    }
    const effective=await this.observation.pending;
    if(!record&&!effective.active)return null;
    const current=record?.ticketId===effective.ticketId||!effective.active?record:null;
    const interrupted=!effective.active&&['queued','checking','releasing','starting','warming-voice'].includes(current?.phase);
    return {...current,...effective,...(effective.stalled?{phase:'stalled',message:effective.message}:{}),...(effective.active&&!current?{phase:effective.phase??'queued',message:effective.message??'恢复任务正在执行，请稍候。'}:{}),...(interrupted?{phase:'failed',previousPhase:current.phase,message:'上次恢复任务已中断，可以重新恢复。'}:{})};
  }
  async reserve() {
    fs.mkdirSync(this.directory,{recursive:true});
    const lock = path.join(this.directory,'recovery.lock');
    const raw=readLock(lock);
    if (raw!==null) {
      let owner;
      try{owner=JSON.parse(raw);}catch{
        let modifiedAt;try{modifiedAt=fs.statSync(lock).mtimeMs;}catch(error){if(error.code==='ENOENT')return this.reserve();throw error;}
        if(Date.now()-modifiedAt<30000)return {pending:true,message:'正在等待恢复器建立任务，请稍候。'};
        if(readLock(lock)===raw)try{fs.renameSync(lock,lock+'.invalid-'+Date.now());}catch(error){if(error.code!=='ENOENT')throw error;}
        return this.reserve();
      }
      const effective=await recoveryLockState(this.root,{identity:this.identity,raw});
      if (effective.active) {
        if(effective.canRecheck&&effective.ownerAlive===true){
          const stopped=await this.cancelStalled({root:this.root,owner,identity:this.identity});
          if(stopped.stopped)return this.reserve();
          return {pending:true,ticketId:owner.ticketId,message:stopped.message??effective.message};
        }
        const status = readRecovery(this.directory);
        return {pending:true,ticketId:owner.ticketId,message:effective.message??status?.message ?? '恢复任务已受理，请等待当前任务。'};
      }
      // Verify the reservation has not changed while the identity probe ran.
      if (readLock(lock) !== raw) return this.reserve();
      try{fs.unlinkSync(lock);}catch(error){if(error.code!=='ENOENT')throw error;return this.reserve();}
    }
    const ticketId = randomUUID();
    const owner = {ticketId,pid:process.pid,at:Date.now(),deadlineAt:Date.now()+RECOVERY_TOTAL_MS,startedAt:Math.round(Date.now()-process.uptime()*1000),worker:false};
    let fd;
    try { fd=fs.openSync(lock,'wx'); }
    catch(error) { if(error.code==='EEXIST')return this.reserve(); throw error; }
    try{fs.writeFileSync(fd,JSON.stringify(owner));}finally{fs.closeSync(fd);}
    const status = {ticketId,phase:'queued',at:Date.now(),message:'恢复任务已受理，正在检查服务。'};
    try{archiveLastTicket(this.directory);}catch{/* A history write must not prevent recovery. */}
    fs.writeFileSync(path.join(this.directory,'recovery-status.json'),JSON.stringify(status));
    try {
      let timer;
      const pid = await Promise.race([this.launch(ticketId),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('恢复器启动等待超时，请重新检查。')),this.launchBudgetMs);})]).finally(()=>clearTimeout(timer));
      const raw=readLock(lock),latest=raw===null?null:JSON.parse(raw);
      // A fast worker may have completed and retired its reservation already.
      if (latest?.ticketId===ticketId && !latest.worker) atomicJson(lock,{...owner,pid,startedAt:null,worker:true});
      return {pending:true,ticketId,message:status.message};
    } catch(error) {
      const raw=readLock(lock),latest=raw===null?null:JSON.parse(raw);
      if(latest?.ticketId===ticketId&&latest.worker)return {pending:true,ticketId,message:'恢复执行器已认领任务，正在检查进度。'};
      if(latest?.ticketId===ticketId)fs.unlinkSync(lock);
      const current=readRecovery(this.directory);
      if(current?.ticketId===ticketId)fs.writeFileSync(path.join(this.directory,'recovery-status.json'),JSON.stringify({...status,phase:'failed',message:error.message==='恢复器启动等待超时，请重新检查。'?error.message:'恢复器启动失败，请从桌面诊断入口重试。'}));
      throw error;
    }
  }
}
