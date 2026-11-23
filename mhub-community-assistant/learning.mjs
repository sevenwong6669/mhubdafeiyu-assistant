import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {learnCommunity} from './scripts/learn-community.mjs';
import {learningError} from './learning-errors.mjs';
import {writeJson} from '../harness-mhub-sync/resilience.mjs';

const HOUR=3600000,LEASE=15000;
const revision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(error){if(error.code==='ENOENT')return null;throw Error('学习计划记录无法读取，原文件已保留。');}};
const isOwner=value=>typeof value==='string'&&/^[a-f\d-]{36}$/.test(value);
const timestamp=value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0;
const date=value=>value===null||typeof value==='string'&&Number.isFinite(Date.parse(value));
function validateRuntime(value){
 if(value.version!==1||!date(value.lastAttempt)||!date(value.lastSuccess)||!timestamp(value.nextRunAt)||!timestamp(value.nextRetryAt)||!Number.isInteger(value.failures)||value.failures<0||value.job&&(!isOwner(value.job.id)||!['running','completed','partial','failed','cancelled'].includes(value.job.status)))throw Error('学习状态记录格式损坏，原文件已保留。');
 return value;
}
export function validateLearningSettings(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['enabled','intervalHours'].includes(k))||typeof value.enabled!=='boolean'||!Number.isInteger(value.intervalHours)||value.intervalHours<1||value.intervalHours>24)throw Error('学习频率须为 1～24 小时的整数，并明确选择是否启用。');
 return {version:1,enabled:value.enabled,intervalHours:value.intervalHours};
}

// Only the process that owns the existing 18782 listener constructs this
// coordinator. Native pages, the host timer and the CLI all use that listener.
export class LearningCoordinator{
 constructor({stateDir,learn=learnCommunity,now=Date.now,onComplete=()=>{}}){
  this.dir=path.resolve(stateDir);this.learn=learn;this.now=now;this.onComplete=onComplete;this.host=null;this.pending=null;this.tail=Promise.resolve();this.closed=false;this.leaseTimer=null;
  this.configFile=path.join(this.dir,'learning-settings.json');this.stateFile=path.join(this.dir,'learning-state.json');
  this.config={version:1,enabled:true,intervalHours:4};this.runtime={version:1,lastAttempt:null,lastSuccess:null,nextRunAt:null,nextRetryAt:null,failures:0,lastError:null,job:null};
  try{
   const config=read(this.configFile);if(config){if(config.version!==1)throw Error('学习计划版本不支持，原文件已保留。');this.config=validateLearningSettings({enabled:config.enabled,intervalHours:config.intervalHours});}
   const saved=read(this.stateFile);
   if(saved)this.runtime={...this.runtime,...validateRuntime(saved)};
   else{
    const last=read(path.join(this.dir,'learning-last-run.json'));
    if(last){this.runtime.lastAttempt=last.fetchedAt;if(last.requests>0&&!last.noDeviceScope&&!(last.results??[]).some(r=>!r.ok))this.runtime.lastSuccess=last.completedAt??last.fetchedAt;}
   }
   if(this.runtime.job?.status==='running'){
    this.runtime.job={...this.runtime.job,status:'cancelled',stage:'interrupted',error:'上次后台退出，未重复提交那一轮操作。',completedAt:new Date(now()).toISOString()};
    this.runtime.lastError={code:'interrupted',message:this.runtime.job.error};this.runtime.nextRetryAt=now()+5000;
   }
   if(!this.runtime.nextRunAt)this.runtime.nextRunAt=this.baseTime()+this.config.intervalHours*HOUR;
  }catch(error){this.configurationError=error.message;}
  this.lastObservedAt=this.now();
 }
 baseTime(){const time=Date.parse(this.runtime.lastAttempt??'');return Number.isFinite(time)?time:this.now()-this.config.intervalHours*HOUR;}
 get job(){return this.runtime.job;}
 expireHost(){
  if(this.host&&this.host.expiresAt<=this.now()){
   const owner=this.host.owner;this.host=null;
   if(this.job?.status==='running'&&this.job.owner===owner)this.controller?.abort(new DOMException('Harness 插件已卸载或失联，整理已取消。','AbortError'));
  }
 }
 state(){
  this.expireHost();const enabled=this.config.enabled,hostRunning=!!this.host;
  return {available:!this.configurationError,enabled,active:enabled&&hostRunning,intervalHours:this.config.intervalHours,label:`每 ${this.config.intervalHours} 小时`,requiresCodex:false,hostRunning,hostVersion:this.host?.version??null,hostLeaseUntil:this.host?.expiresAt??null,revision:revision(this.config),lastAttempt:this.runtime.lastAttempt,lastSuccess:this.runtime.lastSuccess,nextRunAt:enabled?Math.max(this.runtime.nextRunAt??this.now(),this.runtime.nextRetryAt??0):null,nextRetryAt:this.runtime.nextRetryAt,lastError:this.runtime.lastError,failures:this.runtime.failures,status:this.configurationError?'blocked':this.job?.status==='running'?'running':!enabled?'disabled':!hostRunning?'waiting-for-harness':this.runtime.nextRetryAt>this.now()?'retrying':'scheduled',error:this.configurationError??null,job:this.job};
 }
 persist(){
  if(this.configurationError)return Promise.reject(Error(this.configurationError));
  const snapshot=structuredClone(this.runtime);
  this.tail=this.tail.catch(()=>{}).then(()=>writeJson(pathToFileURL(this.stateFile),snapshot));return this.tail;
 }
 configure(input){
  // Keep the revision check and commit in one queue across all panel clients.
  const pending=(this.configTail??Promise.resolve()).catch(()=>{}).then(()=>this.commitConfiguration(input));
  this.configTail=pending;return pending;
 }
 async commitConfiguration({revision:expected,values}){
  if(this.configurationError)throw Error(this.configurationError);
  if(expected!==revision(this.config))throw Error('学习设置已被另一个页面更新，请刷新后再保存。');
  const next=validateLearningSettings(values);
  await writeJson(pathToFileURL(this.configFile),next);this.config=next;
  this.runtime.nextRunAt=this.baseTime()+next.intervalHours*HOUR;
  if(!next.enabled&&this.job?.status==='running'&&this.job.origin==='automatic')this.controller.abort(new DOMException('自动学习已停用。','AbortError'));
  await this.persist();return this.state();
 }
 async tick(owner,version){
  if(!isOwner(owner)||typeof version!=='string'||version.length>30)throw Error('插件调度标识无效。');
  if(this.closed)throw Error('学习协调服务正在退出。');
  this.expireHost();
  if(this.now()<this.lastObservedAt-60000){this.runtime.nextRunAt=Math.min(this.runtime.nextRunAt??Infinity,this.now()+this.config.intervalHours*HOUR);if(this.runtime.nextRetryAt)this.runtime.nextRetryAt=Math.min(this.runtime.nextRetryAt,this.now()+300000);await this.persist();}
  this.lastObservedAt=this.now();
  if(this.host&&this.host.owner!==owner)return {...this.state(),ownsLease:false};
  this.host={owner,version,expiresAt:this.now()+LEASE};
  if(this.configurationError)return {...this.state(),ownsLease:true};
  if(this.config.enabled&&this.now()>=Math.max(this.runtime.nextRunAt??0,this.runtime.nextRetryAt??0)&&this.job?.status!=='running')this.run('automatic',owner);
  return {...this.state(),ownsLease:true};
 }
 release(owner){
  if(this.host?.owner!==owner)return {released:false};this.host=null;
  if(this.job?.status==='running'&&this.job.owner===owner)this.controller.abort(new DOMException('Harness 插件已卸载，整理已取消。','AbortError'));
  return {released:true};
 }
 run(origin='manual',owner=null){
  if(this.closed)throw Error('学习协调服务正在退出。');
  if(this.configurationError)throw Error(this.configurationError);
  if(this.job?.status==='running')return this.job;
  if(owner&&this.host?.owner!==owner)throw Error('插件调度租约已失效，请等待重新连接。');
  const id=randomUUID(),startedAt=new Date(this.now()).toISOString();
  this.runtime.lastAttempt=startedAt;this.runtime.nextRunAt=this.now()+this.config.intervalHours*HOUR;
  this.runtime.job={id,status:'running',stage:'queued',origin,owner,startedAt,requests:0,hardwareWrites:0,outboundMessages:0};
  const job=this.runtime.job;this.controller=new AbortController();const signal=this.controller.signal;
  const assertOwner=()=>{signal.throwIfAborted();if(this.runtime.job?.id!==id||owner&&(this.host?.owner!==owner||this.host.expiresAt<=this.now()))throw new DOMException('整理任务已失去所有权。','AbortError');};
  this.leaseTimer=setInterval(()=>this.expireHost(),1000);this.leaseTimer.unref?.();
  this.pending=(async()=>{
   try{
    await this.persist();assertOwner();
    const result=await this.learn({stateDir:this.dir,signal,now:this.now,assertOwner,onProgress:progress=>{assertOwner();Object.assign(job,progress);void this.persist().catch(error=>{this.persistenceError=error.message;});}});
    assertOwner();const partial=!!(result.failed||result.noDeviceScope);
    Object.assign(job,{status:partial?'partial':'completed',stage:partial?'partial':'completed',completedAt:new Date(this.now()).toISOString(),requests:result.requests??0,added:result.added??0,changed:result.changed??0,total:result.totalStored??0,failed:result.failed??0,usedHistoricalDevices:!!result.inventory?.stale,inventoryAt:result.inventory?.fetchedAt??null,coverage:result.coverage??null});
    if(partial){const failure=result.noDeviceScope?{code:'device_unavailable',message:'没有可用的已知设备范围，未向社区发起请求。'}:{code:result.results?.find(r=>!r.ok)?.errorKind??'network',message:result.results?.find(r=>!r.ok)?.error??'部分社区请求失败。'};this.fail(failure);job.error=failure.message;job.errorKind=failure.code;}
    else{this.runtime.lastSuccess=job.completedAt;this.runtime.failures=0;this.runtime.lastError=null;this.runtime.nextRetryAt=null;}
   }catch(error){const failure=learningError(error);Object.assign(job,{status:failure.code==='cancelled'?'cancelled':'failed',stage:failure.code,error:failure.message,errorKind:failure.code,completedAt:new Date(this.now()).toISOString()});this.fail(failure);if(failure.code==='cancelled'&&origin==='automatic')this.runtime.nextRunAt=this.now();}
   finally{clearInterval(this.leaseTimer);this.leaseTimer=null;await this.persist().catch(error=>{this.persistenceError=error.message;});this.onComplete(job);}
   return job;
  })();
  return job;
 }
 fail(failure){this.runtime.failures++;this.runtime.lastError=failure;this.runtime.nextRetryAt=this.now()+Math.min(HOUR,300000*2**Math.min(this.runtime.failures-1,4));}
 async dispose(){this.closed=true;this.host=null;clearInterval(this.leaseTimer);this.controller?.abort(new DOMException('学习服务正在退出。','AbortError'));await this.pending?.catch(()=>{});await this.tail.catch(()=>{});}
}
