import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveControlPython} from '../../harness-mhub-sync/startup.mjs';

export const DEFAULT_COMPANION=Object.freeze({version:1,balance:{source:'legacy',provider:''},chat:{mode:'auto',baseUrl:'https://api.deepseek.com/v1',model:'',vision:false,system:'你是大肥鱼，一个亲切、机灵的桌面伙伴。自然简短地回答，不朗读内部标记。设备操作只能依据真实工具回执。'},image:{enabled:false,baseUrl:'https://api.openai.com/v1',model:'gpt-image-2.6-flare'},pet:{enabled:true,autoHide:true,modelFile:'',coreFile:'',displayId:''},asr:{modelDir:'',tier:'int8'},qq:{enabled:false,url:'ws://127.0.0.1:3001',owner:''},notices:{soundEnabled:true,soundStates:['SUCCESS','ERROR','APPROVAL']}});
export const revision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);
export function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}finally{try{fs.rmSync(tmp,{force:true});}catch{}}}
export function validateEndpoint(value,{websocket=false}={}){const u=new URL(value);if(u.username||u.password||u.search||u.hash||!(websocket?['ws:','wss:']:['http:','https:']).includes(u.protocol))throw Error('服务地址无效。');if((u.protocol==='http:'||u.protocol==='ws:')&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('非本机服务请使用加密连接。');return u.href.replace(/\/$/,'');}
export function validateConfig(value){
 const v=structuredClone(value);v.balance??={source:'legacy',provider:''};if(v.balance.cacheEpoch!==undefined&&!/^[a-f0-9-]{36}$/.test(v.balance.cacheEpoch))throw Error('余额缓存版本无效。');if(!['legacy','account','api'].includes(v.balance.source)||typeof v.balance.provider!=='string'||v.balance.provider.length>200||v.balance.source==='api'&&!v.balance.provider.trim())throw Error('余额来源配置无效。');v.image??=structuredClone(DEFAULT_COMPANION.image);if(v.version!==1||!['auto','api','harness'].includes(v.chat?.mode)||typeof v.chat.model!=='string'||v.chat.model.length>200||typeof v.chat.system!=='string'||v.chat.system.length>4000||typeof v.chat.vision!=='boolean')throw Error('AI 配置无效。');v.chat.baseUrl=validateEndpoint(v.chat.baseUrl);
 if(typeof v.image.enabled!=='boolean'||typeof v.image.model!=='string'||v.image.model.length>200||v.image.baseUrl!=='https://api.openai.com/v1')throw Error('当前设备生图仅支持已实现的官方 API 协议。');
 if(!v.pet||typeof v.pet.enabled!=='boolean'||typeof v.pet.autoHide!=='boolean'||['modelFile','coreFile','displayId'].some(k=>typeof v.pet[k]!=='string'||v.pet[k].length>2048))throw Error('桌宠配置无效。');
 if(!v.asr||!['int8','fp32','paraformer'].includes(v.asr.tier)||typeof v.asr.modelDir!=='string'||v.asr.modelDir.length>2048)throw Error('识别模型配置无效。');
 if(!v.qq||typeof v.qq.enabled!=='boolean'||!/^\d{0,14}$/.test(v.qq.owner))throw Error('QQ 配置无效。');v.qq.url=validateEndpoint(v.qq.url,{websocket:true});
 if(!v.notices||typeof v.notices.soundEnabled!=='boolean'||!Array.isArray(v.notices.soundStates)||v.notices.soundStates.some(s=>!['SUCCESS','ERROR','APPROVAL'].includes(s)))throw Error('提示音配置无效。');return v;
}
export class CompanionConfig{
 constructor(dir,{crypt}={}){this.dir=dir;this.file=path.join(dir,'settings.json');this.crypt=crypt??(async(value,mode)=>{const python=await resolveControlPython(),script=fileURLToPath(new URL('../../harness-mhub-sync/voice-chat/tts_secrets.py',import.meta.url));return new Promise((resolve,reject)=>{const p=execFile(python,['-X','utf8',script,mode],{windowsHide:true,timeout:5000,maxBuffer:16000},(error,out)=>error?reject(Error('密钥加密不可用，请检查 Python 和 Windows 账户。')):resolve(out.trim()));p.stdin.end(value);});});}
 read(){try{return validateConfig(JSON.parse(fs.readFileSync(this.file,'utf8').replace(/^\uFEFF/,'')));}catch(e){if(e.code==='ENOENT')return structuredClone(DEFAULT_COMPANION);throw Error('内部伙伴配置无法读取，原文件已保留。');}}
 snapshot(){const values=this.read();return {values,revision:revision(values),hasKey:fs.existsSync(path.join(this.dir,'api-key.json')),hasImageKey:fs.existsSync(path.join(this.dir,'image-key.json')),hasQqToken:fs.existsSync(path.join(this.dir,'qq-key.json'))};}
 async key(kind='api'){const file=path.join(this.dir,kind+'-key.json');let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return '';throw e;}const value=this.read(),origin=kind==='qq'?value.qq.url:new URL(kind==='image'?value.image.baseUrl:value.chat.baseUrl).origin;if(saved.origin!==origin)throw Error('密钥与服务地址不匹配，请重新保存。');return this.crypt(saved.encrypted,'unprotect');}
 async save({values,revision:expected,apiKey,qqToken,imageKey}){const current=this.read();if(expected!==revision(current))throw Error('设置已改变，请刷新后重试。');const next=validateConfig(values),pending=[];
  const source=v=>JSON.stringify({source:v.balance.source,provider:v.balance.provider});
  const legacyChanged=next.balance.source==='legacy'&&(current.chat.mode!==next.chat.mode||current.chat.baseUrl!==next.chat.baseUrl||apiKey!==undefined);
  if(source(current)!==source(next)||legacyChanged)next.balance.cacheEpoch=randomUUID();
  else if(current.balance.cacheEpoch)next.balance.cacheEpoch=current.balance.cacheEpoch;

  for(const [kind,key,origin,oldOrigin] of [['api',apiKey,new URL(next.chat.baseUrl).origin,new URL(current.chat.baseUrl).origin],['qq',qqToken,next.qq.url,current.qq.url],['image',imageKey,new URL(next.image.baseUrl).origin,new URL(current.image.baseUrl).origin]]){
   const file=path.join(this.dir,kind+'-key.json');if(key!==undefined&&(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key)))throw Error('密钥格式无效。');
   if(key===undefined&&origin!==oldOrigin&&fs.existsSync(file))throw Error('服务地址改变后，请重新输入对应密钥（空值可清除）。');
   if(key!==undefined)pending.push({file,value:key?{origin,encrypted:await this.crypt(key,'protect')}:null,previous:fs.existsSync(file)?fs.readFileSync(file):null});
  }
  if(expected!==revision(this.read()))throw Error('设置已改变，请刷新后重试。');
  try{for(const p of pending){if(p.value)atomicJson(p.file,p.value);else fs.rmSync(p.file,{force:true});}atomicJson(this.file,next);}catch(error){for(const p of pending){if(p.previous)fs.writeFileSync(p.file,p.previous);else fs.rmSync(p.file,{force:true});}throw error;}return this.snapshot();
 }
}
