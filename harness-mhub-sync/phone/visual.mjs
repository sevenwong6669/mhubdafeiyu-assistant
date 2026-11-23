import fs from 'node:fs/promises';
import {evaluateInMhub} from '../../mhub_runtime_access.mjs';
import {mhub} from '../../dafeiyu-mhub-bridge/mhub.mjs';
import {LightSession} from '../light-session.mjs';
import {restoreText} from '../screen.mjs';
import {writeJson} from '../resilience.mjs';
import {phoneActive} from './settings.mjs';
const dir=new URL('./',import.meta.url),file=n=>new URL(n,dir);
const read=async n=>JSON.parse(await fs.readFile(file(n),'utf8'));
export function deepBytes(raw,mm=4){
 if(!Array.isArray(raw)||raw.length!==8||raw.some(x=>!Number.isInteger(x)||x<0||x>255))throw Error('按键行程备份无效');
 const b=[...raw],n=Math.round(mm*100)-1;if(n<99||n>399)throw Error('接听行程超出范围');
 b[2]=n&255;b[3]=(b[3]&254)|(n>>8);b[4]=n&255;b[5]=n>>8;b[6]=n&255;b[7]=n>>8;return b;
}
export async function keyboardInfo({fixedKey=null}={}){
 const m=await loadMhubModule(),a=window.ALL_CZ_STATE,d=[...a.deviceStateMap.keys()].filter(x=>x.vendorId===14391&&[12348,12333].includes(x.productId)).sort((x,y)=>y.productId-x.productId)[0];
 if(!d)throw Error('支持的键盘未连接');const {sdk}=await a.getDeviceState(d),profile=(await sdk.getBase()).profileIndex,deviceId=d.productId===12333?'GT 75':'Ace 75 8K';
 const scene=m.c3().scenes.find(s=>s.devices?.some(d=>d.id===deviceId)),dev=scene?.devices.find(d=>d.id===deviceId);
 const layout=await m.c2(dev),mainKeys=deviceId==='GT 75'?99:95;
 const keys=layout.keys.filter(k=>!k.isSideLight&&!k.isSideLight2&&!k.isIndicator&&Number.isInteger(k.ledIndex)&&k.ledIndex>=0&&k.ledIndex<mainKeys&&Number.isFinite(k.x)&&Number.isFinite(k.y));
 const maps=new Map((await sdk.getKeyInfos(profile,0)).map(v=>[v.index,v]));
 const candidates=keys.flatMap(key=>{
  const usage=key.keyCode,map=maps.get(key.ledIndex);
  // Keep macros, modifier and lock keys out of the draw.
  if(map?.type!==16||map.code1!==0||map.code2!==usage)return [];
  if(!(usage>=4&&usage<=39||usage>=44&&usage<=56||usage>=58&&usage<=69||usage>=79&&usage<=82))return [];
  const alias=key.inputAliases?.find(v=>v.source==='raw-input'&&Number.isInteger(v.makeCode)&&v.makeCode>0);
  let vk=null;
  if(usage>=4&&usage<=29)vk=usage+61;
  else if(usage>=30&&usage<=38)vk=usage+19;
  else if(usage>=58&&usage<=69)vk=usage+54;
  else vk=({39:48,44:32,79:39,80:37,81:40,82:38})[usage]??null;
  return alias||vk?[{key,vk,scan:alias?.makeCode??null,extended:alias?.extended===true}]:[];
 });
 if(!candidates.length)throw Error('没有可用的普通按键，已保留当前按键映射');
 let selected;
 if(fixedKey){
  const usage=/^[A-Z]$/.test(fixedKey)?fixedKey.charCodeAt(0)-61:/^[1-9]$/.test(fixedKey)?Number(fixedKey)+29:fixedKey==='0'?39:/^F([1-9]|1[0-2])$/.test(fixedKey)?57+Number(fixedKey.slice(1)):({Space:44,Right:79,Left:80,Down:81,Up:82})[fixedKey];
  selected=candidates.find(c=>c.key.keyCode===usage);
  if(!selected)throw Error('指定接听键 '+fixedKey+' 当前不存在或已被改键，请换一个普通键');
 }else selected=candidates[Math.floor(Math.random()*candidates.length)];
 const {key,vk,scan,extended}=selected;
 const aspect=layout.referenceHeight/layout.referenceWidth;
 const yScale=Number.isFinite(aspect)&&aspect>0?aspect:0.45;
 return {profile,deviceId,productId:d.productId,maxDepthMm:deviceId==='GT 75'?3.4:4,frameBytes:deviceId==='GT 75'?384:285,index:key.ledIndex,answerKey:key.name,vk,scan,extended,raw:Array.from(await sdk.channel.getKeyTrigger(profile,{keyIndex:key.ledIndex})),keys:keys.map(k=>({index:k.ledIndex,x:k.x+(k.width??0)/2,y:(k.y+(k.height??0)/2)*yScale}))};
}
export async function triggerTransaction({saved,restore=false}){
 const productId=saved.productId??12348;if(![12348,12333].includes(productId))throw Error('接听按键备份设备无效');
 const a=window.ALL_CZ_STATE,d=[...a.deviceStateMap.keys()].find(x=>x.vendorId===14391&&x.productId===productId);if(!d)throw Error('接听按键设备未连接');const {sdk}=await a.getDeviceState(d);
 if(!restore&&(await sdk.getBase()).profileIndex!==saved.profile)throw Error('键盘配置档已切换，放弃临时接管');
 const readKey=async()=>Array.from(await sdk.channel.getKeyTrigger(saved.profile,{keyIndex:saved.index}));
 const writeKey=bytes=>sdk.channel._simpleSendCommand(161,saved.profile*1024+saved.index*8,bytes,{priority:-1});
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const current=await readKey(),target=restore?saved.raw:saved.deep,slot='__dafeiyuPhoneTrigger';

 function syncView(bytes,previous,shown){
  try{
   const frame=document.querySelector('iframe.keyboard-content');
   const key=frame?.contentDocument?.querySelector(`.key-wrapper[data-value="${saved.index}"] .key-travel-actuation`);
   if(!key)return;
   const handle=Object.keys(key).find(name=>name.startsWith('__reactFiber$'));
   const contexts=new Map();let provider;
   for(let fiber=key[handle];fiber;fiber=fiber.return){
    const name=(fiber.type?._context??fiber.type)?.displayName;
    if(name&&!contexts.has(name))contexts.set(name,fiber.memoizedProps?.value);
    if(!provider&&typeof fiber.ref?.current?.setProfileData==='function')provider=fiber.ref;
   }
   const meta=contexts.get('MetaContext'),list=contexts.get('ProfileListContext'),view=contexts.get('ProfileDataContext');
   if(meta?.vendorId!==14391||meta.productId!==productId||!provider||provider.current.profileIndex!==saved.profile||
      list?.selectedProfileItem?.type!=='keyboard'||list.selectedProfileItem.profileIndex!==saved.profile||
      !view||view.profileDataRefreshing||shown?.has(provider))return;
   // Decode the same packed fields the GLW SDK uses for its trigger view.
   const travel=b=>({
    keyActuation:1+b[2]+256*(b[3]&1),
    rtPress:1+b[4]+256*(b[5]&1),rtRelease:1+b[6]+256*(b[7]&1),
    pressDeadzone:b[5]>>1,releaseDeadzone:b[7]>>1,
   });
   const old=travel(previous),next=travel(bytes);
   const fields=Object.keys(next).filter(field=>old[field]!==next[field]);
   if(!fields.length)return;
   const patch=profile=>{
    const keys=profile?.triggerTravel?.travelKeys,record=keys?.[saved.index];
    if(!record||!fields.every(field=>record[field]===old[field]||record[field]===next[field])||
       fields.every(field=>record[field]===next[field]))return profile;
    const updated=keys.slice();
    updated[saved.index]={...record,...Object.fromEntries(fields.map(field=>[field,next[field]]))};
    return {...profile,triggerTravel:{...profile.triggerTravel,travelKeys:updated}};
   };
   if(!view.triggerTravel?.travelKeys?.[saved.index])return;
   provider.current.setProfileData(patch);
   shown?.add(provider);
  }catch{} // A different driver build can omit this view without affecting the hardware lease.
 }
 const clearLease=state=>{
  if(!state)return;
  clearInterval(state.timer);
  if(window[slot]===state)delete window[slot];
 };
 if(restore&&!same(current,saved.deep)){
  clearLease(window[slot]);
  if(same(current,saved.raw))syncView(current,saved.deep);
  return {restored:same(current,saved.raw),preserved:!same(current,saved.raw)};
 }
 if(!restore&&!same(current,saved.raw))throw Error('按键设置已更改，放弃临时接管');
 await writeKey(target);
 const actual=await readKey();if(!same(actual,target))throw Error('接听行程读回不一致');
 if(restore){clearLease(window[slot]);syncView(actual,saved.deep);}
 else{
  clearLease(window[slot]);
  const state={until:Date.now()+5000,busy:false},shown=new WeakSet();
  syncView(actual,saved.raw,shown);
  state.timer=setInterval(async()=>{
   if(Date.now()<state.until){syncView(actual,saved.raw,shown);return;}
   if(state.busy)return;state.busy=true;
   try{
    let now=await readKey();
    if(!same(now,saved.raw)&&same(now,saved.deep)){
     await writeKey(saved.raw);now=await readKey();
     if(same(now,saved.deep))throw Error('接听行程尚未恢复');
    }
    if(same(now,saved.raw))syncView(now,saved.deep);
    clearLease(state);
   }catch{state.busy=false;}
  },500);
  window[slot]=state;
 }
 return {restored:restore,verified:true};
}
export function rippleFrame(keys,answerIndex,time,frameBytes=285){
 if(![285,384].includes(frameBytes))throw Error('Unsupported keyboard frame');
 const colors=Array(frameBytes).fill(0),center=keys.find(k=>k.index===answerIndex);
 if(!center)return colors;
 const distance=k=>Math.hypot(k.x-center.x,k.y-center.y);
 const edge=Math.max(...keys.map(distance));
 const elapsed=Math.max(0,time),phase=(elapsed%2000)/1700;
 const radius=phase*(edge+0.13),width=0.105;
 if(phase<=1)for(const key of keys){
  if(key.index<0||key.index>=frameBytes/3||key.index===answerIndex)continue;
  const offset=distance(key)-radius;
  const level=Math.max(0,1-Math.abs(offset)/(offset<0?width:width*0.6))**2;
  const i=key.index*3;
  colors[i]=Math.round(32*level);colors[i+1]=Math.round(145*level);colors[i+2]=Math.round(220*level);
 }
 const breath=(1+Math.cos(elapsed*Math.PI/1000))/2;
 colors[answerIndex*3+1]=Math.round(95+160*breath);
 return colors;
}
export class PhoneVisual{
 constructor(bridge){this.bridge=bridge;this.id=null;this.key=null;this.screen=null;this.phase=null;this.status={active:false};this.lights=new LightSession({persist:v=>writeJson(file('light-journal.json'),v),load:()=>read('light-journal.json')});}
 async request(){try{const s=await read('state.json');return phoneActive(s)&&Date.now()-s.at<3500?s:null;}catch{return null;}}
 async recover(){
  try{const j=await read('key-journal.json');if(j.active&&j.saved){await evaluateInMhub(triggerTransaction,{saved:j.saved,restore:true});await writeJson(file('key-journal.json'),{...j,active:false});}}catch(e){if(e.code!=='ENOENT')throw e;}
  await this.lights.recover();
  try{const j=await read('screen-journal.json');if(j.active&&j.screen){this.screen=j.screen;await this.restoreScreen();}}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 async begin(s,ids,{master=true}={}){
  // The ring writer only owns the keyboard. Capture other devices when
  // suspending an active M HUB scene might change their output.
  await this.lights.begin(master?ids:ids.filter(id=>id==='GT 75'||id==='Ace 75 8K'));
  if(this.lights.saved.scene.master&&!master)await this.lights.begin(ids);
  await this.lights.beforeWrite();
  let applied;
  try{applied=await mhub('suspend-master',{expected:this.lights.saved.lastApplied});}
  catch(error){
   if(error.message.includes('M HUB 设置已被手动改变'))await this.lights.cancelWrite();
   throw error;
  }
  await this.lights.markApplied(applied.signature);
  this.id=s.id;this.status={active:true,callId:s.id};
 }
 async prepare(s){
  let cfg={};try{cfg=await read('settings.json');}catch{}
  try{
   const key=await evaluateInMhub(keyboardInfo,{fixedKey:s.demo?(cfg.debugAnswerKey??'F11'):null}),depth=Math.min(cfg.answerDepthMm??4,key.maxDepthMm);key.deep=cfg.deepAnswer===false?[...key.raw]:deepBytes(key.raw,depth);
   this.key=key;await writeJson(file('key-journal.json'),{active:true,saved:key,callId:s.id});
   if(cfg.deepAnswer!==false)await evaluateInMhub(triggerTransaction,{saved:key});
   this.rippleAt=Date.now();
   this.lastTriggerRenew=this.rippleAt;
   this.status={active:true,callId:s.id,ready:true,answerKey:key.answerKey,vk:key.vk,scan:key.scan,extended:key.extended,depthMm:cfg.deepAnswer===false?null:depth};
  }catch(e){this.status={active:true,callId:s.id,ready:false,error:e.message};}
 }
 async releaseKey(){if(!this.key)return;await evaluateInMhub(triggerTransaction,{saved:this.key,restore:true});await writeJson(file('key-journal.json'),{active:false,saved:this.key,at:Date.now()});this.key=null;}
 async stopRingingLights(){
  clearInterval(this.ringTimer);this.ringTimer=null;
  if(!this.ringWriter)return;
  try{await this.bridge.stopWriter();}
  finally{Object.assign(this.bridge,this.ringWriter);this.ringWriter=null;}
 }
 async poll(s){
  const changed=s.phase!==this.phase;
  if(changed){
   if(this.phase==='incoming')try{await this.stopRingingLights();}finally{await this.releaseKey();}
   if(s.phase==='incoming'&&Date.now()<s.ringUntil)await this.prepare(s);
   this.phase=s.phase;
  }
  if(s.phase==='incoming'&&this.status.ready&&this.key&&Date.now()<s.ringUntil){
   if(!this.ringWriter){
    const current=await this.request();
    if(current?.id===s.id&&current.phase==='incoming'&&Date.now()<s.ringUntil){
     this.ringWriter={mainOnly:this.bridge.mainOnly,sidePalettes:this.bridge.sidePalettes};
     Object.assign(this.bridge,{mainOnly:true,sidePalettes:{}});
     const send=()=>{
      const elapsed=Date.now()-this.rippleAt;
      if(Date.now()<s.ringUntil&&(!this.status.depthMm||Date.now()-this.lastTriggerRenew<4500)){
       this.bridge.send(rippleFrame(this.key.keys,this.key.index,elapsed,this.key.frameBytes),this.key.deviceId);
      }
     };
     send();this.ringTimer=setInterval(send,120);
    }
   }
   if(this.ringWriter&&this.status.depthMm&&Date.now()-this.lastTriggerRenew>=900){
    const renewed=await evaluateInMhub(()=>{const lease=window.__dafeiyuPhoneTrigger;if(!lease||lease.until<=Date.now())return false;lease.until=Date.now()+5000;return true;},{},1800);
    if(!renewed){this.status.ready=false;this.status.error='接听键已自动恢复，请用页面接听';await this.stopRingingLights();}
    this.lastTriggerRenew=Date.now();
   }
  }
  this.status={...this.status,at:Date.now()};await writeJson(file('hardware.json'),this.status);
 }
 async restoreScreen(){
  if(!this.screen)return;await restoreText(this.screen.text);
  await evaluateInMhub(async({screen})=>{const m=await loadMhubModule(),d=m.aH.devices.value.find(d=>d.modelKey==='MCHOSE K20 GT');if(!d)throw Error('音箱未连接');const p={enabled:screen.enabled,color:screen.color,mode:screen.mode,theme:screen.theme,index:screen.themeStates?.[screen.theme]?.index??0};window.__dafeiyuScreenExpected={...p,at:Date.now()};await m.de.setK20GtScreenState(d.logicalDeviceId,p);return true;},{screen:this.screen.screen});
  await writeJson(file('screen-journal.json'),{active:false,screen:this.screen});this.screen=null;
 }
 async end(){
  const errors=[];
  for(const cleanup of [()=>this.stopRingingLights(),()=>this.releaseKey(),()=>this.lights.end(),()=>this.restoreScreen()]){
   try{await cleanup();}catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors,errors.map(error=>error.message).join('；'));
  this.id=null;this.phase=null;this.status={active:false,at:Date.now()};
  await writeJson(file('hardware.json'),this.status);
 }
}
