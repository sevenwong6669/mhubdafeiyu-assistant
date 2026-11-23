// Audio progress, rather than process liveness, owns the playback deadline.
export function onceOwnedStop(child,stop){
 let task=null;
 return()=>{
  if(child.exitCode!==null)return Promise.resolve();
  if(!task)task=Promise.resolve().then(()=>stop(child)).catch(error=>{if(child.exitCode!==null)return;task=null;throw error;});
  return task;
 };
}

export class PlaybackDeadline {
 constructor(fail,{timers=globalThis,startMs=8000,progressMs=12000}={}){Object.assign(this,{fail,timers,startMs,progressMs});this.started=false;this.played=-1;this.arm(startMs);}
 arm(ms){this.timers.clearTimeout(this.timer);this.timer=this.timers.setTimeout(()=>this.fail(Object.assign(Error(this.started?'语音播放进度中断，正在恢复播放设备。':'语音播放未开始，正在恢复播放设备。'),{code:'PLAYBACK_STALLED',playbackStarted:this.started})),ms);}
 progress(row){
  if(row.event==='started'){this.started=true;this.arm(this.progressMs);}
  if(row.event==='progress'){
   if(!this.started&&row.waitingForAudio){this.arm(this.startMs);return;}
   if(this.started&&row.playedSamples>this.played){this.played=row.playedSamples;this.arm(this.progressMs);}
  }
 }
 close(){this.timers.clearTimeout(this.timer);}
}

export class PlaybackDeviceTracker {
 constructor({clock=Date.now}={}){this.clock=clock;this.connected=null;this.revision=0;this.needsReset=false;}
 observe(health,relevant=true){
  const age=this.clock()-health?.at;if(!Number.isFinite(age)||age<0||age>10000)return false;
  const connected=health.screen?.ready===true?true:/disconnected|未连接|未检测到/i.test(health.screen?.error??'')?false:null;
  if(connected===null)return false;
  const changed=this.connected!==null&&this.connected!==connected;this.connected=connected;
  if(changed){this.revision++;if(relevant)this.needsReset=true;}
  return changed&&relevant;
 }
 applied(revision){if(revision===this.revision)this.needsReset=false;}
}

// Keep only bounded, already synthesized PCM for one unstarted retry.
export class StreamPackets {
 constructor(stream,{maxBytes=6*1024*1024,maxPackets=2048}={}){Object.assign(this,{stream,maxBytes,maxPackets});this.history=[];this.waiting=[];this.bytes=0;this.waitingBytes=0;this.canReplay=true;this.ended=false;this.closed=false;this.sender=null;}
 push(packet){
  if(this.closed||this.ended||packet.stream!==this.stream)return;
  const bytes=Buffer.byteLength(packet.audio??'','base64');
  if(this.canReplay){this.bytes+=bytes;if(this.bytes>this.maxBytes||this.history.length>=this.maxPackets){this.canReplay=false;this.history=[];}else this.history.push(packet);}
  if(this.sender)this.sender(packet);
  else{this.waitingBytes+=bytes;if(this.waitingBytes>this.maxBytes||this.waiting.length>=this.maxPackets)throw Error('待播放音频缓冲已满，请重试。');this.waiting.push(packet);}
 }
 end(){if(this.closed)return;this.ended=true;this.sender?.({command:'end',stream:this.stream});}
 attach(sender,{replay=false}={}){
  if(this.closed)return;
  if(replay&&!this.canReplay)throw Error('音频超过补播缓存上限，请重新说话。');
  const packets=replay?this.history:this.waiting;this.sender=sender;this.waiting=[];this.waitingBytes=0;
  for(const packet of packets)sender(packet);
  if(this.ended)sender({command:'end',stream:this.stream});
 }
 detach(){this.sender=null;}
 close(){this.closed=true;this.sender=null;this.waiting=[];this.history=[];}
}

export async function playRecoverableStream(item,{getPlayer,reset,current,progress=()=>{},recovering=()=>{}}){
 let started=false;
 for(let attempt=0;attempt<2;attempt++){
  if(!current())return {canceled:true};
  let player,task,accepting=true;
  try{
   player=await getPlayer();if(!current())return {canceled:true};
   task=player.run({command:'begin',stream:item.stream,pages:item.pages},row=>{if(!accepting||!current())return;if(row.event==='started')started=true;progress(row);});
   // The worker's ready await must put begin before every PCM packet.
   void task.catch(()=>{});await Promise.resolve();
   if(!current()){player.write({command:'cancel'});await task.catch(()=>{});return {canceled:true};}
   item.packets.attach(packet=>player.write(packet),{replay:attempt>0});
   return {...await task,replayed:attempt>0};
  }catch(error){
   accepting=false;
   item.packets.detach();
   if(!current())return {canceled:true};
   if(started||attempt>0||!item.packets.canReplay)throw error;
   recovering(error);await reset(player);
   if(!current())return {canceled:true};
  }finally{accepting=false;item.packets.detach();}
 }
}
