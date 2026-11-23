import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {balanceFailure,balanceRetryDelay} from '../balance-source.mjs';
import {atomicJson} from './config.mjs';

const wait=(ms,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(signal.reason);}signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
function readHarnessHost(file,now){
 try{
  const host=JSON.parse(fs.readFileSync(file,'utf8')),age=now-host?.at;
  if(host?.stopped!==true&&Number.isSafeInteger(host?.pid)&&host.pid>0
     &&Number.isFinite(host.at)&&age>=0&&age<10000)return host;
 }catch{}
 return null;
}
export function normalizeBalance(value,now=Date.now()){if(typeof value?.is_available!=='boolean'||!Array.isArray(value.balance_infos))throw Error('余额接口返回格式不正确。');const balances=value.balance_infos.map(x=>{if(!['CNY','USD'].includes(x.currency)||!/^\d+(\.\d+)?$/.test(x.total_balance))throw Error('余额金额无效。');return {currency:x.currency,total:x.total_balance,granted:x.granted_balance,toppedUp:x.topped_up_balance};});return {status:'ready',checkedAt:now,available:value.is_available,balances};}
export class CompanionAI{
 constructor(config,{fetchImpl=fetch,clock=Date.now,cacheIO=fs,writeCache=atomicJson}={}){
  Object.assign(this,{config,fetch:fetchImpl,clock,cacheIO,writeCache});this.history=new Map();this.balancePending=null;this.lastBalance=null;this.generation=0;this.balanceGeneration=0;this.balanceFailures=0;
 }
 invalidateChat(){this.generation++;this.history.clear();}
 invalidateBalance(){
  this.balanceGeneration++;this.balanceAbort?.abort(Error('余额来源已改变'));
  this.balancePending=null;this.lastGoodBalance=null;this.lastBalance=null;this.balanceFailures=0;
  this.activeBalanceSelection=this.balanceSelection();this.balanceCacheLoaded=true;
  this.balanceCleanupPending=true;this.clearBalanceCache();return this.balanceCacheError;
 }
 invalidate(){this.invalidateChat();this.invalidateBalance();}
 clearBalanceCache(){
  if(!this.balanceCleanupPending)return;
  if(!this.config.dir){this.balanceCleanupPending=false;return;}
  try{this.cacheIO.rmSync(path.join(this.config.dir,'balance-last-good.json'),{force:true});this.balanceCleanupPending=false;this.balanceCacheError=null;}
  catch{this.balanceCacheError='余额缓存清理暂未完成，将在下次读取时重试。';}
 }
 async api(route,body,signal){const cfg=this.config.read().chat,key=await this.config.key();if(!key)throw Error('请在“内部伙伴”中设置 AI 服务 API Key。');const base=cfg.baseUrl.replace(/\/$/,''),response=await this.fetch(base+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(90000),...(signal?[signal]:[])])});if(!response.ok)throw Error('AI 服务返回 HTTP '+response.status+'，请检查模型、权限和额度。');const text=await response.text();if(text.length>4*1024*1024)throw Error('AI 返回内容过长。');return JSON.parse(text);}
 async models(){const data=await this.api('/models');if(!Array.isArray(data.data))throw Error('模型列表格式无效。');return data.data.slice(0,300).map(m=>({id:m.id,vision:m.input_modalities?.includes('image')===true}));}
 async ask({system,text,maxTokens=320}){const cfg=this.config.read().chat;if(cfg.mode==='harness'||cfg.mode==='auto'&&!await this.config.key())return (await this.harness('chat',{text:system+'\n'+text,kind:'intent'})).reply;const value=await this.api('/chat/completions',{model:cfg.model,messages:[{role:'system',content:system},{role:'user',content:text}],max_tokens:maxTokens,temperature:0,stream:false});return value.choices?.[0]?.message?.content??'';}
 async balance({force=false}={}){
  const all=structuredClone(this.config.read()),selection=this.balanceSelection(all);
  if(this.activeBalanceSelection===undefined)this.activeBalanceSelection=selection;
  else if(this.activeBalanceSelection!==selection)this.invalidateBalance();
  this.clearBalanceCache();this.loadBalanceCache(selection);
  if(this.balancePending)return this.balancePending;
  const age=this.clock()-(this.lastBalance?.observedAt??this.lastBalance?.checkedAt);
  if(!force&&this.lastBalance&&age>=0&&age<(this.balanceFailures?balanceRetryDelay(this.balanceFailures):60000))return this.lastBalance;
  const generation=this.balanceGeneration,abort=new AbortController();this.balanceAbort=abort;
  const current=()=>generation===this.balanceGeneration&&selection===this.balanceSelection();
  const pending=(async()=>{
   try{
    const cfg=all.chat;
    if(all.balance?.source&&all.balance.source!=='legacy')return await this.harness('balance',all.balance,abort.signal);
    const key=cfg.mode==='harness'?'':await this.config.key();abort.signal.throwIfAborted();
    if(cfg.mode==='harness'||cfg.mode==='auto'&&!key){try{return await this.harness('balance',{},abort.signal);}catch(e){return {status:'not-configured',checkedAt:this.clock(),balances:[],...balanceFailure(e)};}}
    if(new URL(cfg.baseUrl).origin!=='https://api.deepseek.com')return {status:'unsupported',checkedAt:this.clock(),balances:[],message:'当前服务未声明余额协议；不会向其他站点发送 DeepSeek 密钥。'};
    if(!key)return {status:'not-configured',checkedAt:this.clock(),balances:[],message:'请在内部伙伴中配置 DeepSeek API Key；独立 API 模式不会自动改用 Harness。'};
    const r=await this.fetch(cfg.baseUrl.replace(/\/v1\/?$/,'')+'/user/balance',{headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
    if(!r.ok)throw Error('余额接口 HTTP '+r.status);return normalizeBalance(await r.json(),this.clock());
   }catch(e){return {status:'error',checkedAt:this.clock(),balances:[],...balanceFailure(e)};}
  })().then(value=>{
   if(!current())return {status:'superseded',checkedAt:this.clock(),balances:[],message:'余额账户设置已改变，请重新读取余额。'};
   let v=value;
   if(v.status==='ready'&&!v.stale){this.balanceFailures=0;this.lastGoodBalance=v;this.persistBalanceCache(v,selection);}
   else{
    this.balanceFailures=(this.balanceFailures??0)+1;
    const currentFailure=v.reason?{reason:v.reason,message:v.message}:balanceFailure(v);
    v={...v,...(v.status==='unsupported'?{}:currentFailure),observedAt:this.clock()};
    if(this.lastGoodBalance&&!['unsupported','superseded'].includes(v.status))
     v={...this.lastGoodBalance,stale:true,retained:true,observedAt:v.observedAt,...currentFailure};
   }
   if(this.balanceCacheError)v={...v,cacheWarning:this.balanceCacheError};
   this.lastBalance=v;return v;
  }).finally(()=>{if(this.balancePending===pending){this.balancePending=null;this.balanceAbort=null;}});
  this.balancePending=pending;return pending;
 }
 balanceSelection(c=this.config.read()){return createHash('sha256').update(JSON.stringify(c.balance?.source&&c.balance.source!=='legacy'?c.balance:{mode:c.chat.mode,baseUrl:c.chat.baseUrl,cacheEpoch:c.balance?.cacheEpoch})).digest('hex');}
 loadBalanceCache(selection=this.balanceSelection()){
  if(this.balanceCacheLoaded)return;this.balanceCacheLoaded=true;if(!this.config.dir)return;
  try{const file=path.join(this.config.dir,'balance-last-good.json');if(this.cacheIO.statSync(file).size>32768)return;const c=JSON.parse(this.cacheIO.readFileSync(file,'utf8')),v=c.value;
   if(c.selection===selection&&v?.status==='ready'&&!v.stale&&Number.isFinite(v.checkedAt)&&v.checkedAt<=this.clock()+60000&&Array.isArray(v.balances)&&v.balances.length&&v.balances.every(x=>['CNY','USD'].includes(x.currency)&&typeof x.total==='string'&&/^\d+(\.\d+)?$/.test(x.total)&&Number.isFinite(Number(x.total))))this.lastGoodBalance=v;
  }catch{}
 }
 persistBalanceCache(value,selection){
  if(!this.config.dir)return;
  try{this.writeCache(path.join(this.config.dir,'balance-last-good.json'),{selection,value});this.balanceCacheError=null;this.balanceCleanupPending=false;}
  catch{this.balanceCacheError='本次余额已读取，但缓存尚未保存；下次读取时会重试。';}
 }
 async balanceSources(){return this.harness('balance-sources',{});}
 async harness(operation,input,signal){
  signal?.throwIfAborted();
  const budget=['balance','balance-sources'].includes(operation)?10000:90000;
  const heartbeat=path.join(this.config.dir,'harness-host.json'),createdAt=this.clock();
  const host=readHarnessHost(heartbeat,createdAt);
  if(!host)throw Error('可选 Harness 接入未运行，请配置独立 AI 服务或在 Harness 中加载本项目插件。');
  const dir=path.join(this.config.dir,'harness-jobs'),id=randomUUID();
  const file=path.join(dir,id+'.json'),output=path.join(dir,id+'.result.json'),until=createdAt+budget;
  let nextHostCheck=createdAt+1000;
  atomicJson(file,{id,operation,input,createdAt,until,bridgeId:host.bridgeId});
  try{
   while(this.clock()<until){
    signal?.throwIfAborted();
    if(fs.existsSync(output)){
     const data=JSON.parse(fs.readFileSync(output,'utf8'));
     if(!data.ok)throw Error(data.error??'Harness 调用失败。');
     return data.value;
    }
    const now=this.clock();
    if(now>=nextHostCheck){
     const running=readHarnessHost(heartbeat,now);
     if(!running||running.pid!==host.pid||host.bridgeId&&host.bridgeId!==running.bridgeId)
      throw Error('Harness 接入已关闭，请重新发起请求。');
     nextHostCheck=now+1000;
    }
    await wait(100,signal);
   }
   throw Error('Harness 请求超时。');
  }finally{
   fs.rmSync(file,{force:true});
   fs.rmSync(output,{force:true});
  }
 }
 async reply(text,{kind='voice',signal,image,conversation='voice',systemAppend='',tools=[],toolExecutor}={}){const generation=this.generation;if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('请输入有效内容。');if(typeof systemAppend!=='string'||systemAppend.length>65536)throw Error('桌宠规则内容无效。');const cfg=this.config.read().chat,system=[cfg.system,systemAppend].filter(Boolean).join('\n\n');if(cfg.mode==='harness'||cfg.mode==='auto'&&!await this.config.key())return this.harness('chat',{text,kind,conversation,system,...(image?{image}:{})},signal);
  if(image&&!cfg.vision)throw Object.assign(Error('当前模型未开启看图能力，请选择支持图片的模型。'),{code:'visionUnsupported'});if(!cfg.model)throw Error('请先从模型列表选择对话模型。');const content=image?[{type:'text',text},{type:'image_url',image_url:{url:image}}]:text,history=this.history.get(conversation)??[];
  const messages=[{role:'system',content:system},...history,{role:'user',content}],allowed=new Set(tools.map(t=>t.function?.name).filter(Boolean));let reply,calls=0;
  for(let round=0;round<5;round++){
   signal?.throwIfAborted();if(generation!==this.generation)throw Error('AI 设置已更新，请重新发起对话。');
   const value=await this.api('/chat/completions',{model:cfg.model,messages,max_tokens:500,stream:false,...(tools.length?{tools}: {})},signal),message=value?.choices?.[0]?.message;
   if(!message?.tool_calls?.length){reply=message?.content;break;}
   if(!toolExecutor||round===4||calls+message.tool_calls.length>8)throw Error('桌宠动作工具调用超过本轮限制，请重试。');
   messages.push(message);
   for(const call of message.tool_calls){
    signal?.throwIfAborted();if(!allowed.has(call.function?.name)||typeof call.function?.arguments!=='string'||call.function.arguments.length>65536)throw Error('桌宠动作工具请求无效。');
    const args=JSON.parse(call.function.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw Error('桌宠动作参数无效。');
    const result=await toolExecutor(call.function.name,args,{signal});calls++;signal?.throwIfAborted();
    messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result).slice(0,65536)});
   }
  }
  if(typeof reply!=='string'||!reply.trim())throw Error('模型没有返回可朗读的文字。');signal?.throwIfAborted();if(generation!==this.generation)throw Error('AI 设置已更新，请重新发起对话。');this.history.set(conversation,[...history,{role:'user',content:text},{role:'assistant',content:reply}].slice(-12));if(this.history.size>20)this.history.delete(this.history.keys().next().value);return {ok:true,reply,withImage:!!image,provider:'internal-api'};
 }
}
