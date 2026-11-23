import {randomUUID} from 'node:crypto';
import {pages} from './text.mjs';
import {captionOptions,captionUnits} from '../subtitles.mjs';

export function speechCaptionPages(text,options={}){
 const {captionMode,captionFontSize}=captionOptions(options);
 // A scrolling line can use all 48 UTF-8 bytes. The older page splitter used
 // the static viewport width even when the device was going to scroll it.
 return pages(text,{maxUnits:captionMode==='pages'?(options.playbackTimed?(captionFontSize===1?14:22):(captionFontSize===1?16:28)):Infinity,semantic:true});
}
export function captionReadMs(text,{scrolling=false,fontSize=0,seconds=0}={}){
 const units=captionUnits(text);
 // The verified text path has no connected completion notification. Allow an
 // entrance lead, a length/font-based traverse estimate and a reading tail.
 const visual=scrolling?1800+units*(fontSize===1?180:140):500+units*85;
 return Math.ceil(Math.max(1400,visual,Number.isFinite(seconds)?seconds*1000:0));
}

// Caption time is independent of audio time. Playback never waits for an older
// line to finish scrolling; cancellation can still replace the display at once.
export class SpeechCaptionQueue{
 constructor({render,refresh=async()=>{},finished=async()=>{},onError=()=>{},timers=globalThis,clock=Date.now}={}){
  Object.assign(this,{render,refresh,finished,onError,timers,clock});this.queue=[];this.epoch=0;this.tickets=new Set();this.last=null;this.runner=null;this.ending=false;
 }
 enqueue(text,{g,seconds=0,options={},playbackStartedAt}={}){
  const chunks=speechCaptionPages(text,options),idle=!this.runner&&!this.queue.length;
  let resolve;const started=new Promise(r=>{resolve=r;}),ticket={started,resolve,settled:false,g};
  const weight=chunks.reduce((n,s)=>n+captionUnits(s),0)||1;
  if(this.queue.length+chunks.length>64){this.settle(ticket,{cancelled:true});return {started,first:false};}
  this.ending=false;this.tickets.add(ticket);
  const timed=options.playbackTimed&&Number.isFinite(seconds)&&seconds>0;
  const origin=Number.isFinite(playbackStartedAt)?playbackStartedAt:this.clock();
  let offset=0;
  for(const fragment of chunks){
   const duration=seconds*captionUnits(fragment)/weight;
   this.queue.push({text:fragment,g,options,key:randomUUID(),seconds:duration,ticket,...(timed?{playbackStartedAt:origin+Math.round(offset),playbackDeadline:origin+Math.round(offset+duration*1000)}:{})});
   offset+=duration*1000;
  }
  if(!chunks.length){this.settle(ticket,{cancelled:true});return {started,first:idle};}
  this.start();return {started,first:idle};
 }
 settle(ticket,value){if(ticket.settled)return;ticket.settled=true;ticket.resolve(value);this.tickets.delete(ticket);}
 start(){
  if(this.runner)return;
  const epoch=this.epoch;
  const task=this.run(epoch).catch(error=>{if(epoch===this.epoch){for(const item of this.queue)this.settle(item.ticket,{error});this.queue=[];this.onError(error);}}).finally(()=>{
   if(this.runner===task)this.runner=null;
   if(this.queue.length)this.start();else if(this.ending&&epoch===this.epoch)void this.complete(epoch);
  });this.runner=task;
 }
 async run(epoch){
  while(this.queue.length&&epoch===this.epoch){
   const item=this.queue.shift();this.abort=new AbortController();
   try{
    // Audio has already started independently of USB writes. Do not replay
    // pages whose entire slot elapsed while an earlier write was awaiting ACK.
    if(Number.isFinite(item.playbackDeadline)&&item.playbackDeadline<=this.clock()){
     if(!this.queue.some(next=>next.ticket===item.ticket))this.settle(item.ticket,{cancelled:true,reason:'playback-expired'});
     continue;
    }
    const actual=await this.render(item,this.abort.signal);
    if(epoch!==this.epoch){this.settle(item.ticket,{cancelled:true});return;}
    if(actual?.cancelled){this.settle(item.ticket,actual);continue;}
    if(actual?.nativeUnsupported&&captionUnits(item.text)>(actual.fontSize===1?16:28)){
     const fragments=pages(item.text,{maxUnits:actual.fontSize===1?16:28,semantic:true}),total=captionUnits(item.text)||1;
     let offset=0;
     this.queue.unshift(...fragments.map(text=>{
      const seconds=item.seconds*captionUnits(text)/total;
      const part={...item,text,key:randomUUID(),seconds,...(Number.isFinite(item.playbackDeadline)?{playbackStartedAt:item.playbackStartedAt+Math.round(offset),playbackDeadline:Math.min(item.playbackDeadline,item.playbackStartedAt+Math.round(offset+seconds*1000))}:{})};
      offset+=seconds*1000;return part;
     }));
     continue;
    }
    this.last=item;this.settle(item.ticket,{ready:true});
    // Absolute deadlines account for ACK/queue delay rather than adding that
    // delay to every page. Untimed captions retain the full reading budget.
    const duration=Number.isFinite(item.playbackDeadline)?Math.max(0,item.playbackDeadline-this.clock()):captionReadMs(item.text,{...actual,seconds:item.seconds});
    if(!duration)continue;
    let keepalive;
    const wait=new Promise(resolve=>{
     let timer;const done=()=>{this.timers.clearTimeout(timer);this.abort?.signal.removeEventListener('abort',done);resolve();};
     timer=this.timers.setTimeout(done,duration);this.abort.signal.addEventListener('abort',done,{once:true});
    });
    keepalive=this.timers.setInterval(()=>{if(epoch===this.epoch)void this.refresh(item).catch(this.onError);},4000);
    await wait;this.timers.clearInterval(keepalive);
   }catch(error){this.settle(item.ticket,{error});throw error;}
  }
 }
 finish(){this.ending=true;if(!this.runner&&!this.queue.length)void this.complete(this.epoch);}
 async complete(epoch){
  if(!this.ending||epoch!==this.epoch)return;this.ending=false;
  try{await this.finished(this.last);}catch(error){this.onError(error);}
 }
 cancel(){
  this.epoch++;this.ending=false;this.queue=[];this.abort?.abort();this.last=null;
  for(const ticket of this.tickets)this.settle(ticket,{cancelled:true});
 }
}
