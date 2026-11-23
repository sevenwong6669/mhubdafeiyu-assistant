import {randomUUID} from 'node:crypto';
import {SpeechJobs} from './speech-jobs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function waitForPlaybackPrepared(prepared,{timeoutMs=10000,timers=globalThis}={}) {
 let timer;
 try{return await Promise.race([prepared,new Promise((_,reject)=>{timer=timers.setTimeout(()=>reject(Error('音频播放器准备超时，请检查播放设备。')),timeoutMs);})]);}
 finally{timers.clearTimeout(timer);}
}

// Queue items only own generated UUID WAVs. Never delete cached greetings,
// reference audio or an arbitrary file supplied by another subsystem.
export async function discardAudioFiles(items,{cacheDir,remove=fs.rm}={}) {
 const root=path.resolve(cacheDir),files=new Set();
 for(const item of items){
  if(typeof item?.file!=='string')continue;
  const file=path.resolve(item.file),relative=path.relative(root,file);
  if(!relative||relative==='..'||path.isAbsolute(relative)||relative.startsWith('..'+path.sep)||path.dirname(relative)!=='.'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.wav$/i.test(path.basename(file)))continue;
  files.add(file);
 }
 const results=await Promise.allSettled([...files].map(file=>remove(file,{force:true})));
 const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
 if(errors.length)throw new AggregateError(errors,'临时语音文件清理未完成。');
 return files.size;
}

// Share the actual-playback caption protocol with phone audio. Synthesis and
// USB acknowledgements never gate one another or the player's start command.
export class PttSpeech{
 constructor({external,current=()=>true,clock=Date.now,onError=()=>{},jobs=new SpeechJobs()}={}){Object.assign(this,{external,current,clock,onError,jobs});}
 async synthesize(item,action){
  item.speechId??=randomUUID();this.external.register(item.speechId);
  return this.jobs.run({speechId:item.speechId,owner:item.g},action);
 }
 started(item){
  if(!this.current(item)||item.captionStarted)return;
  item.speechId??=randomUUID();item.captionStarted=true;
  void this.external.event({event:'start',speechId:item.speechId,text:item.text,audioMs:Number.isFinite(item.seconds)?item.seconds*1000:0,startedAt:this.clock()}).catch(this.onError);
 }
 synthesized(item,result){
  item.seconds=result.seconds;
  if(item.captionStarted&&this.current(item))void this.external.retime(item.speechId,result.seconds*1000).catch(this.onError);
 }
 async finished(item,{cancelled=false}={}){
  if(!item.captionStarted)return;
  await this.external.event({event:cancelled?'cancel':'end',speechId:item.speechId}).catch(this.onError);
 }
 cancel(){this.jobs.cancelAll();}
}

export async function prepareVoiceWorkers({prepare,reset,failed,closing=()=>false,maxAttempts=2}){
 for(let attempt=0;attempt<maxAttempts&&!closing();attempt++){
  try{await prepare();return !closing();}
  catch(error){failed(error);if(attempt+1===maxAttempts||closing())return false;await reset();}
 }
 return false;
}
