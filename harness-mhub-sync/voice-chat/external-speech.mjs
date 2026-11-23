const events=new Set(['start','end','cancel','error','text-only']);
export function validatePlaybackEvent(event){
 if(!event||typeof event!=='object'||event.role&&event.role!=='assistant')throw Error('仅显示大肥鱼回复字幕。');
 if(event.speechId!==undefined&&(typeof event.speechId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(event.speechId)))throw Error('语音标识无效。');
 if(event.event&&!events.has(event.event))throw Error('播放事件无效。');
 if(event.phoneOwner!==undefined&&typeof event.phoneOwner!=='string')throw Error('通话标识无效。');
 if(['start','text-only'].includes(event.event)||!event.event){if(typeof event.text!=='string'||!event.text.trim()||[...event.text].length>2000)throw Error('Live2D 字幕文字无效。');}
 return event;
}
export class ExternalSpeech{
 constructor({queue,clear,changed,options,generation,ownerCurrent=()=>true,clock=Date.now}){
  Object.assign(this,{queue,clear,changed,options,generation,ownerCurrent,clock});this.id=null;this.order=0;this.revision=0;this.known=new Map();this.retired=new Set();this.playing=false;this.error=null;
 }
 register(id){if(!id)return;if(!this.known.has(id))this.known.set(id,++this.order);if(this.known.size>200){const old=this.known.keys().next().value;this.known.delete(old);this.retired.delete(old);}}
 snapshot(){return {speechId:this.id,playing:this.playing,error:this.error,until:this.until??0};}
 reset(){this.revision++;for(const id of this.known.keys())this.retired.add(id);this.id=null;this.playing=false;this.error=null;this.changed(this.snapshot());}
 async retime(id,audioMs){
  if(!id||id!==this.id||!this.playing||this.retired.has(id)||!Number.isFinite(audioMs)||audioMs<=0)return {ok:true,ignored:true};
  audioMs=Math.min(180000,audioMs);this.revision++;this.queue.cancel();
  this.until=this.startedAt+audioMs+5000;this.changed(this.snapshot());
  this.queue.enqueue(this.text,{g:this.generation(),seconds:audioMs/1000,playbackStartedAt:this.startedAt,options:{...this.options(),captionMode:'pages',playbackTimed:true}});
  this.queue.finish();return {ok:true};
 }
 async event(value){
  const e=validatePlaybackEvent(value),kind=e.event??'start',id=e.speechId??null;
  if(!this.ownerCurrent(e.phoneOwner)||id&&this.retired.has(id))return {ok:true,ignored:true};
  if(['end','cancel','error'].includes(kind)){
   if(id!==this.id)return {ok:true,ignored:true};
   const revision=++this.revision;
   this.playing=false;if(id)this.retired.add(id);
   if(kind==='error')this.error={speechId:id,stage:String(e.stage||'playback').slice(0,40),message:String(e.message||'语音播放失败，请检查播放设备。').slice(0,300),at:this.clock()};
   this.changed(this.snapshot());
   if(kind==='end')this.queue.finish();else{this.queue.cancel();await this.clear(()=>this.revision===revision&&this.id===id);}
   return {ok:true};
  }
  this.register(id);
  if(id&&id===this.id&&kind==='start')return {ok:true,duplicate:true};
  if(this.id&&id&&this.known.get(id)<this.known.get(this.id))return {ok:true,ignored:true};
  if(this.id&&this.id!==id)this.retired.add(this.id);
  this.revision++;this.queue.cancel();this.id=id;this.playing=kind==='start'&&!!id;
  this.error=kind==='text-only'&&e.message?{speechId:id,stage:String(e.stage||'synthesis').slice(0,40),message:String(e.message).slice(0,300),at:this.clock()}:null;
  const audioMs=Number.isFinite(e.audioMs)?Math.max(0,Math.min(180000,e.audioMs)):0;
  this.until=this.clock()+Math.max(1000,audioMs)+5000;
  this.changed(this.snapshot());
  const start=Number.isFinite(e.startedAt)&&Math.abs(this.clock()-e.startedAt)<=10000?Math.min(this.clock(),e.startedAt):this.clock();
  this.startedAt=start;this.text=e.text;
  this.queue.enqueue(e.text,{g:this.generation(),seconds:kind==='text-only'?0:audioMs/1000,playbackStartedAt:start,options:{...this.options(),...(kind==='start'&&id?{captionMode:'pages',playbackTimed:true}:{})}});
  this.queue.finish();return {ok:true,textOnly:kind==='text-only'};
 }
}
