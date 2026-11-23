import {runtime} from '../../runtime-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {writeJson as atomicJson} from '../resilience.mjs';
const writeJson=(file,value)=>atomicJson(pathToFileURL(file),value);
import {DEFAULT_PHONE,validatePhone,phoneActive,PhoneSchedule} from './settings.mjs';
const root=fileURLToPath(new URL('./',import.meta.url)),voice=path.resolve(root,'../voice-chat');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export class PhoneService{
 constructor({ready,interrupt,onAudio,onGreeting,prepare,voiceState,connectExternal,muteExternal,afterEnd,engine='fish-buddy-v1.6.2-ear',clock=()=>new Date(),spawnProcess=spawn,folder=root,inputStableMs=30000}={}){
  Object.assign(this,{ready,interrupt,onAudio,onGreeting,prepare,voiceState,connectExternal,muteExternal,afterEnd,engine,clock,spawnProcess,folder,inputStableMs});this.settings={...DEFAULT_PHONE};this.state={phase:'idle',turn:'idle',muted:false,error:null};this.schedule=new PhoneSchedule({},clock);this.seen=new Set();this.commandTail=Promise.resolve();this.heartbeatAt=0;this.lastReload=0;this.capture=null;this.tone=null;this.panel=null;this.closed=false;
 }
 async init(){
  await fs.mkdir(path.join(this.folder,'inbox'),{recursive:true});
  try{const saved=await read(path.join(this.folder,'settings.json'));this.settings=validatePhone(Object.fromEntries(Object.entries(saved).filter(([k])=>Object.hasOwn(DEFAULT_PHONE,k))));this.version=saved.controlVersion??null;}catch(e){if(e.code==='ENOENT')await writeJson(path.join(this.folder,'settings.json'),this.settings);else this.state.error='电话设置无法读取，使用安全默认设置';}
  try{this.schedule=new PhoneSchedule((await read(path.join(this.folder,'journal.json'))).schedule,this.clock);}catch{}
  await this.persist();this.startInputs();this.timer=setInterval(()=>{void this.poll().catch(e=>{this.state.error=e.message;});},200);return this;
 }
 startInputs(){
  if(this.closed)return;
  const child=this.spawnProcess(runtime.python,['-X','utf8',path.join(this.folder,'input.py'),'--parent',String(process.pid)],{windowsHide:true,stdio:'ignore'});this.inputs=child;const started=Date.now();let handled=false;
  const lost=error=>{if(handled)return;handled=true;if(this.inputs===child)this.inputs=null;if(this.closed)return;this.state.error='电话按键正在重新连接'+(error?'：'+error.message:'');this.inputFailures=Date.now()-started>30000?0:(this.inputFailures??0)+1;this.inputRetry=setTimeout(()=>this.startInputs(),Math.min(10000,500*2**Math.min(4,this.inputFailures)));};
  child.on('error',lost);child.on('exit',()=>lost());
  // A listener that survives the stability window is healthy again; do not let
  // an old reconnect notice linger after the phone keys are back.
  const stable=setTimeout(()=>{if(!this.closed&&this.inputs===child&&this.state.error?.startsWith('电话按键正在重新连接'))this.state.error=null;},this.inputStableMs);
  stable.unref?.();
 }
 get active(){return phoneActive(this.state);}
 snapshot(){return {...this.state,at:this.clock().getTime(),pid:process.pid,settingsVersion:this.version??null,dailyCount:this.schedule.data.count,nextCallAt:this.schedule.data.retryAt||this.schedule.data.nextAt||null,engine:this.engine,inputMode:'automatic-turns',controls:{hotkey:this.settings.hotkey,mouseHoldEnabled:this.settings.mouseHoldEnabled,mouseHoldMs:this.settings.mouseHoldMs},rtSupported:false};}
 persist(){
  const snapshot=this.snapshot();
  const journal={schedule:structuredClone(this.schedule.data),lastCall:this.state.id?{id:this.state.id,direction:this.state.direction,phase:this.state.phase,reason:this.state.reason,startedAt:this.state.startedAt,endedAt:this.state.endedAt}:null};
  const key=JSON.stringify(journal);
  const operation=(this.persistTail??Promise.resolve()).catch(()=>{}).then(async()=>{
   await writeJson(path.join(this.folder,'state.json'),snapshot);
   if(key!==this.journalKey){await writeJson(path.join(this.folder,'journal.json'),journal);this.journalKey=key;}
  });
  this.persistTail=operation;return operation;
 }
 command(action,{callId,video=false}={}){
  const op=async()=>{
   if(this.closed)throw Error('电话服务正在关闭');
   if(callId&&callId!==this.state.id)throw Error('这通电话已经结束');
   if(action==='dial')return this.begin('outgoing',{video});
   if(action==='demo')return this.begin('incoming',{demo:true});
   if(action==='toggle'){if(this.state.phase==='incoming')return this.accept();if(this.active)return this.end('owner');return this.begin('outgoing');}
   if(action==='accept')return this.accept();
   if(action==='reject')return this.end('rejected');
   if(action==='hangup')return this.end('owner');
   if(action==='mute'){
    if(this.state.phase!=='connected')throw Error('电话尚未接通');
    const {id,muted}=this.state;
    if(this.muteExternal)await this.muteExternal(id,!muted);
    if(this.state.id!==id||this.state.phase!=='connected')return;
    this.state.muted=!muted;
    this.listen(!this.state.muted&&this.state.turn==='listening'&&!this.voiceState()?.busy);
    await this.persist();return;
   }
   throw Error('没有这个电话操作');
  };
  const result=this.commandTail.then(op);this.commandTail=result.catch(()=>{});return result;
 }
 launch(){const child=this.spawnProcess(path.join(this.folder,'DafeiyuCall.exe'),[String(process.pid)],{windowsHide:false,stdio:'ignore'});child.on('error',e=>{void this.fail(this.state.id,Error('通话窗口无法打开：'+e.message));});child.on('exit',()=>{if(this.panel===child&&this.active)void this.end('window-closed');});return child;}
 toneStart(kind){this.toneStop();if(!this.settings.ringVolume)return;this.tone=this.spawnProcess(runtime.python,['-X','utf8',path.join(this.folder,'tone.py'),'--parent',String(process.pid),'--kind',kind,'--volume',String(this.settings.ringVolume)],{windowsHide:true,stdio:'ignore'});this.tone.on('error',e=>{this.state.error='提示音未播放：'+e.message;});}
 toneStop(){this.tone?.kill();this.tone=null;}
 async begin(direction,{demo=false,retry=false,video=false}={}){
  if(!this.settings.enabled)throw Error('请先开启电话功能');if(this.active)throw Error('已经有一通电话');
  this.panel?.kill();this.panel=null;this.schedule.data.retryAt=demo?this.schedule.data.retryAt:0;
  const id=randomUUID(),now=this.clock().getTime();
  this.state={id,phase:direction==='incoming'?'incoming':'dialing',turn:'preparing',direction,demo,video,startedAt:now,ringUntil:now+this.settings.ringSeconds*1000,muted:false,error:null,answerKey:null,input:'',reply:''};
  if(direction==='incoming'&&!demo)this.schedule.started(this.settings,{retry});
  await this.persist();
  if(this.closed||this.state.id!==id||!this.active)return this.snapshot();
  if(direction==='outgoing'&&!this.connectExternal)this.panel=this.launch();
  this.toneStart(direction==='incoming'?'ring':'dial');
  const controller=new AbortController();
  const current=()=>!this.closed&&this.state.id===id&&this.active;
  const task=Promise.resolve().then(()=>{if(current())return this.prepare?.(direction,{id,current,signal:controller.signal});});
  this.preparation={id,controller,task};void task.catch(()=>{});
  if(direction==='outgoing')void this.connect(id).catch(e=>this.fail(id,e));return this.snapshot();
 }
 async accept(){if(this.state.phase!=='incoming')throw Error('目前没有等待接听的来电');const id=this.state.id;this.state.phase='connecting';this.state.turn='preparing';await this.persist();if(this.closed||this.state.id!==id||this.state.phase!=='connecting')return;if(!this.connectExternal)this.panel=this.launch();this.toneStart('dial');void this.connect(id).catch(e=>this.fail(id,e));}
 async connect(id){
  if(id!==this.state.id)return;
  await this.interrupt?.();const until=this.clock().getTime()+90000;
  while(!this.ready()){if(!this.active||this.state.id!==id)return;if(this.clock().getTime()>until)throw Error('语音准备超时，请稍后再拨');await wait(150);}
  if(!this.active||this.state.id!==id)return;
  this.state.phase='connecting';this.state.preparingUntil=this.clock().getTime()+90000;await this.persist();
  if(this.closed||!this.active||this.state.id!==id)return;
  if(this.preparation?.id===id)await this.preparation.task;
  if(this.closed||!this.active||this.state.id!==id)return;
  if(this.connectExternal){
   const current=()=>!this.closed&&this.active&&this.state.id===id;
   await this.connectExternal({id,video:this.state.video,silenceMs:this.settings.silenceMs,current});
   if(!current())return;
   await this.audioPrepared();
   if(!current())return;
   this.state.turn='listening';
   await this.persist();
   return;
  }
  await this.startCapture(id);
  if(!this.active||this.state.id!==id)return;
  this.listen(false);
  if(this.onGreeting)await this.onGreeting(this.state.direction,id);
  else {await this.audioPrepared();this.turnFinished();}
 }
 async audioPrepared(){if(this.state.phase!=='connecting')return;this.toneStop();this.state.phase='connected';this.state.connectedAt=this.clock().getTime();this.state.turn='speaking';this.state.error=null;await this.persist();}
 async fail(id,error){if(this.state.id!==id||!this.active)return;this.state.error=String(error.message).slice(0,300);await this.end('error');}
 startCapture(id){
  return new Promise((resolve,reject)=>{
   const child=this.spawnProcess(runtime.asrPython,['-X','utf8',path.join(this.folder,'capture.py'),'--parent',String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.capture=child;
   const timer=setTimeout(()=>reject(Error('电话麦克风启动超时')),20000);let prepared=false,stderr='';
   child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1000);});
   child.on('error',e=>{clearTimeout(timer);reject(e);});
   child.on('close',(code,signal)=>{clearTimeout(timer);if(this.capture===child)this.capture=null;
    if(!prepared){
     const detail=stderr.trim().split(/\r?\n/).at(-1);
     reject(Error('电话听话进程未启动'+(detail?'：'+detail.slice(0,200):'（'+(signal??code??'未知')+'）')));
    }else if(this.active&&this.state.id===id&&!child.intentionalStop)void this.fail(id,Error('电话麦克风连接断开'));
   });
   createInterface({input:child.stdout}).on('line',line=>{try{const row=JSON.parse(line);if(row.event==='ready'&&row.callId===id){prepared=true;clearTimeout(timer);resolve();}if(row.event==='error'){clearTimeout(timer);if(!prepared)reject(Error(row.error));else void this.fail(id,Error(row.error));}if(row.event==='utterance')void this.utterance(row,id);}catch{}});
   child.stdin.write(JSON.stringify({command:'start',callId:id,silenceMs:this.settings.silenceMs})+'\n');
  });
 }
 async utterance(row,id){
  const file=path.resolve(String(row.file??'')),base=path.resolve(voice,'cache');
  if(path.dirname(file)!==base||!/^phone-[a-f0-9]{32}\.wav$/.test(path.basename(file)))return;
  try{
   if(this.state.id!==id||this.state.phase!=='connected'||this.state.muted||this.state.turn!=='listening')return;
   this.listen(false);this.state.turn='recognizing';this.state.error=null;await this.persist();await this.onAudio(file,id);
  }catch(e){if(this.state.id===id&&this.active){this.state.error=e.message;this.turnFinished();}}
  finally{await fs.rm(file,{force:true}).catch(()=>{});}
 }
 listen(enabled){if(this.capture?.stdin.writable)this.capture.stdin.write(JSON.stringify({command:'listen',enabled:!!enabled&&!this.state.muted})+'\n');}
 turnFinished(){if(this.state.phase!=='connected')return;const id=this.state.id;this.state.turn='waiting';clearTimeout(this.listenTimer);this.listenTimer=setTimeout(()=>{if(this.state.id===id&&this.state.phase==='connected'){this.state.turn='listening';this.listen(true);}},500);}
 async stopCapture(){const child=this.capture;if(!child)return;child.intentionalStop=true;this.capture=null;if(child.stdin.writable)child.stdin.end(JSON.stringify({command:'stop'})+'\n');await Promise.race([new Promise(r=>child.once('exit',r)),wait(1500)]);if(child.exitCode===null)child.kill();}
 async end(reason='owner'){
  if(!this.active)return;const old=this.state;clearTimeout(this.listenTimer);this.listen(false);this.toneStop();
  this.state={...old,phase:'ended',turn:'idle',reason,endedAt:this.clock().getTime()};
  if(this.preparation?.id===old.id){this.preparation.controller.abort(new DOMException('通话已结束','AbortError'));this.preparation=null;}
  const cleanup=await Promise.allSettled([this.stopCapture(),Promise.resolve().then(()=>this.interrupt?.()),Promise.resolve().then(()=>this.afterEnd?.(old.id))]);
  if(old.direction==='incoming'&&!old.demo)this.schedule.ended(reason,this.settings);
  await this.persist();
  for(const result of cleanup)if(result.status==='rejected')throw result.reason;
  return this.snapshot();
 }
 async poll(){
  if(this.polling||this.closed)return;this.polling=true;
  try{
   const now=this.clock().getTime();
   if(now-this.lastReload>500){this.lastReload=now;try{const saved=await read(path.join(this.folder,'settings.json'));if(saved.controlVersion!==this.version){this.settings=validatePhone(Object.fromEntries(Object.entries(saved).filter(([k])=>Object.hasOwn(DEFAULT_PHONE,k))));this.version=saved.controlVersion??null;}}catch(e){this.state.error='电话设置无法读取';}}
   const files=(await fs.readdir(path.join(this.folder,'inbox'))).filter(x=>/^\d+-[a-f0-9-]+\.json$/.test(x)).sort();
   for(const file of files.slice(0,10)){const target=path.join(this.folder,'inbox',file);try{const c=await read(target);if(!this.seen.has(c.id)&&Math.abs(now-c.at)<15000){this.seen.add(c.id);if(this.seen.size>150)this.seen.delete(this.seen.values().next().value);await this.command(c.action,{callId:c.callId});}}catch(e){this.state.error=e.message;}finally{await fs.rm(target,{force:true});}}
   if(!this.settings.enabled&&this.active)await this.end('disabled');
   if(this.state.phase==='incoming'&&now>=this.state.ringUntil)await this.end('unanswered');
   if(this.state.phase==='connecting'&&now>this.state.preparingUntil)await this.fail(this.state.id,Error('通话准备超时，请稍后重拨'));
   if(this.state.phase==='connected'){
    const v=this.voiceState?.()??{};this.state.input=v.input??'';this.state.reply=v.reply??'';
    if(v.phase==='正在回复')this.state.turn='speaking';else if(v.phase==='正在思考'||v.busy&&this.state.turn==='listening')this.state.turn='thinking';
   }
   if(this.state.phase==='incoming')try{const h=await read(path.join(this.folder,'hardware.json'));if(h.callId===this.state.id){this.state.keyboard=h;this.state.answerKey=h.ready?h.answerKey:null;}}catch{}
   if(this.state.phase==='ended'&&now-this.state.endedAt>2000)this.state={phase:'idle',turn:'idle',muted:false,error:this.state.error??null};
   let busy=!!this.voiceState?.()?.busy;try{const c=await read(path.resolve(this.folder,'../control-status.json'));busy||=c.rawState!=='IDLE';const p=await read(path.resolve(this.folder,'../playtime-state.json'));busy||=p.game?.active===true;}catch{busy=true;}
   if(!this.active&&this.state.phase==='idle'&&this.schedule.due(this.settings,busy)){const retry=!!this.schedule.data.retryAt;await this.commandTail;await this.begin('incoming',{retry});}
   if(now-this.heartbeatAt>1000){this.heartbeatAt=now;await this.persist();}
  }finally{this.polling=false;}
 }
 async close(){
  this.closed=true;clearInterval(this.timer);clearTimeout(this.listenTimer);clearTimeout(this.inputRetry);
  try{await this.end('shutdown');}
  finally{
   await Promise.allSettled([
    Promise.resolve().then(()=>this.toneStop()),
    this.stopCapture(),
    Promise.resolve().then(()=>this.panel?.kill()),
    Promise.resolve().then(()=>this.inputs?.kill()),
   ]);
  }
 }
}
