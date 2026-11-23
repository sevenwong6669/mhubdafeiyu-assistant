import {captureIntent,checkIntent,cancelLocalIntent} from './device-intent.mjs?v=device-link-1';
// Client tools use AuraBot's existing DSH bridge. QQ keeps its owner checks;
// this adapter never delivers QQ messages or opens another hardware writer.
import {prepareDeviceAsset,resolveAssetPlan,detectCurrentKeyboard,DEVICE_PROFILES} from './device-assets.mjs?v=device-link-1';
import {readDeviceAsset,latestDeviceAsset,importRgbDraft,queueRgbAsset,queueSpeakerAsset} from './device-asset-import.mjs?v=device-link-1';

import {speakerMotionTool} from './speaker-motion.mjs?v=device-link-1';
import {defaultThemeTool} from './device-theme-tools.mjs?v=device-link-1';

export const HARNESS_DEVICE_TOOL_NAMES=['mhub_device_asset_plan','mhub_draw_device_asset','mhub_apply_device_asset','mhub_stop_device_animation','mhub_animate_speaker_asset','mhub_restore_dafeiyu_theme'];
const scope='harness:local';
const fields={
 prompt:{type:'string',description:'保留用户的颜色、动作与设备描述，例如给我的键盘做个红色火焰动画。'},
 target:{type:'string',enum:Object.keys(DEVICE_PROFILES),description:'我的键盘用keyboard或省略，每次实时识别；音箱小屏用speaker，全设备用sync。'},
 output_format:{type:'string',enum:['png','gif'],description:'动画/GIF用gif；静态图用png。未填写时按描述判断。'},
 frame_count:{type:'integer',minimum:2,maximum:16},
 frame_duration_ms:{type:'integer',minimum:20,maximum:2000,multipleOf:10},
 fit:{type:'string',enum:['cover','contain']},
};
function strict(args,keys){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!keys.includes(k)))throw Error('参数格式无效或含未知字段。');}
function normalized(args){return {...args,output_format:args.output_format??(/动画|动图|gif/i.test(args.prompt??'')?'gif':'png')};}

export function harnessDeviceTools(api,{effective,prepare=prepareDeviceAsset,detect=detectCurrentKeyboard,reader=readDeviceAsset,latest=latestDeviceAsset,importer=importRgbDraft,player=queueRgbAsset,speaker=queueSpeakerAsset,restore}={}){
 let generating=false;
 const tool=(name,description,properties,required,execute,timeoutMs=390000)=>({...api.defineTool({name,description,properties,required,render:(_a,value)=>[{type:'text',text:JSON.stringify(value)}],execute:async(args)=>{try{return await execute(args);}catch(error){return {ok:false,message:error.message,code:error.code};}}}),timeoutMs});
 async function apply(p,args,claim=captureIntent()){checkIntent(claim);
  if(args.activate!==undefined&&typeof args.activate!=='boolean'||args.upload_to_speaker!==undefined&&typeof args.upload_to_speaker!=='boolean')throw Error('播放参数无效。');
  if(args.name!==undefined&&(typeof args.name!=='string'||!args.name.trim()||args.name.length>40))throw Error('场景名称需为1～40字。');
  if(p.manifest.target==='speaker'){
   if(args.upload_to_speaker!==true)return {ok:false,asset_id:p.id,prepared:true,imported:false,activated:false,message:'小屏素材已保存；用户明确要求上传/上屏时设置upload_to_speaker=true，无需重新生成。'};
   const result=await speaker(p,{applyToken:claim.token});return {ok:true,...result,asset_id:p.id,prepared:true,displayed:true,message:'音箱上传和设备读回完成，实物效果仍以用户观察为准。'};
  }
  const imported=await importer(p,{name:args.name});checkIntent(claim);
  if(args.activate===false)return {ok:true,asset_id:p.id,...imported,activated:false,message:'已保存M HUB草稿，未切换灯效。'};
  try{const playback=await player(p,{applyToken:claim.token});return {ok:true,asset_id:p.id,imported:!!imported.imported,...playback,displayed:false,message:'已导入并请求播放；以activated和outputVerified判断输出，未冒充实物确认。余额条由独立模块控制。'};}
  catch(error){return {ok:false,asset_id:p.id,prepared:true,imported:!!imported.imported,activated:false,message:'素材已保留，播放未完成：'+error.message+'。请重试应用已有素材，不要重新生图。'};}
 }
 return [
  tool(HARNESS_DEVICE_TOOL_NAMES[0],'预检迈从设备素材尺寸与当前键盘型号，不生成、不收费、不改灯。键盘动画、音箱小屏、神光同步均用统一规格。',fields,['prompt'],async args=>{
   strict(args,Object.keys(fields));const plan=await resolveAssetPlan(normalized(args),detect);return {ok:true,paidCalls:0,deviceWrites:0,target:plan.target,detection:plan.detected,dimensions:{width:plan.spec.width,height:plan.spec.height},options:plan.options};
  },15000),
  tool(HARNESS_DEVICE_TOOL_NAMES[1],'为当前迈从键盘/音箱小屏/神光同步生成准确尺寸的PNG或GIF。用户说“给我的键盘做个红色火焰动画”时使用本工具，实时识别键盘，默认生成并导入、播放；只要文件则import_to_mhub=false。不要改成八秒灯效试用，不发QQ。调用会使用已配置的生图API额度，不自动重试。',{
   ...fields,import_to_mhub:{type:'boolean',description:'默认true；用户只要文件、不应用时false。'},activate:{type:'boolean',description:'默认true；只存M HUB草稿时false。'},upload_to_speaker:{type:'boolean',description:'仅用户明确要求音箱上屏时true。'},
  },['prompt'],async args=>{
   strict(args,[...Object.keys(fields),'import_to_mhub','activate','upload_to_speaker']);
   for(const key of ['import_to_mhub','activate','upload_to_speaker'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw Error('播放参数无效。');
   if(generating)return {ok:false,code:'device_generation_busy',message:'已有一份设备素材正在生成，请等待，不要重复付费。'};
   if(api.config().safeMode||api.config().modules?.imagegen?.enabled===false)throw Error('请先开启AuraBot生图扩展。');
   if(api.core.local?.active('image'))throw Error('当前是本地生图接管，请先选择官方API通道。');
   const claim=captureIntent();const {upload_to_speaker,...input}=normalized({...args,import_to_mhub:args.import_to_mhub??true});let p;
   generating=true;
   try{
    ({prepared:p}=await prepare(input,{config:effective().imageGen,scope,detect,log:api.log}));
    if(args.import_to_mhub===false)return {ok:true,asset_id:p.id,prepared:true,path:p.file,manifest:p.manifest,imported:false,activated:false,message:'设备素材已保存，没有发送QQ，也未更改灯效。'};
    try{return {path:p.file,manifest:p.manifest,...await apply(p,args,claim)};}
    catch(error){return {ok:false,asset_id:p.id,prepared:true,path:p.file,activated:false,message:'素材已保存，应用未完成：'+error.message+'。无需再次生成。'};}
   }finally{generating=false;}
  }),
  tool(HARNESS_DEVICE_TOOL_NAMES[2],'应用已生成的设备素材，不重新生图、不收费。省略asset_id使用本机最近素材（包含QQ/语音/客户端来源）；默认立即播放，activate=false仅保存草稿。音箱上屏需明确upload_to_speaker=true。',{
   asset_id:{type:'string'},name:{type:'string'},activate:{type:'boolean'},upload_to_speaker:{type:'boolean'},
  },[],async args=>{strict(args,['asset_id','name','activate','upload_to_speaker']);return apply(args.asset_id?reader(args.asset_id):latest(),args);},155000),
  tool(HARNESS_DEVICE_TOOL_NAMES[3],'停止当前通过大肥鱼播放的键盘或神光同步动画，恢复接管前灯效与独立余额条。不删除文件、不重新生图。',{},[],async args=>{strict(args,[]);cancelLocalIntent();return {ok:true,...await player(null,{stop:true})};},55000),
  speakerMotionTool(api,{local:true}),
  defaultThemeTool(api,{local:true,restore}),
 ];
}

export function registerHarnessDeviceAssets(api,options){
 if(typeof api.dshTool!=='function')return [];
 const tools=harnessDeviceTools(api,options);
 for(const tool of tools)api.dshTool(tool);
 return tools;
}
