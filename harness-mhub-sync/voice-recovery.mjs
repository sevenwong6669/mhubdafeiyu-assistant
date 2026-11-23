// Reuse voice startup; preserve explicit stops and unknown port/process owners.
export class VoiceRecovery {
 constructor({wanted,probe,owner,identity,launch,restart,clock=Date.now,prepareBudgetMs=300000,missingBudgetMs=45000}){
  Object.assign(this,{wanted,probe,owner,identity,launch,restart,clock,prepareBudgetMs,missingBudgetMs});
  this.nextAt=0;this.failures=0;this.pending=null;this.state={phase:'checking'};
  this.observation=null;this.recoveryCount=0;this.versionAttempts=new Map();
 }
 tick(){
  if(this.pending)return this.pending;
  const task=this.check().catch(error=>{this.nextAt=this.clock()+30000;this.state={phase:'failed',error:error.message,at:this.clock()};}).finally(()=>{if(this.pending===task)this.pending=null;});
  this.pending=task;return task;
 }
 async check(){
  if(!await this.wanted()){this.failures=0;this.nextAt=0;this.observation=null;this.recoveryCount=0;this.versionAttempts.clear();this.state={phase:'stopped',at:this.clock()};return;}
  if(this.clock()<this.nextAt)return;
  this.nextAt=this.clock()+5000;
  const status=await this.probe();
  const observationKey=String(status.pid??'')+':'+status.phase;
  if(this.observation?.key!==observationKey)this.observation={key:observationKey,since:this.clock(),progress:status.progress};
  else if(status.progress!==undefined&&status.progress!==this.observation.progress){this.observation.since=this.clock();this.observation.progress=status.progress;}
  if(status.phase!=='missing'&&status.phase!=='occupied'&&/^[a-f0-9]{16}$/.test(status.expectedVersion??'')){
   if(!/^[a-f0-9]{16}$/.test(status.version??'')){
    this.state={...status,phase:'update-unverified',at:this.clock(),error:'语音服务未报告运行版本，已保留该进程，请通过重启插件更新。'};return;
   }
   if(status.version!==status.expectedVersion&&!(status.phase==='preparing'&&this.clock()-this.observation.since>=this.prepareBudgetMs)){await this.handoffVersion(status);return;}
   this.versionAttempts.delete(status.expectedVersion);
  }
  if(status.phase==='preparing'&&this.clock()-this.observation.since>=this.prepareBudgetMs){
   this.state={...status,phase:'stalled',at:this.clock(),error:'语音准备长时间无进展，正在核对安全恢复条件。'};
   if(status.busy!==false||!status.pid||!this.restart||this.recoveryCount>=3)return;
   const existing=await this.identity(status.pid);
   if(existing.matches!==true||!Number.isFinite(existing.startedAt)){this.state.error='无法核对语音进程身份，已保留该进程。';return;}
   const latest=await this.probe();
   if(latest.pid!==status.pid||latest.phase!=='preparing'||latest.busy!==false||!await this.wanted())return;
   this.recoveryCount++;this.nextAt=this.clock()+Math.min(120000,30000*2**(this.recoveryCount-1));
   this.state={phase:'recovering',pid:status.pid,at:this.clock(),attempt:this.recoveryCount,nextRetryAt:this.nextAt};
   await this.restart(existing);this.observation=null;return;
  }
  if(status.phase!=='missing'){
   this.failures=0;if(status.phase==='running')this.recoveryCount=0;this.state={...status,at:this.clock()};return;
  }
  if(++this.failures<2){this.state={phase:'checking',at:this.clock()};return;}
  const pid=await this.owner();
  if(pid){
   const existing=await this.identity(pid);
   if(existing.matches!==false){const stalled=this.clock()-this.observation.since>=this.missingBudgetMs;this.state={phase:stalled?'stalled':'waiting-process',pid,error:stalled?'语音进程仍存活但状态接口持续失联，无法确认通话状态，请使用重启插件检查。':'语音端口未就绪，已保留原进程，避免重复加载。',at:this.clock()};return;}
  }
  if(!await this.wanted()){this.state={phase:'stopped',at:this.clock()};return;}
  this.nextAt=this.clock()+Math.min(120000,30000*2**Math.min(2,this.failures-2));
  this.state={phase:'starting',at:this.clock(),nextRetryAt:this.nextAt};
  await this.launch();
 }
 async handoffVersion(status){
  const attempts=this.versionAttempts.get(status.expectedVersion)??0;
  this.state={...status,phase:'update-pending',at:this.clock(),attempt:attempts,error:'语音正在使用或准备中，空闲后自动加载新版本。'};
  if(status.busy!==false||status.phase==='preparing'||!this.restart)return;
  if(attempts>=3){this.state={...this.state,phase:'update-failed',error:'语音版本交接已达重试上限，请通过重启插件检查。'};return;}
  const existing=await this.identity(status.pid);
  // The service timestamp can be later than OS creation after slow imports;
  // compare each clock to its own second observation, not to one another.
  if(existing.matches!==true||!Number.isFinite(existing.startedAt)||!Number.isFinite(status.startedAt)){this.state.error='无法核对旧语音进程和启动时间，已保留该进程。';return;}
  const latest=await this.probe();
  if(latest.pid!==status.pid||latest.startedAt!==status.startedAt||latest.version!==status.version||latest.expectedVersion!==status.expectedVersion||latest.busy!==false||latest.phase==='preparing')return;
  const verified=await this.identity(status.pid);
  if(verified.matches!==true||verified.startedAt!==existing.startedAt||!await this.wanted())return;
  this.versionAttempts.set(status.expectedVersion,attempts+1);
  while(this.versionAttempts.size>4)this.versionAttempts.delete(this.versionAttempts.keys().next().value);
  this.nextAt=this.clock()+Math.min(120000,30000*2**attempts);
  this.state={...status,phase:'updating',at:this.clock(),attempt:attempts+1,nextRetryAt:this.nextAt};
  await this.restart(existing);this.observation=null;
 }
}
