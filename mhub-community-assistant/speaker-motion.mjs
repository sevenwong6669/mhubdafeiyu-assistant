import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {ASSET_ROOT,readDeviceAsset,latestDeviceAsset,queueSpeakerAsset} from './device-asset-import.mjs?v=device-link-1';
import {convertAsset} from './device-assets.mjs?v=device-link-1';

export const MOTION_PROPERTIES={asset_id:{type:'string',description:'已有音箱素材编号；不填使用当前来源最近素材。'},source_file:{type:'string',description:'已在本机QQ工作目录制作的PNG/GIF绝对路径，与asset_id二选一。'},duration_ms:{type:'integer',minimum:1200,maximum:12000,multipleOf:120},upload_to_speaker:{type:'boolean',description:'用户要求上传或播放时true；否则只制作文件。'}};
export function validateMotionArgs(args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(MOTION_PROPERTIES,k)))throw Error('横游参数无效。');
 if(args.asset_id!==undefined&&args.source_file!==undefined)throw Error('素材编号和本地文件只能选一个。');
 if(args.upload_to_speaker!==undefined&&typeof args.upload_to_speaker!=='boolean')throw Error('上传参数无效。');
 if(args.duration_ms!==undefined&&(!Number.isInteger(args.duration_ms)||args.duration_ms<1200||args.duration_ms>12000||args.duration_ms%120))throw Error('时长为1200～12000毫秒且必须是120的倍数。');
}
export async function prepareSpeakerMotion(args,{scope,sourceScope=scope,assetRoot=ASSET_ROOT,allowedRoots=[path.join(os.homedir(),'Aurabot/qq-chats'),ASSET_ROOT],convert=convertAsset,reader=readDeviceAsset,latest=latestDeviceAsset}={}){
 validateMotionArgs(args);if(!scope)throw Error('缺少素材来源。');
 let source,sourceAssetId;
 if(args.source_file!==undefined){
  if(typeof args.source_file!=='string'||!path.isAbsolute(args.source_file))throw Error('需要本地绝对路径。');
  source=fs.realpathSync(args.source_file);
  const allowed=allowedRoots.some(root=>{try{const relative=path.relative(fs.realpathSync(root),source);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}catch{return false;}});
  if(!allowed)throw Error('文件需位于QQ工作目录或已登记的设备素材目录，未读取其他文件。');
 }else{
  const p=args.asset_id?reader(args.asset_id,{base:assetRoot,chatId:sourceScope}):latest(sourceScope,{base:assetRoot});
  if(p.manifest.target!=='speaker')throw Error('请选择已有音箱素材，不使用键盘或神光同步图片。');
  source=p.file;sourceAssetId=p.id;
 }
 const stat=fs.statSync(source);if(!stat.isFile()||stat.size>16*1024*1024)throw Error('素材需为不超过16MB的PNG或GIF。');
 const bytes=fs.readFileSync(source),gif=bytes.subarray(0,6).toString('ascii');
 const ext=['GIF87a','GIF89a'].includes(gif)?'gif':bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'png':null;
 if(!ext)throw Error('仅支持实际的PNG或GIF文件。');
 const id=randomUUID(),dir=path.join(assetRoot,id);fs.mkdirSync(dir,{recursive:true});const master=path.join(dir,'master.'+ext);
 fs.writeFileSync(master,bytes,{flag:'wx'});
 fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({chatId:scope,target:'speaker',sourceAssetId,sourceName:path.basename(source),motion:'left-to-right',paidCalls:0,createdAt:Date.now()},null,2));
 await convert(master,path.join(dir,'prepared'),'speaker',undefined,'left-to-right',args.duration_ms??2400);
 return reader(id,{base:assetRoot,chatId:scope});
}
export function speakerMotionTool(api,{where,local=false,prepare=prepareSpeakerMotion,speaker=queueSpeakerAsset}={}){
 return {...api.defineTool({name:local?'mhub_animate_speaker_asset':'qq_animate_speaker_asset',description:'让已有鱼形象精确左进右出：屏幕左外逐渐游入，横穿256×32屏幕，从右侧完全游出，首尾空屏循环。程序控制位置，不重新付费生图。支持已有音箱asset_id，或QQ工作目录中自己写好的PNG/GIF source_file；用户要求上屏时upload_to_speaker=true，工具会登记、适配并上传，不要让用户手动导入M HUB。',properties:MOTION_PROPERTIES,required:[],render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}],execute:async args=>{
  try{
   if(!local&&(where?.chat?.kind!=='private'||!api.isOwner(String(where.chat.userId))||!api.core.hub.turnSendersAllOwner(where.sessionId)))throw Error('仅主人私聊可用。');
   const p=await prepare(args,{scope:local?'harness:local':where.chat.chatId,sourceScope:local?null:where.chat.chatId});
   const result=args.upload_to_speaker?await speaker(p):{};
   return {ok:true,asset_id:p.id,prepared:true,path:p.file,manifest:p.manifest,paidCalls:0,...result,message:args.upload_to_speaker?'横游动画已制作并交给原控制器上传；以设备回执判断上屏。':'横游动画已保存，可用同一工具配合upload_to_speaker=true或原导入工具上屏。'};
  }catch(error){return {ok:false,message:error.message,paidCalls:0};}
 }}),timeoutMs:155000};
}

export function registerSpeakerMotion(api){
 api.rule('音箱小屏要求鱼从左侧屏幕外游入、到右侧游出再循环时，可用qq_animate_speaker_asset对已有鱼形象做精确轨迹，不必反复付费重画。自己写好的本地GIF也用该工具的source_file参数登记和转换，主人要求上屏时upload_to_speaker=true；不要声称本地GIF不能上传或要求手动导入。工具未成功前不得说已上屏。普通生成工具对明确的左进右出描述也会自动做同一轨迹处理。');
 api.tool(where=>where.chat?.kind==='private'&&api.isOwner(String(where.chat.userId))?[speakerMotionTool(api,{where})]:[]);
}
