import fs from 'node:fs';
import path from 'node:path';
export function companionTools(stateDir){async function request(route,body){const h=JSON.parse(fs.readFileSync(path.join(stateDir,'companion/host.json'),'utf8'));if(h.baseUrl!=='http://127.0.0.1:18782'||h.api!=='/api/mhub-community/companion')throw Error('内部伙伴连接资料无效。');const r=await fetch(h.baseUrl+h.api+'/'+route,{method:body?'POST':'GET',headers:{'x-pet-token':h.token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});const v=await r.json();if(!r.ok)throw Error(v.error??'内部伙伴未完成操作。');return v;}
 const tool=(name,description,properties,required,execute)=>({name,description,parameters:{type:'object',properties,required,additionalProperties:false},timeoutMs:15000,output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute});
 return [tool('mhub_device_command','用户明确要求为键盘、音箱屏幕或神光同步生成/导入/播放图片动画、恢复默认大肥鱼主题时使用。text 必须为用户原话。内部会核对当前键盘、像素风和尺寸，再调用用户配置的图片 API。返回请求受理不代表生成或实物播放完成；随后用 mhub_companion_status 查询，禁止重复付费生成。',{text:{type:'string',minLength:1,maxLength:2000}},['text'],async a=>request('device-command',{text:a.text,kind:'harness'})),
 tool('mhub_companion_status','读取内部伙伴、生成任务、桌宠和本地识别状态，不生成、不接管硬件。',{},[],async()=>{const v=await request('state');return {provider:v.provider,online:v.online,asr:v.asr,task:v.task,deviceCommand:v.deviceCommand,watchStatus:v.watchStatus,qq:v.qq};}),
 tool('mhub_account_balance','读取本项目内部余额接口，缺少凭据时明确返回未配置。',{},[],()=>request('balance'))];
}
