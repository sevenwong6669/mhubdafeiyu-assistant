import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TtsServiceStore,validateTtsProfile} from '../../mhub-community-assistant/tts-service.mjs';
import {abortable,cancellableWorker} from './speech-jobs.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

// Only synthesis is replaced. ASR, microphone and phone ownership remain in server.mjs.
export class TtsRuntime{
 constructor({root,config,worker,onState=()=>{}}){this.root=root;this.config=config;this.worker=worker;this.onState=onState;this.store=new TtsServiceStore({root});this.registry=this.store.load();this.pool=new Map();this.loading=new Map();this.operations=new Map();this.lock=false;this.lastFallback=null;this.preparing=null;this.lastSynthesis=null;}
 selected(registry=this.registry){return registry.profiles.find(p=>p.id===(registry.scenes.conversation==='current'?registry.activeId:registry.scenes.conversation))??registry.profiles.find(p=>p.id===registry.activeId);}
 get streaming(){const p=this.selected();return ['breeze','openai'].includes(p.type)&&p.streaming;}
 status(){const p=this.selected();return {profileId:p.id,name:p.name,provider:p.type,voice:p.voiceName||p.voice,streaming:this.streaming,loading:this.lock,workerPids:[...this.pool.values()].map(w=>w.child.pid),fallback:this.lastFallback,lastSynthesis:this.lastSynthesis};}
 async get(profile){
  if(this.closed)throw Error('语音合成服务已停止。');
  this.store.assertCredentialTarget(profile);
  const key=profile.type==='local'?'local':digest(profile);
  if(this.pool.get(key)?.isAlive?.()===false){const dead=this.pool.get(key);this.pool.delete(key);await dead.dispose();}
  if(this.loading.has(key))return this.loading.get(key);
  if(!this.pool.has(key)){
   const task=(async()=>{
   const file=path.join(this.root,'cache','tts-profile-'+key+'.json');
   await fs.writeFile(file,JSON.stringify({...this.config,ttsService:profile}));
   if(this.closed)throw Error('语音合成服务已停止。');
   // All local entries share the same loaded model; per-job volume is applied below.
   const handle=cancellableWorker(this.worker(file));this.pool.set(key,handle);
   try{await handle.ready;}catch(error){this.pool.delete(key);await handle.dispose();throw error;}
   await this.prune(key);return handle;
   })().finally(()=>this.loading.delete(key));this.loading.set(key,task);return task;
  }
  return this.pool.get(key);
 }
 async prune(keep){const active=this.selected(),activeKey=active.type==='local'?'local':digest(active);for(const [key,w] of this.pool){if(this.pool.size<=3)break;if(!w.busy&&key!=='local'&&key!==keep&&key!==activeKey&&!this.loading.has(key)){this.pool.delete(key);await w.dispose();}}}
 async ready(){try{await this.get(this.selected());}catch(error){const fallback=this.registry.fallback,local=this.registry.profiles.find(p=>p.id===fallback?.profileId);if(!fallback?.enabled||local?.type!=='local')throw error;await this.get(local);this.lastFallback={at:Date.now(),message:error.message,profileId:local.id};}this.onState(this.status());}
 async reload(){
  if(this.lock)throw Error('语音合成正在切换，请稍等。');
  this.lock=true;this.onState(this.status());
  try{const next=this.store.load(),p=this.selected(next);await this.get(p);if(digest(this.store.load())!==digest(next))throw Error('音色配置已更新，请重新应用。');this.registry=next;this.lastFallback=null;this.onState(this.status());}
  finally{this.lock=false;this.onState(this.status());}
 }
 async run(data,progress,{signal}={}){
  const p=this.selected();let delivered=false;
  try{const handle=await abortable(this.get(p),signal);signal?.throwIfAborted();const result=await handle.run({...data,volume:p.volume},row=>{if(signal?.aborted)return;if(row.audio)delivered=true;progress?.(row);},{signal});this.lastSynthesis={at:Date.now(),profileId:p.id,actualProfileId:p.id,ok:true};this.onState(this.status());return {...result,actualProfileId:p.id};}
  catch(error){
   if(signal?.aborted)throw signal.reason;
   this.lastSynthesis={at:Date.now(),profileId:p.id,ok:false,message:error.message};this.onState(this.status());
   const fallback=this.registry.fallback,local=this.registry.profiles.find(p=>p.id===fallback?.profileId);
   // Replaying after partial streamed output would duplicate the beginning of a sentence.
   if(delivered||!fallback?.enabled||p.type==='local'||local?.type!=='local')throw error;
   this.lastFallback={at:Date.now(),message:error.message,profileId:local.id};this.onState(this.status());
   const file=data.file??path.join(this.root,'cache',randomUUID()+'.wav');
   const result=await (await abortable(this.get(local),signal)).run({...data,stream:false,file,volume:local.volume},undefined,{signal});
   this.lastSynthesis={at:Date.now(),profileId:p.id,actualProfileId:local.id,ok:true,fallback:true};this.onState(this.status());
   return {...result,file,fallback:true,actualProfileId:local.id};
  }
 }
 async prepareConversation({signal,speechRate=1}={}){
  const fallbackKey=()=>digest(this.registry.fallback?.enabled?{settings:this.registry.fallback,profile:this.registry.profiles.find(p=>p.id===this.registry.fallback.profileId)}:null);
  const p=this.selected(),profileKey=digest(p),fallback=fallbackKey(),key=digest({p,speechRate,fallback});
  const current=()=>{if(digest(this.selected())!==profileKey||fallbackKey()!==fallback)throw Error('通话音色已切换，请重新准备。');};
  if(this.preparing?.key===key&&!this.preparing.signal?.aborted)return abortable(this.preparing.task,signal);
  const file=path.join(this.root,'cache','phone-ready-'+key+'.wav'),meta=file+'.json';
  const task=(async()=>{
   await abortable(this.ready(),signal);signal?.throwIfAborted();current();
   try{const saved=JSON.parse(await fs.readFile(meta,'utf8'));const stat=await fs.stat(file);
    if(saved.key===key&&saved.actualProfileId&&this.registry.profiles.some(p=>p.id===saved.actualProfileId)&&Date.now()-saved.at>=0&&Date.now()-saved.at<600000&&stat.size>44){current();return {ready:true,cached:true,profileId:saved.actualProfileId,requestedProfileId:p.id,fallback:!!saved.fallback};}
   }catch{}
   current();const result=await this.run({text:'嗯，我在呢。',file,pages:['嗯，我在呢。'],speechRate},undefined,{signal});
   signal?.throwIfAborted();current();if(!(result.seconds>0)||(await fs.stat(file)).size<=44)throw Error('通话合成预热没有返回有效音频。');
   const actualProfileId=result.actualProfileId??p.id;
   await fs.writeFile(meta,JSON.stringify({key,at:Date.now(),actualProfileId,fallback:!!result.fallback}));return {ready:true,cached:false,profileId:actualProfileId,requestedProfileId:p.id,fallback:!!result.fallback};
  })();
  const entry={key,task,signal};this.preparing=entry;
  try{return await task;}finally{if(this.preparing===entry)this.preparing=null;}
 }
 async manage({operation,profile,text}){
  profile=validateTtsProfile(profile);
  this.store.assertCredentialTarget(profile);
  if(operation==='preview'){
   text=String(text??'').trim();if(!text||[...text].length>100)throw Error('试听文字需要1至100字。');
   const file=path.join(this.root,'cache','tts-preview-'+randomUUID()+'.wav'),start=Date.now();
   try{const result=await(await this.get(profile)).run({text,file,pages:[text],volume:profile.volume});return {...result,file,totalMs:Date.now()-start,message:'试听已通过当前播放设备播放。'};}
   catch(error){await fs.rm(file,{force:true});throw error;}
  }
  if(profile.type==='local'){await this.get(profile);return {items:[],verified:true,message:'本地合成模型已加载。',manual:true};}
  if(!['models','voices','test'].includes(operation))throw Error('未知语音操作。');
  if(this.admin?.isAlive?.()===false){await this.admin.dispose();this.admin=null;}
  if(!this.admin){this.admin=this.worker(null,'tts-admin');try{await this.admin.ready;}catch(error){await this.admin.dispose();this.admin=null;throw error;}}
  return this.admin.run({operation,profile});
 }
 async effect({scene,clip}){
  if(!['pet','game'].includes(scene)||typeof clip!=='string'||!/^[-\w]+\.wav$/.test(clip))throw Error('互动语音参数无效。');
  const registry=this.store.load(),id=registry.scenes[scene];if(id==='cache'||!id)return {cached:true,useOriginal:true};
  const profile=id==='current'?registry.profiles.find(p=>p.id===registry.activeId):registry.profiles.find(p=>p.id===id);
  if(!profile)throw Error('场景音色不存在。');
  let text;
  for(const relative of ['../assets/pet-voices/voice-pack.json','../assets/tone-jobs/playtime/results.json']){
   try{const pack=JSON.parse(await fs.readFile(path.join(this.root,relative),'utf8'));text??=pack.clips?.[clip]?.text;}catch{}
  }
  if(!text)return {cached:true,useOriginal:true};
  const file=path.join(this.root,'cache','scene-'+digest({profile,text})+'.wav');
  try{await fs.access(file);return {file,cached:true};}catch{}
  const key=digest({profile,text});
  // Rapid petting must not queue a paid request for every different line.
  if(!this.operations.has(key)&&this.operations.size)return {useOriginal:true,busy:true};
  if(!this.operations.has(key))this.operations.set(key,(async()=>{await(await this.get(profile)).run({text,file,pages:[text],volume:profile.volume});return {file,cached:false};})().finally(()=>this.operations.delete(key)));
  return this.operations.get(key);
 }
 async close(){if(this.closing)return this.closing;this.closed=true;this.closing=Promise.allSettled([...this.pool.values(),this.admin].filter(Boolean).map(w=>w.dispose())).then(()=>{this.pool.clear();this.admin=null;});return this.closing;}
}
