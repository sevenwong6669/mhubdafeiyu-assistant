import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeProbe} from '../harness-mhub-sync/startup.mjs';

const originFile=fileURLToPath(new URL('../harness-mhub-sync/source-origin.json',import.meta.url));
const localOrigin=value=>{const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('Invalid Harness origin');return u.origin;};
const auraState=result=>result?.reachable&&result.value?.ok===true&&result.value.config&&result.value.onebot;
// Task/balance source-origin now points to this plugin, not the host's HTTP
// listener. Discover only ports owned by Harness; never scan other services or
// change the source used by devices, balance and voice.
export class AuraBotLocator{
 constructor({discover=runtimeProbe,clock=Date.now}={}){Object.assign(this,{discover,clock});this.origin=null;this.nextAt=0;this.pending=null;this.failureReason=null;}
 find(probe,hint){
  if(this.pending)return this.pending;
  const task=(async()=>{
   const tried=new Set();
   const check=async origin=>{if(!origin||origin==='http://127.0.0.1:18782'||tried.has(origin))return null;tried.add(origin);try{const r=await probe(origin+'/aurabot/api/state',true);return auraState(r)?{origin,value:r.value}:null;}catch{return null;}};
   for(const origin of new Set([this.origin,hint])){const found=await check(origin);if(found){this.origin=origin;this.nextAt=0;this.failureReason=null;return found;}}
   this.origin=null;if(this.clock()<this.nextAt)return null;this.nextAt=this.clock()+30000;
   const runtime=await this.discover();
   const ports=[...new Set(runtime.harnessPorts??[])].filter(p=>Number.isInteger(p)&&p>0&&p<=65535&&p!==18782).slice(0,16);
   const found=(await Promise.all(ports.map(port=>check('http://127.0.0.1:'+port)))).filter(Boolean);
   this.failureReason=found.length>1?'aurabot-ambiguous':null;
   if(found.length!==1)return null;this.origin=found[0].origin;this.nextAt=0;return found[0];
  })().finally(()=>{if(this.pending===task)this.pending=null;});this.pending=task;return task;
 }
}
export async function qqConnection({stateDir,probe,read=fs.readFileSync,harnessOriginFile=originFile,locator=new AuraBotLocator()}){
  let provider='astrbot';
  try{const cfg=JSON.parse(read(path.join(stateDir,'qq-provider.json'),'utf8'));if(!['astrbot','aurabot'].includes(cfg.provider))throw Error('Unknown QQ provider');provider=cfg.provider;}
  catch(error){if(error.code!=='ENOENT')return {provider:'unknown',reachable:false,loginVerified:false,ready:false,detail:'QQ 接入配置无法读取'};}
  if(provider==='astrbot'){
    const value=await probe('http://127.0.0.1:6199/');
    return {provider,reachable:!!value.reachable,loginVerified:false,ready:false,detail:value.reachable?'接收服务可访问，登录状态未校验':'AstrBot 未连接。'};
  }
  try{
    let hint=null;try{hint=localOrigin(JSON.parse(read(harnessOriginFile,'utf8')).origin);}catch(error){if(error.code!=='ENOENT')throw error;}
    const found=await locator.find(probe,hint),value=found?.value;
    if(!value)return {provider,reachable:false,loginVerified:false,ready:false,detail:locator.failureReason==='aurabot-ambiguous'?'AuraBot 端点不唯一。':'Aurabot 暂不可访问'};
    const gatewayState=value.onebot.state;
    const connected=gatewayState==='connected',loginVerified=connected&&String(value.onebot.login?.uin??'')===String(value.config.botQQ??'')&&!!value.onebot.login?.uin;
    const enabled=value.config?.enabled===true,dryRun=value.config?.dryRun!==false;
    const connecting=gatewayState==='connecting'||gatewayState==='reconnecting';
    const noQQ=/没找到.*QQ\s*进程|未发现.*QQ\s*进程/i.test(typeof value.onebot.problem==='string'?value.onebot.problem:'');
    const detail=!enabled?'Aurabot 已停用'
      :dryRun?'Aurabot 试运行，不发送回复'
      :loginVerified?'Aurabot 已连接，QQ 登录已核对'
      :connected?'AuraBot 已连接网关，QQ 登录尚未核对'
      :noQQ?'未发现登录机器人账号的 QQ 进程。':connecting?'Aurabot 正在连接 QQ':'AuraBot 未连接 QQ 网关';
    return {provider,origin:found.origin,reachable:true,connected,loginVerified,enabled,dryRun,ready:loginVerified&&enabled&&!dryRun,detail};
  }catch{return {provider,reachable:false,loginVerified:false,ready:false,detail:'无法读取本机 Aurabot 连接状态'};}
}
