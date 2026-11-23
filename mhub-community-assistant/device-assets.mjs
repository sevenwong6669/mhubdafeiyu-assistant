import {runtime} from '../runtime-paths.mjs';
import {captureIntent,checkIntent,cancelLocalIntent} from './device-intent.mjs?v=device-link-1';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
// Read the versioned profile at module load, including after an AuraBot hot reload.
const catalog=JSON.parse(fs.readFileSync(new URL('device-asset-profiles.json',import.meta.url),'utf8'));
import {isOfficialImageApi,officialImageRequest} from './official-image-api.mjs';
import {generateNativeGif} from './native-gif.mjs';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import models from '../harness-mhub-sync/keyboard-models.json' with {type:'json'};
import {defaultThemeTool,DEFAULT_THEME_RULE} from './device-theme-tools.mjs?v=device-link-1';
import {ASSET_ROOT,readDeviceAsset,latestDeviceAsset,importRgbDraft,queueSpeakerAsset,queueRgbAsset} from './device-asset-import.mjs?v=device-link-1';

const root=path.dirname(fileURLToPath(import.meta.url));
export const DEVICE_PROFILES=catalog.profiles;
export const DEVICE_ASSET_RULE='用户明确要求为键盘灯效、GT75、Ace75、音箱小屏/K20GT、神光同步制作图片或GIF时使用qq_draw_device_asset；不要用普通生图交付方形母版。我的键盘必须每次实时识别，不猜型号。动画用gif，默认12帧×200毫秒，限制2～16帧。最终成品会直接发QQ并返回asset_id。用户说导入刚才的图片或GIF到M HUB时使用qq_import_device_asset，可省略asset_id选择本私聊最近的设备素材，不要重新生图，不要回答不能导入。用户要求导入或用到设备时，键盘和神光同步默认导入并activate=true立即播放；仅保存草稿时activate=false。播放复用现有控制器，outputVerified表示输出确认，不等于主人实物确认。说停止动画或恢复原灯效时用qq_stop_device_animation；音箱仅在用户明确要求上传/上屏时设置upload_to_speaker=true，由统一控制器完成。只生成时不自动导入；明确要求生成并导入可用import_to_mhub=true，要求点亮/应用/播放时同时activate=true。多个目标分开准备并说明份数。仅讨论设备、查状态不触发生图。prepared、sent、imported、displayed必须按工具返回分别说明，不得虚报上屏。';
export function speakerMotionInPrompt(prompt=''){return /左进右出|(?:从|由).{0,6}左.{0,20}(?:游|移|飘|走|穿|到).{0,15}右|左.{0,8}(?:游|移|飘|走|穿).{0,8}右/.test(prompt);}
export function targetInPrompt(prompt=''){
 const targets=new Set();if(/GT\s*75/i.test(prompt))targets.add('gt75');if(/Ace\s*75/i.test(prompt))targets.add('ace75');if(/音箱.{0,8}(屏幕|小屏)|K20\s*GT.{0,8}(屏幕|小屏)|小屏幕/i.test(prompt))targets.add('speaker');if(/神光同步|全设备灯效/i.test(prompt))targets.add('sync');
 if(targets.size>1)throw Error('本次包含多个设备目标，请分别制作，未付费生成。');return [...targets][0]??null;
}
export function isDeviceAssetRequest(prompt=''){if(/海报|产品图|实物|广告|宣传|摆拍/.test(prompt)&&!/灯效|灯光|屏幕|小屏|神光同步/.test(prompt))return false;return /键盘灯效|键盘.{0,20}(动图|灯光|动画|gif)|给.{0,8}键盘.{0,16}(做|画|生成|制作)|GT\s*75|Ace\s*75|音箱.{0,8}(屏幕|小屏)|K20\s*GT.{0,8}(屏幕|小屏)|神光同步|全设备灯效/i.test(prompt);}
const profileByModel={'GT 75':'gt75','Ace 75 8K':'ace75'};
export function selectCurrentKeyboard({keyboards,hardwareModels}){
 const ids=[...new Set(keyboards)];
 if(ids.length>1)throw Error('同时连接了多把键盘，请指定本次要制作的键盘。');
 if(!ids.length)throw Error('未检测到已连接的迈从键盘，请连接键盘后再生成。');
 const model=ids[0],target=profileByModel[model];
 if(!target)throw Error('当前键盘型号尚未适配，未付费生成。');
 if(!hardwareModels.includes(model))throw Error('键盘连接状态未能通过硬件核对，请唤醒或重连后重试。');
 return {model,target,checkedAt:Date.now()};
}
export async function detectCurrentKeyboard(){
 let snapshot;
 try{snapshot=await evaluateInMhub(async({models})=>{
  const m=await loadMhubModule(),store=m.c3(),connected=new Set(store.connectedDeviceIds??[]),keyboards=new Set();
  for(const scene of store.scenes??[])for(const d of scene.devices??[])if(d.type==='keyboard'&&connected.has(d.id))keyboards.add(d.id);
  const hardwareKeys=[...window.ALL_CZ_STATE.deviceStateMap.keys()];
  const hardwareModels=Object.entries(models).filter(([id,s])=>connected.has(id)&&hardwareKeys.some(d=>d.vendorId===s.vendorId&&d.productId===s.productId)).map(([id])=>id);
  for(const id of hardwareModels)keyboards.add(id);
  return {keyboards:[...keyboards],hardwareModels};
 },{models},4000);}catch{throw Error('暂时无法读取M HUB当前键盘，请恢复连接后重试；本次未付费生成。');}
 return selectCurrentKeyboard(snapshot);
}
export async function resolveAssetPlan(args,detect=detectCurrentKeyboard){
 const inferred=targetInPrompt(args.prompt),requested=args.target??inferred??'keyboard';
 if(inferred&&args.target&&args.target!==inferred&&!(args.target==='keyboard'&&['gt75','ace75'].includes(inferred)))throw Error('描述中的设备与工具目标不一致，未付费生成。');
 // Validate content before querying hardware; resolve again on every request, never cache the last keyboard.
 assetPlan({...args,target:requested});
 const detected=requested==='keyboard'?await detect():null;
 return {...assetPlan({...args,target:detected?.target??requested}),requestedTarget:requested,detected};
}
export function assetPlan({target,output_format='png',prompt,frame_count=12,frame_duration_ms=200}){
  const spec=DEVICE_PROFILES[target];
  if(!spec)throw Error('请选择 keyboard、gt75、ace75、speaker 或 sync。');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>30000)throw Error('素材描述无效。');
  if(!['png','gif'].includes(output_format))throw Error('素材只支持 PNG 或 GIF。');
  if(!Number.isInteger(frame_count)||frame_count<2||frame_count>16)throw Error('设备GIF使用2～16帧。');
  if(!Number.isInteger(frame_duration_ms)||frame_duration_ms<20||frame_duration_ms>2000||frame_duration_ms%10)throw Error('每帧使用20～2000毫秒，且为10的倍数。');
  const motionPrompt=target==='speaker'&&speakerMotionInPrompt(prompt)
    ?'横移由插件完成：母版把主体固定在横幅中间，允许原地摆尾等小动作，主体和附属像素不要分散到两端。':'';
  return {target,spec,prompt:[prompt,'设备素材规范：'+catalog.visualPrompt,spec.prompt,motionPrompt,'生成完整独立素材，不绘制产品模型或预览边框。',output_format==='gif'?'固定镜头，角色一致，动作连续，首尾衔接，无限循环。':''].filter(Boolean).join('\n'),
    options:{output_format,size:output_format==='gif'?spec.generation.gifSize:spec.generation.pngSize,n:1,...(output_format==='gif'?{frame_count,frame_duration_ms}:{})}};
}
export function convertAsset(source,destination,target,fit,motion,durationMs){
 return new Promise((resolve,reject)=>execFile(runtime.python,
 ['-X','utf8',path.join(root,'scripts/prepare-device-asset.py'),'--source',source,'--destination',destination,'--target',target,...(fit?['--fit',fit]:[]),...(motion?['--motion',motion]:[]),...(durationMs?['--duration-ms',String(durationMs)]:[])],
 {windowsHide:true,timeout:60000,maxBuffer:65536},(error,stdout)=>error?reject(Error('本地素材转换失败；原始素材已保留，请检查转换器环境。')):resolve(JSON.parse(stdout))));
}
export async function prepareDeviceAsset(args,{config,scope,gifGenerate=generateNativeGif,convert=convertAsset,detect=detectCurrentKeyboard,assetRoot=ASSET_ROOT,requestImage=officialImageRequest,log,onStage=()=>{}}={}){
 if(!args||Object.keys(args).some(k=>!['prompt','target','output_format','frame_count','frame_duration_ms','fit','import_to_mhub','activate'].includes(k)))throw Error('素材参数包含未知字段。');
 if(args.fit!==undefined&&!['cover','contain'].includes(args.fit)||args.import_to_mhub!==undefined&&typeof args.import_to_mhub!=='boolean')throw Error('素材适配参数无效。');
 if(args.activate!==undefined&&typeof args.activate!=='boolean'||args.activate&&!args.import_to_mhub)throw Error('点亮参数无效，需同时导入。');
 if(!config?.enabled||!isOfficialImageApi(config))throw Error('设备素材需要开启官方OpenAI API生图通道。');
 if(typeof scope!=='string'||!scope)throw Error('缺少素材来源。');
 onStage('checking');const plan=await resolveAssetPlan(args,detect),id=randomUUID(),dir=path.join(assetRoot,id);fs.mkdirSync(dir,{recursive:true});let source;
 try{
  onStage('generating');const buf=plan.options.output_format==='gif'?(await gifGenerate({config,prompt:plan.prompt,options:plan.options,log})).buf:await requestImage({config,prompt:plan.prompt,options:plan.options});
  source=path.join(dir,'master.'+plan.options.output_format);fs.writeFileSync(source,buf,{flag:'wx'});
  onStage('converting');const manifest=await convert(source,path.join(dir,'prepared'),plan.target,args.fit,plan.target==='speaker'&&speakerMotionInPrompt(args.prompt)?'left-to-right':undefined),detection=plan.detected??null;
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({requestedTarget:plan.requestedTarget,target:plan.target,detection,options:plan.options,chatId:scope,createdAt:Date.now()},null,2));
  return {id,plan,manifest,detection,prepared:readDeviceAsset(id,{base:assetRoot,chatId:scope})};
 }catch(error){if(source)error.masterPreserved=true;throw error;}
}
export function deviceAssetTool(api,where,{effective,gifGenerate=generateNativeGif,convert=convertAsset,detect=detectCurrentKeyboard,remember=()=>null,assetRoot=ASSET_ROOT,requestImage=officialImageRequest,importer=importRgbDraft,player=queueRgbAsset,speaker=queueSpeakerAsset}={}){
 const tool=api.defineTool({name:'qq_draw_device_asset',description:'生成准确尺寸的迈从设备PNG/GIF并把适配成品发QQ，返回asset_id供qq_import_device_asset导入。识别当前键盘；可按主人明确要求同时导入M HUB草稿。',
 properties:{prompt:{type:'string'},target:{type:'string',enum:Object.keys(DEVICE_PROFILES),description:'我的键盘用keyboard或省略，实时识别型号。音箱小屏用speaker，神光同步用sync。'},output_format:{type:'string',enum:['png','gif']},frame_count:{type:'integer',minimum:2,maximum:16},frame_duration_ms:{type:'integer',minimum:20,maximum:2000,multipleOf:10},fit:{type:'string',enum:['cover','contain'],description:'灯效默认cover铺满，人物完整优先可选contain保留比例补黑边。'},import_to_mhub:{type:'boolean',description:'键盘或神光同步要求生成并导入/应用时设true。'},activate:{type:'boolean',description:'生成并应用/点亮时设true；必须同时import_to_mhub=true。'},upload_to_speaker:{type:'boolean',description:'明确要求生成后上传音箱小屏时设true。'}},required:['prompt'],timeoutMs:390000,
 render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
 execute:async args=>{
  let source;
  try{
   if(where.chat?.kind!=='private'||!api.isOwner(String(where.chat.userId))||!api.core.hub.turnSendersAllOwner(where.sessionId))throw Error('设备素材仅限主人私聊制作。');
   if(api.core.local?.active('image'))throw Error('本地生图接口正在接管，请先选择官方API。');
   const {upload_to_speaker,...input}=args;
   if(upload_to_speaker!==undefined&&typeof upload_to_speaker!=='boolean'||upload_to_speaker&&(input.target??targetInPrompt(input.prompt))!=='speaker')throw Error('音箱上传参数与目标不一致。');
   const claim=captureIntent();const {id,plan,manifest,detection,prepared}=await prepareDeviceAsset(input,{config:effective().imageGen,scope:where.chat.chatId,gifGenerate,convert,detect,assetRoot,requestImage,log:api.log});
   let sent=false,painting=null,imported=null,importError=null,playback=null,screen=null;
   try{sent=!!await api.core.hub.sendSegments(where.chat.chatId,[{type:'image',data:{file:'base64://'+prepared.bytes.toString('base64')}}],`[设备素材 ${manifest.width}×${manifest.height}]`);if(sent)painting=remember(where.chat.chatId,prepared.file);}catch{}
   try{
    if(upload_to_speaker){checkIntent(claim);screen=await speaker(prepared,{applyToken:claim.token});}
    else if(args.import_to_mhub&&plan.target!=='speaker'){checkIntent(claim);imported=await importer(prepared);checkIntent(claim);if(args.activate)playback=await player(prepared,{applyToken:claim.token});}
   }catch(error){importError=error.message;}
   return {ok:!importError,asset_id:id,prepared:true,sent,imported:!!imported?.imported,activated:!!playback?.activated,outputVerified:!!playback?.outputVerified,uploaded:!!screen?.uploaded,displayed:!!screen?.displayed,message:`${detection?'已识别 '+detection.model+'。':''}${manifest.width}×${manifest.height}适配成品${sent?'已发QQ':'已保存，QQ未送达；不要重复生图'}。${screen?.displayed?'音箱已切到自定义动画，设备读回通过。':playback?.activated?'已导入并开始播放，可用qq_stop_device_animation恢复原灯效。':importError?(imported?.imported?'已导入 M HUB，但点亮未完成：':'素材已保存，应用未完成：')+importError+'。可用素材编号重试应用，无需重新生成。':imported?.imported?'已导入M HUB独立草稿，未播放。':'可用qq_import_device_asset应用，无需重新生成。'}`,detection,path:prepared.file,manifest,painting,mhub:imported,playback,screen};
  }catch(error){return {ok:false,message:error.message,...(source||error.masterPreserved?{masterPreserved:true}:{}),uploaded:false};}
 }});
 return {...tool,timeoutMs:390000};
}
export function registerDeviceAssets(api,options){
 api.rule(DEVICE_ASSET_RULE);
 api.rule('用户明确要求生成后直接上屏时，qq_draw_device_asset 传 target=speaker、upload_to_speaker=true。已经有素材时用 qq_import_device_asset，按用户指定的键盘、神光同步、音箱填写 target。工具返回已导入但点亮失败时，保留 asset_id 并重试应用已有素材。');
 api.rule(DEFAULT_THEME_RULE);
 api.tool(where=>where.chat?.kind==='private'&&api.isOwner(String(where.chat.userId))?[deviceAssetTool(api,where,options),deviceImportTool(api,where),deviceStopTool(api,where),defaultThemeTool(api,{where})]:[]);
 api.route('/ext/imagegen/device-profiles',async()=>({ok:true,...catalog}));
 api.route('/ext/imagegen/current-keyboard',async()=>{try{return {ok:true,...await detectCurrentKeyboard()};}catch(e){return {ok:false,message:e.message};}});
}
export function deviceImportTool(api,where,{base=ASSET_ROOT,importer=importRgbDraft,speaker=queueSpeakerAsset,player=queueRgbAsset}={}){
 return api.defineTool({name:'qq_import_device_asset',description:'把本私聊刚生成的设备PNG/GIF导入M HUB，不重新生图、不再次计费。键盘/神光同步默认导入并立即点亮，activate=false时仅存草稿。支持停止并恢复原灯效；音箱只有用户明确要求上传/上屏时设置upload_to_speaker=true，走原控制器。',properties:{asset_id:{type:'string',description:'设备素材UUID；省略时使用当前私聊内符合目标的最近素材'},target:{type:'string',enum:Object.keys(DEVICE_PROFILES),description:'用户指定键盘、神光同步、音箱时填写，避免误选其他设备的素材。'},name:{type:'string',description:'M HUB场景名称，最多40字'},upload_to_speaker:{type:'boolean'},activate:{type:'boolean',description:'键盘/神光同步默认true立即播放；主人只要草稿则false。'}},required:[],timeoutMs:155000,render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}],execute:async args=>{
  try{
   if(where.chat?.kind!=='private'||!api.isOwner(String(where.chat.userId))||!api.core.hub.turnSendersAllOwner(where.sessionId))throw Error('仅限主人私聊导入。');
   if(!args||Object.keys(args).some(k=>!['asset_id','target','name','upload_to_speaker','activate'].includes(k))||args.name!==undefined&&(typeof args.name!=='string'||!args.name.trim()||args.name.length>40)||args.upload_to_speaker!==undefined&&typeof args.upload_to_speaker!=='boolean')throw Error('导入参数无效。');
   if(args.activate!==undefined&&typeof args.activate!=='boolean')throw Error('点亮参数无效。');
   if(args.target!==undefined&&!Object.hasOwn(DEVICE_PROFILES,args.target)||args.upload_to_speaker&&args.target!==undefined&&args.target!=='speaker')throw Error('导入目标与音箱上传设置不一致。');
   const target=args.target??(args.upload_to_speaker?'speaker':undefined);
   const claim=captureIntent();const p=args.asset_id?readDeviceAsset(args.asset_id,{base,chatId:where.chat.chatId}):latestDeviceAsset(where.chat.chatId,{base,target});
   if(target&&(target==='keyboard'?!['gt75','ace75'].includes(p.manifest.target):target!==p.manifest.target))throw Error('素材与指定设备不匹配，未应用。');
   if(p.manifest.target==='speaker'){if(!args.upload_to_speaker)throw Error('这是音箱小屏素材；请明确要求上传音箱，再设置upload_to_speaker=true。');const result=await speaker(p,{applyToken:claim.token});return {ok:true,asset_id:p.id,imported:true,displayed:true,...result,message:'音箱点阵上传及设备读回通过，已切到自定义动画。'};}
   const result=await importer(p,{name:args.name});checkIntent(claim);if(args.activate!==false){try{const playback=await player(p,{applyToken:claim.token});return {ok:true,asset_id:p.id,imported:true,...playback,message:`已导入并播放「${playback.name}」，实时灯光输出已确认；说停止设备动画可恢复原灯效。`};}catch(error){return {ok:false,asset_id:p.id,imported:true,activated:false,message:'素材已导入，点亮未完成：'+error.message+'。无需重新生图。'};}}return {ok:true,asset_id:p.id,...result,message:`已导入M HUB场景「${result.name}」。这是独立草稿，当前灯光和余额条保持原样；可在M HUB中选择该场景播放。`};
  }catch(error){return {ok:false,imported:false,displayed:false,message:error.message};}
 }});
}

export function deviceStopTool(api,where,{player=queueRgbAsset}={}){
 return api.defineTool({name:'qq_stop_device_animation',description:'停止通过QQ应用的键盘/神光同步动画并恢复播放前灯效和余额条；不删除导入素材，不重新生图。',properties:{},required:[],timeoutMs:55000,render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}],execute:async args=>{try{
  if(where.chat?.kind!=='private'||!api.isOwner(String(where.chat.userId))||!api.core.hub.turnSendersAllOwner(where.sessionId))throw Error('仅限主人私聊操作。');
  if(!args||Object.keys(args).length)throw Error('停止参数无效。');cancelLocalIntent();return {ok:true,...await player(null,{stop:true}),message:'自定义设备动画已停止，恢复操作已完成。'};
 }catch(error){return {ok:false,message:error.message};}}});
}
