// Subscription compatibility is optional. Standalone installations use the
// project's direct API adapter, without importing any AuraBot implementation.
import {isOfficialImageApi,officialImageRequest} from './official-image-api.mjs';

export const GIF_MODELS=['gpt-image-2.6-flare','gpt-image-2.6-sunburst'];
export function gifOptions(args,settings={}){
 const frame_count=args.frame_count??settings.gifDefaultFrames??64;
 const frame_duration_ms=args.frame_duration_ms??settings.gifDefaultFrameMs??50;
 if(!Number.isInteger(frame_count)||frame_count<2||frame_count>64)throw Error('GIF 帧数必须是 2～64 的整数。');
 if(!Number.isInteger(frame_duration_ms)||frame_duration_ms<20||frame_duration_ms>2000||frame_duration_ms%10)throw Error('每帧时长必须为 20～2000 毫秒，且是 10 的倍数。');
 if(args.size!==undefined&&args.size!=='auto')throw Error('当前 GIF 接法仅使用 size=auto。');
 if(args.n!==undefined&&args.n!==1)throw Error('每次只生成一份 GIF（n=1）。');
 return {output_format:'gif',frame_count,frame_duration_ms,size:'auto',n:1};
}
export function gifMetadata(buf){
 if(!Buffer.isBuffer(buf)||buf.length<14||!/^GIF8[79]a$/.test(buf.subarray(0,6).toString()))throw Error('服务端没有返回真正的 GIF，未当作动画发送。');
 let pos=13,delay=0,loop=null,trailer=false;const delays=[];
 const advance=n=>{if(!Number.isInteger(n)||n<0||pos+n>buf.length)throw Error('GIF 文件不完整。');pos+=n;};
 if(buf[10]&128)advance(3*2**((buf[10]&7)+1));
 const blocks=()=>{const out=[];while(pos<buf.length){const n=buf[pos++];if(!n)return Buffer.concat(out);const start=pos;advance(n);out.push(buf.subarray(start,pos));}throw Error('GIF 数据块不完整。');};
 while(pos<buf.length){const kind=buf[pos++];if(kind===0x3b){trailer=true;break;}
  if(kind===0x21){const type=buf[pos++];if(type===0xf9){if(buf[pos++]!==4)throw Error('GIF 控制块无效。');advance(4);delay=buf.readUInt16LE(pos-3)*10;if(buf[pos++]!==0)throw Error('GIF 控制块不完整。');}
   else if(type===0xff){const n=buf[pos++],start=pos;advance(n);const name=buf.subarray(start,pos).toString(),data=blocks();if(['NETSCAPE2.0','ANIMEXTS1.0'].includes(name)&&data.length>=3&&data[0]===1)loop=data.readUInt16LE(1);}
   else blocks();
  }else if(kind===0x2c){const start=pos;advance(9);const packed=buf[start+8];if(packed&128)advance(3*2**((packed&7)+1));advance(1);blocks();delays.push(delay);delay=0;if(delays.length>64)throw Error('GIF 超过本工具允许的 64 帧。');}
  else throw Error('GIF 包含无法识别的数据块。');
 }
 if(!trailer||!delays.length)throw Error('GIF 没有完整帧或结束标记。');
 const width=buf.readUInt16LE(6),height=buf.readUInt16LE(8);if(!width||!height)throw Error('GIF 尺寸无效。');
 return {width,height,frames:delays.length,frameDurationsMs:[...new Set(delays)],durationMs:delays.reduce((a,b)=>a+b,0),loop,infiniteLoop:loop===0,bytes:buf.length};
}
export function verifyGif(buf,options){
 const meta=gifMetadata(buf);
 if(meta.frames!==options.frame_count||meta.frameDurationsMs.length!==1||meta.frameDurationsMs[0]!==options.frame_duration_ms)throw Error('服务端返回的 GIF 帧数或时长不符合请求，已拒绝当作成功动画发送。');
 return meta;
}
function serviceError(status,body){
 const raw=body?.error?.message??body?.detail??body?.message??'';
 const message=typeof raw==='string'?raw:JSON.stringify(raw);
 if(/GIF output is not enabled/i.test(message))return Object.assign(Error('当前 Codex 订阅通道未开放原生 GIF 输出；本次未生成动画，也没有改用静态图。'),{code:'gif_not_enabled',status});
 const safe=message.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,350);
 return Object.assign(Error(`GIF 生成失败（HTTP ${status}）${safe?'：'+safe:''}`),{code:body?.error?.code??'gif_request_failed',status});
}
export async function generateNativeGif({config,auth,log,fetchImpl=fetch,prompt,options}){
 if(isOfficialImageApi(config)){
  const buf=await officialImageRequest({config,prompt,options,fetchImpl});
  return {buf,metadata:verifyGif(buf,options)};
 }
 if(config.provider!=='codex'||!GIF_MODELS.includes(config.codex?.model))throw Error('原生 GIF 需要选择 Codex 订阅与 GPT Image 2.6 模型。');
 if(typeof auth?.ensureAccess!=='function')throw Error('订阅生图兼容接法未配置。独立运行请使用 API 生图服务。');
 const account=await auth.ensureAccess();
 const response=await fetchImpl('https://chatgpt.com/backend-api/codex/images/generations',{method:'POST',headers:{authorization:'Bearer '+account.access,'content-type':'application/json',...(account.accountId?{'chatgpt-account-id':account.accountId}:{})},body:JSON.stringify({model:config.codex.model,prompt:[config.stylePrompt,prompt,'请生成原生动画 GIF，保持角色一致，动作连贯，默认无限循环且首尾平滑衔接。'].filter(Boolean).join('，'),...options}),signal:AbortSignal.timeout(300000),redirect:'error'});
 const data=await response.json();if(!response.ok)throw serviceError(response.status,data);
 const encoded=data?.data?.[0]?.b64_json;if(typeof encoded!=='string')throw Error('生图服务没有返回 GIF 数据。');const buf=Buffer.from(encoded,'base64');
 if(buf.length>80*1024*1024)throw Error('GIF 超过 80 MB，本次未向 QQ 发送。');
 return {buf,metadata:verifyGif(buf,options)};
}
