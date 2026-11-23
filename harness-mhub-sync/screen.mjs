import {runtime} from '../runtime-paths.mjs';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
const ROOT=new URL('./',import.meta.url);
let residentClip,clockInSlot=false;
export function rememberResident(clip){residentClip=clip;}
export async function displayClock(spec,color){
  const binary=await new Promise((resolve,reject)=>{
    const child=execFile(runtime.python,
      ['-X','utf8',fileURLToPath(new URL('render-clock.py',ROOT))],
      {windowsHide:true,timeout:5000,maxBuffer:8192},(error,out)=>error?reject(error):resolve(Buffer.from(out.trim(),'base64')));
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(spec));
  });
  if(binary.length!==1024)throw Error('时间页点阵尺寸异常');
  clockInSlot=true;
  const result=await upload({binary,frames:1,delay:1000,color,clock:true});
  if(result.frames!==1||result.bytes!==1024||result.crc32!==crc32(binary))throw Error('时间页点阵读回校验失败');
  return result;
}
export async function screenSnapshot(){
  return evaluateInMhub(async()=>{
    const m=await loadMhubModule(),device=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
    if(!device)throw Error('K20 GT is disconnected');
    const id=device.logicalDeviceId;
    return {screen:(await m.de.getK20GtScreenState(id)).screenState,
      image:await m.de.getK20GtScreenImageStatus(id,{theme:8,index:1}),
      imageName:(await m.de.getK20GtCustomImageName(id)).name};
  });
}
async function upload({binary,frames,delay,color,screen,restore=false,hideDuringUpload=false,clock=false}){
  return evaluateInMhub(async p=>{
    if(![1,2,12,30].includes(p.frames)||(!p.restore&&p.frames===30))throw Error('Unexpected image frame count');
    const m=await loadMhubModule(),device=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
    if(!device)throw Error('K20 GT is disconnected');
    const id=device.logicalDeviceId,bytes=Uint8Array.from(atob(p.base64),c=>c.charCodeAt(0));
    if(bytes.length!==p.frames*1024)throw Error('Unexpected image dimensions');
    if(p.clock)window.__dafeiyuScreenWriteUntil=Date.now()+25000;
    try{
    if(p.hideDuringUpload)await m.de.setK20GtScreenState(id,{enabled:false,color:p.color||p.screen?.color,mode:0,theme:8,index:1});
    const start=performance.now();
    const result=await m.de.uploadK20GtScreenImage(id,{theme:8,index:1,width:256,height:32,
      frames:Array.from({length:p.frames},(_,i)=>bytes.slice(i*1024,(i+1)*1024)),delay:p.delay});
    if(!result.success)throw Error('K20 GT rejected the image');
    const original=p.screen;
    const settings=p.restore?{enabled:original.enabled,color:original.color,mode:original.mode,
      theme:original.theme,index:original.themeStates?.[original.theme]?.index??0}:
      {enabled:true,color:p.color,mode:0,theme:8,index:1};
    window.__dafeiyuScreenExpected={...settings,at:Date.now()};await m.de.setK20GtScreenState(id,settings);
    const actual=await m.de.getK20GtScreenImageStatus(id,{theme:8,index:1});
    if(!p.restore&&actual.imageCount===p.frames&&actual.imageBytes===bytes.length&&result.crc32===p.crc32){
      const name='DFY:'+(p.clock?'clock:':'')+p.crc32.toString(16);
      await m.de.setK20GtCustomImageName(id,name);
      if((await m.de.getK20GtCustomImageName(id)).name!==name)throw Error('音箱素材归属标记读回失败');
    }
    return {durationMs:Math.round(performance.now()-start),success:true,frames:actual.imageCount,
      bytes:actual.imageBytes,crc32:result.crc32};
    }finally{
      if(p.clock)window.__dafeiyuScreenWriteUntil=Date.now()+350;
    }
  },{base64:binary.toString('base64'),crc32:crc32(binary),frames,delay,color,screen,restore,hideDuringUpload,clock},frames>=12?120000:25000);
}
export async function installResident(clip){
  if(clip&&!/^[a-z_]+$/.test(clip.id))throw Error('Invalid resident animation ID');
  const meta=clip??JSON.parse(await fs.readFile(new URL('assets/resident.json',ROOT),'utf8'));
  const binary=await fs.readFile(new URL(clip?'assets/residents/'+clip.id+'.bin':'assets/resident.bin',ROOT));
  if(meta.frames!==12||binary.length!==12288)throw Error('Unexpected resident animation');
  const previous=await screenSnapshot();
  try{
    const result=await upload({binary,frames:12,delay:meta.delay,color:[70,150,255],hideDuringUpload:true});
    if(result.frames!==12||result.bytes!==binary.length||result.crc32!==meta.crc32)throw Error('音箱动画上传校验失败');
    rememberResident(clip);clockInSlot=false;
    return result;
  }catch(error){
    const {enabled,color,mode,theme,themeStates}=previous.screen;
    await evaluateInMhub(async settings=>{
      const m=await loadMhubModule(),device=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
      if(device)await m.de.setK20GtScreenState(device.logicalDeviceId,settings);
    },{enabled,color,mode,theme,index:themeStates?.[theme]?.index??0}).catch(()=>{});
    throw error;
  }
}
export async function displayResident(color){
  if(clockInSlot)await installResident(residentClip);
  return evaluateInMhub(async({color})=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT is disconnected');
    const start=performance.now();window.__dafeiyuScreenExpected={enabled:true,mode:0,theme:8,index:1,at:Date.now()};await m.de.setK20GtScreenState(d.logicalDeviceId,{enabled:true,color,mode:0,theme:8,index:1});
    return {durationMs:Math.round(performance.now()-start),mode:'animation'};
  },{color});
}
export async function tintResident(color){
  if(clockInSlot)return displayResident(color);
  return evaluateInMhub(async({color})=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT is disconnected');
    const start=performance.now();await m.de.setK20GtScreenColor(d.logicalDeviceId,color);
    return {durationMs:Math.round(performance.now()-start),mode:'animation'};
  },{color});
}
export async function displayText(text,color,options={},evaluate=evaluateInMhub){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>48)throw Error('Unexpected screen text');
  const style={type:options.scroll?1:0,font:0,fontSize:options.fontSize??1,align:options.scroll?0:1,direction:0,animation:options.scroll?1:0,scroll:options.scroll?1:0};
  if(![0,1].includes(style.fontSize))throw Error('Unexpected text size');
  return evaluate(async({text,color,style})=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT is disconnected');
    const id=d.logicalDeviceId,start=performance.now();
    window.__dafeiyuScreenWriteUntil=Date.now()+300;
    await m.de.setK20GtScreenText(id,{...style,text});
    window.__dafeiyuScreenExpected={enabled:true,mode:1,theme:8,index:1,at:Date.now()};await m.de.setK20GtScreenState(id,{enabled:true,color,mode:1,theme:8,index:1});
    const actual=(await m.de.getK20GtScreenText(id)).text;
    if(actual.text!==text)throw Error('Screen text readback differs');
    const animation=actual.animation??actual.scroll??0;
    if(actual.type!==style.type||actual.fontSize!==style.fontSize||animation!==style.animation)throw Error('Screen text style readback differs');
    return {durationMs:Math.round(performance.now()-start),mode:'text',text:actual.text,type:actual.type,fontSize:actual.fontSize,animation};
  },{text,color,style});
}
export async function textSnapshot(){
  return evaluateInMhub(async()=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT is disconnected');
    return (await m.de.getK20GtScreenText(d.logicalDeviceId)).text;
  });
}
// Captions only touch the text preset and screen mode. They can temporarily
// overlay an unrelated GIF without acquiring or rewriting its image slot.
export async function captureCaptionScreen(){
  return evaluateInMhub(async()=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
    if(!d)throw Error('K20 GT is disconnected');
    const id=d.logicalDeviceId,s=(await m.de.getK20GtScreenState(id)).screenState;
    const screen={enabled:s.enabled,mode:s.mode,theme:s.theme,index:s.themeStates?.[s.theme]?.index??0,color:s.color};
    return {id,screen,text:(await m.de.getK20GtScreenText(id)).text};
  });
}
export async function restoreCaptionScreen(backup,caption){
  return evaluateInMhub(async({backup,caption})=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
    if(!d)throw Error('K20 GT is disconnected');
    const id=d.logicalDeviceId;
    if(id!==backup.id)return {restored:false};
    const s=(await m.de.getK20GtScreenState(id)).screenState;
    const current={enabled:s.enabled,mode:s.mode,theme:s.theme,index:s.themeStates?.[s.theme]?.index??0,color:s.color};
    const text=(await m.de.getK20GtScreenText(id)).text;
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const overlay={enabled:true,mode:1,theme:8,index:1,color:[70,150,255]};
    if(text.text!==caption||!same(current,overlay)&&!same(current,backup.screen))return {restored:false};
    await m.de.setK20GtScreenText(id,backup.text);
    window.__dafeiyuScreenExpected={...backup.screen,at:Date.now()};
    await m.de.setK20GtScreenState(id,backup.screen);
    return {restored:true};
  },{backup,caption});
}
export async function restoreText(text){
  if(!text)return;
  return evaluateInMhub(async({text})=>{
    const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT is disconnected');
    await m.de.setK20GtScreenText(d.logicalDeviceId,text);return {restored:true};
  },{text});
}
export async function showCard(state,{frameCount=2}={}){
  if(!/^(IDLE|THINKING|WORKING|WAITING|SUCCESS|ERROR)$/.test(state.state))throw Error('Unknown Harness state');
  const frame=await fs.readFile(new URL('assets/'+state.state+'.bin',ROOT));
  if(![1,2].includes(frameCount)||frame.length!==1024)throw Error('Unexpected screen card');
  const binary=Buffer.concat(Array.from({length:frameCount},()=>frame));
  const color=state.color.slice(1).match(/../g).map(x=>parseInt(x,16));
  return upload({binary,frames:frameCount,delay:200,color});
}
export async function reactivateCard(color){
  return evaluateInMhub(async({color})=>{
    const m=await loadMhubModule(),device=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
    if(!device)throw Error('K20 GT is disconnected');
    const id=device.logicalDeviceId;
    await m.de.setK20GtScreenState(id,{enabled:false,color,mode:0,theme:8,index:1});
    await new Promise(r=>setTimeout(r,250));
    await m.de.setK20GtScreenState(id,{enabled:true,color,mode:0,theme:8,index:1});
    return (await m.de.getK20GtScreenState(id)).screenState;
  },{color});
}
export async function restoreScreen(snapshot){
  // Older sessions recorded only image dimensions. They cannot prove that a
  // bundled factory binary contains the user's previous image.
  if(snapshot?.verifiedImage?.crc32!==1426849065||snapshot.verifiedImage.bytes!==30720){
    if(snapshot?.text)await restoreText(snapshot.text);
    if(snapshot?.screen)return evaluateInMhub(async({screen})=>{
      const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');
      if(!d)throw Error('K20 GT is disconnected');
      await m.de.setK20GtScreenState(d.logicalDeviceId,{enabled:screen.enabled,color:screen.color,mode:screen.mode,theme:screen.theme,index:screen.themeStates?.[screen.theme]?.index??0});
      return {restored:true,imagePreserved:true};
    },{screen:snapshot.screen});
    throw Error('音箱原图备份尚未验证，已保留当前图片');
  }
  const binary=await fs.readFile(new URL('./backup-image.bin',ROOT));
  if(binary.length!==30720||crc32(binary)!==snapshot.verifiedImage.crc32)throw Error('Original image backup is incomplete');
  return upload({binary,frames:30,delay:200,screen:snapshot.screen,restore:true,hideDuringUpload:true});
}
