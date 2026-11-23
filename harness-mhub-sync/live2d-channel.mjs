// Compatibility interface, backed exclusively by this project's internal service.
import fs from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const hostFile=fileURLToPath(new URL('../mhub-community-assistant/state/companion/host.json',import.meta.url));
export function live2dChannel({file=hostFile,fetchImpl=fetch}={}){
 async function host(){let h;try{h=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw Error('请先启动迈从大肥鱼内部伙伴后台。');}if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(h.baseUrl)||h.api!=='/api/mhub-community/companion'||!/^[a-f0-9]{64}$/.test(h.token))throw Error('内部伙伴连接资料无效。');return h;}
 async function request(route,body,{timeout=5000,signal,fullRoute,fullBody}={}){const h=await host(),full=h.live2dApi==='/api/mhub-community/live2d'&&fullRoute,api=full?h.live2dApi:h.api;if(full&&fullBody!==undefined)body=fullBody;const r=await fetchImpl(h.baseUrl+api+'/'+(full?fullRoute:route),{method:body===undefined?'GET':'POST',headers:{'x-pet-token':h.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([AbortSignal.timeout(timeout),...(signal?[signal]:[])]),redirect:'error'});const data=await r.json();if(!r.ok||data.ok===false)throw Error(data.message||data.error||'内部伙伴调用未完成。');return data;}
 return {
  async authorized(token){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return false;const h=await host();return timingSafeEqual(Buffer.from(h.token),Buffer.from(token));},
  status:async()=>{const own=await request('state');const full=await host();return full.live2dApi==='/api/mhub-community/live2d'?{...own,...await request('state',undefined,{fullRoute:'ext/live2d/mhub-state'})}:own;},wake:()=>request('pet',{action:'show'},{fullRoute:'show',fullBody:{}}),launch:()=>request('pet',{action:'launch'},{fullRoute:'launch',fullBody:{}}),prepareRecognition:()=>request('asr-prepare',{},{fullRoute:'ext/live2d/mhub-asr-prepare'}),
  nativeCall:(id,action,options={})=>request('call',{id,action,...options},{fullRoute:'ext/live2d/mhub-native-call'}),watch:(on,owner)=>request('watch',{on,...(owner?{owner}:{})},{fullRoute:'ext/live2d/mhub-watch'}),call:(id,on)=>request('call',{id,action:on?'start':'stop'},{fullRoute:'ext/live2d/mhub-call',fullBody:{id,on}}),
  recognize:(wav,signal)=>request('asr',{wav:wav.toString('base64')},{timeout:65000,signal,fullRoute:'ext/live2d/mhub-asr'}),reply:(text,kind,signal)=>request('chat',{text,kind},{timeout:95000,signal,fullRoute:'ext/live2d/mhub-turn'}),
  refreshBalance:()=>request('balance-refresh',{},{timeout:15000}),
  device:(text,kind='voice')=>request('device-command',{text,kind}),communityContext:()=>request('community-context'),community:(text,id,signal)=>request('community',{text,id},{timeout:175000,signal}),
 };
}
