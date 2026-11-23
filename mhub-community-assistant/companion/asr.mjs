import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveControlPython} from '../../harness-mhub-sync/startup.mjs';
import {atomicJson} from './config.mjs';
import {abortable} from '../../harness-mhub-sync/voice-chat/speech-jobs.mjs';
export class InternalASR{
 constructor(config,{resolvePython=resolveControlPython,spawnImpl=spawn,loadTimeoutMs=90000,jobTimeoutMs=60000}={}){this.config=config;this.resolvePython=resolvePython;this.spawn=spawnImpl;this.loadTimeoutMs=loadTimeoutMs;this.jobTimeoutMs=jobTimeoutMs;this.generation=0;this.phase='unprepared';this.error=null;this.jobs=new Map();this.root=fileURLToPath(new URL('../../harness-mhub-sync/voice-chat/',import.meta.url));}
 async prepare(){
  if(this.ready)return this.ready;this.phase='preparing';this.error=null;const cfg=this.config.read().asr;
  if(!cfg.modelDir){this.phase='failed';this.error='请设置本地识别模型目录（包含 model.onnx 与 tokens.txt）。';throw Error(this.error);}
  const generation=++this.generation;let owned;
  const pending=(async()=>{
   const python=await this.resolvePython();if(generation!==this.generation)throw Error('识别服务已停止。');
   const file=path.join(this.config.dir,'asr-runtime.json');atomicJson(file,{asrProvider:'internal-local',asrModelDir:cfg.modelDir,asrTier:cfg.tier,asrLanguage:'zh',asrThreads:4});
   const child=this.spawn(python,['-X','utf8',path.join(this.root,'worker.py'),'asr','--config',file],{windowsHide:true,stdio:['pipe','pipe','ignore']});owned=child;this.child=child;
   await new Promise((resolve,reject)=>{
    const fail=error=>{clearTimeout(timer);reject(error);this.fail(error,child,generation);},timer=setTimeout(()=>fail(Error('本地识别模型加载超时。')),this.loadTimeoutMs);
    this.rejectLoad=error=>{clearTimeout(timer);reject(error);};
    createInterface({input:child.stdout}).on('line',line=>{
     if(generation!==this.generation||this.child!==child)return;let row;try{row=JSON.parse(line);}catch{return;}
     if(row.event==='ready'){clearTimeout(timer);this.rejectLoad=null;this.phase='ready';resolve();}
     else if(row.event==='startup-error')fail(Error(row.error));
     else if(this.jobs.has(row.id)){const job=this.jobs.get(row.id);row.error?job.reject(Error(row.error)):job.resolve(row);}
    });
    child.on('error',fail);child.on('exit',()=>fail(Error('本地识别进程已退出。')));child.stdin.on('error',fail);
   });
  })().catch(error=>{this.fail(error,owned,generation);throw error;});
  this.ready=pending;pending.catch(()=>{});return pending;
 }
 fail(error,owned=this.child,generation=this.generation){
  if(generation!==this.generation||owned&&owned!==this.child)return;
  const child=this.child;this.child=null;this.phase='failed';this.error=error.message;this.ready=null;this.rejectLoad?.(error);this.rejectLoad=null;
  for(const job of [...this.jobs.values()])job.reject(error);this.jobs.clear();if(child)child.kill();
 }
 async recognize(wav,signal){
  if(!Buffer.isBuffer(wav)||wav.length<44||wav.length>12*1024*1024||wav.toString('ascii',0,4)!=='RIFF')throw Error('录音文件格式或大小无效。');
  signal?.throwIfAborted();if(this.jobs.size>=2)throw Error('识别正在处理，请稍候。');await abortable(this.prepare(),signal);signal?.throwIfAborted();if(this.jobs.size>=2)throw Error('识别正在处理，请稍候。');
  const child=this.child;if(!child||this.phase!=='ready')throw Error('识别服务已停止。');
  const id=randomUUID(),file=path.join(this.config.dir,'audio',id+'.wav');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,wav);
  try{
   const result=await new Promise((resolve,reject)=>{
    let settled=false;const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.jobs.delete(id);fn(value);};
    const abort=()=>finish(reject,signal.reason??Error('识别已取消。')),timer=setTimeout(()=>finish(reject,Error('识别超时。')),this.jobTimeoutMs);
    this.jobs.set(id,{resolve:v=>finish(resolve,v),reject:e=>finish(reject,e)});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    try{child.stdin.write(JSON.stringify({id,file})+'\n',error=>{if(error)finish(reject,error);});}catch(error){finish(reject,error);}
   });return {ok:true,heard:result.text??''};
  }finally{this.jobs.delete(id);fs.rmSync(file,{force:true});}
 }
 close(){const error=Error('识别服务已停止。');this.fail(error);this.generation++;this.phase='stopped';}
}
