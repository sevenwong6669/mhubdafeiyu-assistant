import {runtime} from '../runtime-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';

const defaultRoot=fileURLToPath(new URL('../harness-mhub-sync/voice-chat/',import.meta.url));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
export const TTS_TYPES={local:{label:'本地 IndexTTS2',streaming:false,speed:false,instructions:false},breeze:{label:'BreezeBlue',streaming:true,speed:false,instructions:true},openai:{label:'OpenAI 兼容',streaming:true,speed:true,instructions:true},custom:{label:'自定义 HTTP',streaming:false,speed:true,instructions:true}};
export const TTS_SCENES={conversation:'聊天与电话',pet:'摸摸与主动陪伴',game:'游戏与奖励'};
const ID=/^[a-z][a-z0-9-]{0,63}$/;
export function ttsCredentialOrigin(profile){
 const url=new URL(profile.baseUrl);
 if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('带密钥的云端语音服务须使用HTTPS地址。');
 return url.origin;
}
export function validateTtsProfile(value){
 if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['id','name','type','baseUrl','model','voice','voiceName','speed','volume','instructions','streaming','authHeader','authScheme','extraBody','path','responsePath','responseType','favorites','timeoutSeconds'].includes(k)))throw Error('语音服务包含未知配置字段。');
 const p={id:value.id??'tts-'+randomUUID(),name:String(value.name??'').trim(),type:value.type,baseUrl:String(value.baseUrl??'').trim().replace(/\/+$/,''),model:String(value.model??'').trim(),voice:String(value.voice??'').trim(),voiceName:String(value.voiceName??'').trim(),speed:value.speed??1,volume:value.volume??100,instructions:String(value.instructions??''),streaming:!!value.streaming,authHeader:value.authHeader??(value.type==='breeze'?'xi-api-key':'Authorization'),authScheme:value.authScheme??(value.type==='breeze'?'raw':'bearer'),path:value.path??'/audio/speech',responseType:value.responseType??'audio',responsePath:value.responsePath??'audio_base64',extraBody:value.extraBody??{},favorites:value.favorites??[],timeoutSeconds:value.timeoutSeconds??45};
 if(!ID.test(p.id)||!p.name||p.name.length>60||!TTS_TYPES[p.type])throw Error('请选择服务类型并填写名称。');
 if(p.id==='local-default'&&p.type!=='local'||p.id==='breeze-default'&&p.type!=='breeze')throw Error('内置服务请保留原类型；可另外添加服务。');
 if(p.type!=='local'){
  let url;try{url=new URL(p.baseUrl);}catch{throw Error('API地址格式不正确。');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('API地址只支持HTTP/HTTPS，不要在地址中填写密钥。');
  if(!p.model||!p.voice||p.model.length>150||p.voice.length>150)throw Error('请填写模型ID和音色ID。');
 }
 if(typeof p.speed!=='number'||!Number.isFinite(p.speed)||p.speed<.25||p.speed>4||!Number.isInteger(p.volume)||p.volume<0||p.volume>100||!Number.isInteger(p.timeoutSeconds)||p.timeoutSeconds<5||p.timeoutSeconds>90)throw Error('语速、音量或超时超出范围。');
 if(!/^[a-zA-Z0-9-]{1,60}$/.test(p.authHeader)||!['bearer','raw','none'].includes(p.authScheme))throw Error('认证方式无效。');
 if(p.instructions.length>1000||p.voiceName.length>100||typeof p.path!=='string'||!/^\/[a-zA-Z0-9/_-]*$/.test(p.path)||p.path.startsWith('//')||!['audio','base64'].includes(p.responseType)||!/^\w+(\.\w+)*$/.test(p.responsePath))throw Error('高级接口参数无效。');
 if(!p.extraBody||Array.isArray(p.extraBody)||typeof p.extraBody!=='object'||JSON.stringify(p.extraBody).length>1500||/api[_-]?key|access[_-]?token|authorization|secret|password/i.test(JSON.stringify(p.extraBody)))throw Error('额外参数必须是JSON对象；密钥请填写专用输入框。');
 if(!Array.isArray(p.favorites)||p.favorites.length>20||p.favorites.some(x=>typeof x!=='string'||x.length>150))throw Error('常用音色列表无效。');
 if(p.type==='local')p.streaming=false;
 if(p.type==='custom')p.streaming=false;
 return p;
}
export function initialTtsState(config={}){
 const local=validateTtsProfile({id:'local-default',name:'本地语音（需配置）',type:'local',model:'IndexTTS2',voice:'user-reference',voiceName:'用户提供的参考音色'});
 const breeze=validateTtsProfile({id:'breeze-default',name:'BreezeBlue（需配置）',type:'breeze',baseUrl:'https://api.breeze.blue/v1',model:config.breeze?.modelId??'breeze-tts-2',voice:config.breeze?.voiceId??'YOUR_VOICE_ID',voiceName:config.breeze?.voiceName??'请选择自己的音色',instructions:config.breeze?.instructions??'',streaming:config.breeze?.streaming!==false});
 return {version:1,activeId:config.ttsProvider==='breezeblue'?'breeze-default':'local-default',profiles:[local,breeze],scenes:{conversation:'current',pet:'cache',game:'cache'},fallback:{enabled:false,profileId:'local-default'}};
}
export class TtsServiceStore{
 constructor({root=defaultRoot,fetchImpl=fetch,secretImpl}={}){this.root=root;this.file=path.join(root,'tts-services.json');this.fetch=fetchImpl;this.secret=secretImpl??((value)=>new Promise((resolve,reject)=>{const child=execFile(runtime.python,['-X','utf8',path.join(defaultRoot,'tts_secrets.py'),'protect'],{windowsHide:true,timeout:5000,maxBuffer:32000},(e,out)=>e?reject(Error('密钥加密失败。')):resolve(out));child.stdin.end(value);}));}
 load(){if(fs.existsSync(this.file)){const d=read(this.file);if(d.version!==1||!Array.isArray(d.profiles)||!d.profiles.length||d.profiles.length>20)throw Error('语音服务配置格式不正确，原文件已保留。');d.profiles=d.profiles.map(validateTtsProfile);if(!d.profiles.some(p=>p.id===d.activeId))throw Error('当前语音服务不存在。');return d;}return initialTtsState(fs.existsSync(path.join(this.root,'config.json'))?read(path.join(this.root,'config.json')):{});}
 hasKey(id){return fs.existsSync(path.join(this.root,'secrets/tts-'+id+'.dpapi'))||id==='breeze-default'&&fs.existsSync(path.join(this.root,'secrets/breeze-key.dpapi'));}
 assertCredentialTarget(profile){
  if(profile.type==='local'||profile.authScheme==='none')return;
  const saved=this.load().profiles.find(p=>p.id===profile.id);
  if(!saved||ttsCredentialOrigin(saved)!==ttsCredentialOrigin(profile))throw Error('服务地址已改变，请先保存地址并重新输入该服务的API Key。');
  const file=path.join(this.root,'secrets/tts-'+profile.id+'.dpapi');
  if(fs.existsSync(file)){
   const raw=fs.readFileSync(file,'utf8').trim();
   if(raw.startsWith('{')){
    const binding=JSON.parse(raw);
    if(binding.id!==profile.id||binding.origin!==ttsCredentialOrigin(profile)||typeof binding.encrypted!=='string')throw Error('此密钥绑定到原服务地址，请重新输入API Key。');
   }
  }
 }
 snapshot(){const data=this.load();let checks={};try{checks=read(path.join(this.root,'tts-checks.json'));}catch{}return {...data,revision:hash(data),profiles:data.profiles.map(p=>({...p,hasKey:this.hasKey(p.id),capabilities:TTS_TYPES[p.type],check:checks[p.id]??null})),types:TTS_TYPES};}
 commit(data,revision){const old=this.load();if(revision!==hash(old))throw Error('语音配置已在其他页面修改，请刷新后重试。');fs.mkdirSync(path.join(this.root,'tts-backups'),{recursive:true});atomic(path.join(this.root,'tts-backups',Date.now()+'-'+randomUUID()+'.json'),old);atomic(this.file,data);return this.snapshot();}
 async save({profile,revision,apiKey,clearKey=false}){
  if(typeof clearKey!=='boolean')throw Error('清除密钥选项格式不正确。');
  const p=validateTtsProfile(profile),data=this.load();if(revision!==hash(data))throw Error('语音配置已在其他页面修改，请刷新后重试。');
  if(apiKey!==undefined&&(typeof apiKey!=='string'||apiKey.length>4096||/[\r\n]/.test(apiKey)))throw Error('API Key格式不正确。');
  if(p.type==='local'&&(apiKey||clearKey))throw Error('本地服务不使用API Key。');
  if(clearKey&&apiKey)throw Error('不能同时替换和清除密钥。');
  if(clearKey&&p.id==='breeze-default')throw Error('请替换该服务密钥；原BreezeBlue密钥由旧配置保留。');
  const previousProfile=data.profiles.find(x=>x.id===p.id);
  if(p.type!=='local'&&p.authScheme!=='none')ttsCredentialOrigin(p);
  if(previousProfile&&this.hasKey(p.id)&&!apiKey&&!clearKey&&ttsCredentialOrigin(previousProfile)!==ttsCredentialOrigin(p))throw Error('服务地址已改变，请同时重新输入API Key。');
  const encrypted=apiKey?await this.secret(apiKey):null;
  if(revision!==hash(this.load()))throw Error('语音配置已在其他页面修改，请刷新后重试。');
  if(!data.profiles.some(x=>x.id===p.id)&&data.profiles.length>=20)throw Error('最多保存20个语音服务。');
  const secretFile=path.join(this.root,'secrets/tts-'+p.id+'.dpapi'),previous=fs.existsSync(secretFile)?fs.readFileSync(secretFile):null;
  // Secret writes happen only after validating the revision and all public fields.
  try{
   if(encrypted)atomic(secretFile,{version:1,id:p.id,origin:ttsCredentialOrigin(p),encrypted});
   if(clearKey&&fs.existsSync(secretFile))fs.unlinkSync(secretFile);
   const i=data.profiles.findIndex(x=>x.id===p.id);if(i<0)data.profiles.push(p);else data.profiles[i]=p;
   return {message:'服务配置已保存；点击“设为当前使用”应用。',state:this.commit(data,revision)};
  }catch(error){if(previous){const tmp=secretFile+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,previous,{mode:0o600});fs.renameSync(tmp,secretFile);}else if(encrypted)fs.rmSync(secretFile,{force:true});throw error;}
 }
 async settings({revision,scenes,fallback}){
  const data=this.load(),ids=new Set(data.profiles.map(p=>p.id));
  if(scenes){for(const [key,value] of Object.entries(scenes)){if(!Object.hasOwn(TTS_SCENES,key)||!(ids.has(value)||value==='current'||key!=='conversation'&&value==='cache'))throw Error('场景分配无效。');}data.scenes={...data.scenes,...scenes};}
  if(fallback){if(typeof fallback.enabled!=='boolean'||!ids.has(fallback.profileId)||data.profiles.find(p=>p.id===fallback.profileId).type!=='local')throw Error('回退服务必须是已配置的本地服务。');data.fallback={enabled:fallback.enabled,profileId:fallback.profileId};}
  const state=this.commit(data,revision);let applied=false;
  try{const r=await this.fetch('http://127.0.0.1:18780/tts/reload',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(90000)});applied=r.ok;}catch{}
  return {message:applied?'场景分配已保存并应用。':'设置已保存；当前语音未就绪或正忙，空闲后点击“重新应用音色”生效。',state,applied};
 }
 async apply({id,revision}){
  const data=this.load();if(!data.profiles.some(p=>p.id===id))throw Error('没有这个语音服务。');
  let runtime;try{runtime=await(await this.fetch('http://127.0.0.1:18780/status',{signal:AbortSignal.timeout(2000)})).json();}catch{}
  if(runtime&&(['dialing','incoming','connecting','connected'].includes(runtime.phone?.phase)||runtime.request))throw Error('请在当前对话或电话结束后切换音色。');
  const selected=data.profiles.find(p=>p.id===id);if(selected.type!=='local'&&selected.authScheme!=='none'&&!this.hasKey(id))throw Error('请先保存这个服务的API Key。');
  const previousId=data.activeId;data.activeId=id;const state=this.commit(data,revision);
  if(!runtime)return {message:'已设为当前服务，启动语音后生效。',applied:false,state};
  try{
  const response=await this.fetch('http://127.0.0.1:18780/tts/reload',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(90000)});const result=await response.json();
  if(!response.ok)throw Error('选择已保存，但合成服务尚未应用：'+(result.error??'请重试'));
  }catch(error){
   const current=this.snapshot();
   if(current.revision===state.revision){const restore=this.load();restore.activeId=previousId;this.commit(restore,current.revision);
    await this.fetch('http://127.0.0.1:18780/tts/reload',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(90000)}).catch(()=>{});
   }
   throw Error('音色应用失败，已保留原选择：'+error.message);
  }
  return {message:'音色已应用；语音识别和麦克风保持运行。',applied:true,state};
 }
 remove({id,revision}){const data=this.load();if(['local-default','breeze-default'].includes(id)||data.activeId===id||Object.values(data.scenes).includes(id)||data.fallback.profileId===id)throw Error('内置服务、当前服务或已分配的服务不能删除。');if(!data.profiles.some(p=>p.id===id))throw Error('没有这个语音服务。');data.profiles=data.profiles.filter(p=>p.id!==id);const state=this.commit(data,revision);fs.rmSync(path.join(this.root,'secrets/tts-'+id+'.dpapi'),{force:true});return {state,message:'服务已删除。'};}
 async action(args){const {operation,...values}=args;if(operation==='save')return this.save(values);if(operation==='settings')return this.settings(values);if(operation==='apply')return this.apply(values);if(operation==='remove')return this.remove(values);return this.runtime(operation,values);}
 async runtime(operation,{id,profile,text}={}){
  if(!['test','models','voices','preview'].includes(operation))throw Error('未知语音操作。');
  // Drafts never include a plaintext key here. Save the secret first.
  const p=profile?validateTtsProfile(profile):this.load().profiles.find(x=>x.id===id);if(!p)throw Error('请先选择服务。');
  this.assertCredentialTarget(p);
  let response;try{response=await this.fetch('http://127.0.0.1:18780/tts/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,profile:p,text}),signal:AbortSignal.timeout(operation==='preview'?190000:15000)});}catch(error){throw Error(error.name==='TimeoutError'?'语音服务等待超时；未自动重试，请检查状态。':'语音服务尚未连接，请先启动语音并等待模型就绪。');}
  const result=await response.json();if(!response.ok)throw Error(result.error??'语音服务未完成操作。');
  if(operation==='test'){let checks={};try{checks=read(path.join(this.root,'tts-checks.json'));}catch{}checks[p.id]={at:Date.now(),message:result.message,verified:result.verified===true};atomic(path.join(this.root,'tts-checks.json'),checks);}
  return result;
 }
}
