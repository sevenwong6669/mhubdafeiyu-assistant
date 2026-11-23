import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../desktop-pet/renderer.js',import.meta.url),'utf8');
function renderer({capture,microphone,contextClose,draw,AudioImpl,caption}={}){
 const handlers={},events=[],captions=[],timers=[],elements=new Map();let stops=0;
 const track={stop(){stops++;}},stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
 const element=()=>({hidden:false,style:{},textContent:'',classList:{add(){},remove(){}}});
 const context=vm.createContext({console,Date,performance:{now:()=>0},ArrayBuffer,DataView,Float32Array,Uint8Array,Blob,URL,atob,btoa,Audio:AudioImpl,
  setTimeout:(fn)=>{timers.push(fn);return timers.length;},clearTimeout(){},clearInterval(){},
  window:{addEventListener(){}},document:{querySelector(key){if(!elements.has(key))elements.set(key,element());return elements.get(key);},body:element(),createElement(kind){return kind==='video'?{videoWidth:1280,videoHeight:720,readyState:3,play:async()=>{}}:{getContext:()=>({drawImage(){draw?.();}}),toDataURL:()=> 'data:image/jpeg;base64,AAAA'};}},
  navigator:{mediaDevices:{getDisplayMedia:capture??(async()=>stream),enumerateDevices:async()=>[],getUserMedia:microphone??(async()=>stream)}},
  AudioContext:class{constructor(){this.sampleRate=48000;this.destination={};}createMediaStreamSource(){return {connect(){},disconnect(){}};}createScriptProcessor(){return {connect(){},disconnect(){}};}close(){return contextClose?.()??Promise.resolve();}},
  pet:{on:(name,callback)=>{handlers[name]=callback;},request:async(action,input)=>{if(action==='event')events.push(input);if(action==='caption'){captions.push(input);await caption?.(input);}if(action==='model')return {};return {ok:true};}}});
 vm.runInContext(source+'\nglobalThis.inspectPet=()=>({watchStream,watchStarting,callId});globalThis.playTest=result=>play(result,callId,epoch);',context);
 return {handlers,events,captions,timers,stream,elements,get stops(){return stops;},inspect:()=>context.inspectPet(),play:value=>context.playTest(value)};
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
test('own pet clears a transient connection error after a valid idle heartbeat',()=>{const r=renderer();r.handlers['backend-error']('等待旧实例退出');assert.equal(r.elements.get('#status').textContent,'等待旧实例退出');r.handlers.state({watch:{on:false,version:1},call:null});assert.equal(r.elements.get('#status').textContent,'大肥鱼在呢');});
test('own pet captures selected manual watch without requiring a phone and keeps it alive through an audio call',async()=>{
 const r=renderer();r.handlers.state({watch:{on:true,version:1},call:null});await settle();assert.equal(r.events.filter(e=>e.type==='frame').length,1);assert.ok(r.inspect().watchStream);
 r.handlers.state({watch:{on:true,version:1},call:{id:'owned-call',phase:'preparing'}});r.handlers.command({type:'call-start',callId:'owned-call'});await settle();assert.equal(r.stops,0);assert.ok(r.inspect().watchStream);assert.equal(r.events.filter(e=>e.type==='call-ready').length,1);
 r.handlers.command({type:'call-stop'});await settle();assert.ok(r.inspect().watchStream);assert.equal(r.stops,1);r.handlers.state({watch:{on:false,version:2}});assert.equal(r.stops,2);
});
test('authoritative ended call cancels a queued start before it can open the microphone',async()=>{let opened=0;const r=renderer({microphone:async()=>{opened++;return r.stream;}});r.handlers.state({watch:{on:false,version:1},call:{id:'old',phase:'preparing'}});r.handlers.command({type:'call-stop',callId:'old'});await settle();assert.equal(opened,0);assert.equal(r.inspect().callId,null);assert(!r.events.some(e=>e.type==='call-ready'));r.handlers.state({watch:{on:false,version:1},call:{id:'old',phase:'ended'}});r.handlers.command({type:'call-start',callId:'old'});await settle();assert.equal(opened,0);});
test('backend restart ends the old local microphone and unrelated old stop cannot end a newer call',async()=>{const r=renderer();r.handlers.state({watch:{on:false,version:1},call:{id:'current',phase:'preparing'}});await settle();assert.equal(r.inspect().callId,'current');r.handlers.command({type:'call-stop',callId:'old'});await settle();assert.equal(r.inspect().callId,'current');r.handlers.state({watch:{on:false,version:1},call:null});await settle();assert.equal(r.inspect().callId,null);assert.equal(r.stops,1);});
test('frame rendering failure releases capture and follows the bounded retry path',async()=>{let draws=0;const r=renderer({draw:()=>{if(++draws===1)throw Error('frame conversion failed');}});r.handlers.state({watch:{on:true,version:1},call:null});await settle();assert(r.events.some(e=>e.type==='watch-state'&&e.phase==='retrying'));assert.equal(r.stops,1);assert.equal(r.inspect().watchStream,null);assert.equal(r.timers.length,1);r.timers[0]();await settle();assert.equal(r.events.filter(e=>e.type==='frame').length,1);assert.ok(r.inspect().watchStream);});
test('playback failure waits for its caption start receipt then cancels the same speech',async()=>{let acknowledge;class BrokenAudio{constructor(url){this.src=url;}play(){queueMicrotask(()=>{this.onplaying();queueMicrotask(()=>this.onerror());});return Promise.resolve();}pause(){this.onpause?.();}}
 const r=renderer({AudioImpl:BrokenAudio,caption:input=>input.event==='start'?new Promise(resolve=>{acknowledge=resolve;}):undefined});r.handlers.state({watch:{on:false,version:1},call:{id:'current',phase:'preparing'}});await settle();const pending=r.play({audio:Buffer.alloc(44).toString('base64'),speechId:'speech-owned',reply:'测试',audioMs:500});const rejected=assert.rejects(pending,/播放失败/);await settle();assert.deepEqual(r.captions.map(c=>c.event),['start']);acknowledge();await rejected;assert.deepEqual(r.captions.map(c=>[c.event,c.speechId]),[['start','speech-owned'],['cancel','speech-owned']]);});
test('own pet rejects a display capture that finishes after watch has been disabled',async()=>{
 let resolve;const r=renderer({capture:()=>new Promise(done=>{resolve=done;})});r.handlers.state({watch:{on:true,version:1},call:null});await settle();assert.equal(r.inspect().watchStarting,true);
 r.handlers.state({watch:{on:false,version:2},call:null});resolve(r.stream);await settle();assert.equal(r.stops,1);assert.equal(r.events.filter(e=>e.type==='frame').length,0);assert.equal(r.inspect().watchStream,null);
});
