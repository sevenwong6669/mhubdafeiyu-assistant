import fs from 'node:fs/promises';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {writeJson} from './resilience.mjs';
import {BALANCE_KEYBOARDS,balanceLayout} from './balance-keyboards.mjs';

export function ambientColors(view,count=28){
 const rgb=view.color.slice(1).match(/../g).map(x=>parseInt(x,16));
 const level=view.zeroAlert?8:Number.isFinite(view.ratio)?Math.max(view.ratio>0?1:0,Math.round(Math.max(0,Math.min(1,view.ratio))*count*8)):view.level*count/28;
 const length=level/8;
 return Array.from({length:count},(_,i)=>'#'+rgb.map(v=>Math.round(v*Math.max(0,Math.min(1,length-i))).toString(16).padStart(2,'0')).join(''));
}
export function balancePalette(view,spec,mode){
 const layout=balanceLayout(spec,mode),row=ambientColors(view,layout.segments),colors=Array(spec.sideCount).fill('#000000');
 for(const indices of layout.rows)indices.forEach((index,i)=>{colors[index]=row[i];});
 return colors;
}
export async function ambientRenderer(p){
 const key='__dafeiyuIndependentBalance',manager=window.ALL_CZ_STATE;
 const m=await loadMhubModule(),store=m.c3(),connected=new Set(store.connectedDeviceIds??[]);
 let candidates=(p.models??[]).flatMap(spec=>connected.has(spec.id)?[...manager.deviceStateMap.keys()].filter(d=>d.vendorId===spec.vendorId&&d.productId===spec.productId).map(device=>({device,spec})):[]);
 const previousOwner=window[key];
 const releasing=p.action==='release'||p.enabled===false;
 const records=p.recovery?.devices??(p.recovery?{[p.recovery.model??'Ace 75 8K']:p.recovery}:{});
 const pendingModels=new Set(Object.entries(records).filter(([model,record])=>record?.side?.length===8&&
  record?.palette?.length&&!record.restored&&model!==previousOwner?.model).map(([model])=>model));
 if(previousOwner?.active)pendingModels.add(previousOwner.model);
 const pendingRestore=releasing&&pendingModels.size>0;
 if(pendingRestore)candidates=candidates.filter(v=>previousOwner?.active?v.spec.id===previousOwner.model:pendingModels.has(v.spec.id));
 if(candidates.length!==1)return {active:false,available:false,reason:candidates.length?'multiple-keyboards':pendingRestore?'owned-device-offline':'unsupported-keyboard',pendingRestore};
 const {device,spec}=candidates[0],model=spec.id,count=spec.sideCount;
 const capability={available:true,model,segments:count};
 const ownership=Object.values(m).find(v=>v?.constructor?.name==='LightingOwnership');
 const syncActive=ownership.isSyncActive({id:model})||
  !!(store.masterEnabled&&store.activeScene?.devices?.some(d=>d.id===model&&d.selected));
 // Let M HUB's live output own the device without competing HID reads or writes.
 if(syncActive)return {...capability,active:false,reason:p.show===false?'game-active':'sync-takeover',syncActive,pendingRestore};
 const readAndUpdate=async()=>{
 p={...p,colors:p.palettes?.[model]??p.colors};
 if(!p.enabled&&!window[key]&&!p.recovery)return {...capability,active:false,reason:'disabled'};
 const {sdk}=await manager.getDeviceState(device),base=await sdk.getBase(),profile=base.profileIndex;
 // Observe actual M HUB side writes; zero palette reads alone are not user intent.
 let evidence;
 if(model==='GT 75'){
  const channel=sdk.channel;evidence=channel.__dafeiyuSideWrites;
  if(!evidence){
   evidence={seq:0,own:new WeakSet(),profile,sideStart:spec.sideStart*3,sideBytes:count*3,area:channel.totalLightAreaSize};
   channel.__dafeiyuSideWrites=evidence;const send=channel._simpleSendCommand;
   channel._simpleSendCommand=function(cmd,offset,data,options){
    const e=this.__dafeiyuSideWrites,len=data?.length??0,overlap=(start,size)=>offset<start+size&&offset+len>start;
    if(!e.own.has(options??{})&&(cmd===11&&overlap(e.profile*e.area+e.sideStart,e.sideBytes)||cmd===6&&overlap(e.profile*64+24,8))){e.seq++;e.last={at:Date.now(),command:cmd,offset};}
    return send.call(this,cmd,offset,data,options);
   };
  }
  evidence.profile=profile;
 }
 const ownedSend=(channel,cmd,offset,data,options={priority:-1})=>{
  channel.__dafeiyuSideWrites?.own.add(options);
  return channel._simpleSendCommand(cmd,offset,data,options);
 };
 let state=window[key];
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const current=await sdk.channel.getFuncConfig(profile),side=Array.from(current.slice(24,32));
 const palette=()=>sdk.getSideKeyColors(profile);
 const setPalette=async(target,targetProfile,colors)=>{
  if(model==='GT 75'){
   // GT75's bulk setter loses this 60-byte side map. The verified aligned
   // writes use the same native palette command, one RGB triplet at a time.
   const bytes=colors.flatMap(color=>color.slice(1).match(/../g).map(x=>parseInt(x,16)));
   await ownedSend(target.channel,11,targetProfile*target.channel.totalLightAreaSize+spec.sideStart*3,bytes,{priority:-1,chunkSize:3});
  }else await target.setSideKeyColors(targetProfile,colors);
 };
 // A restarted M HUB can leave the last native custom map in firmware. Adopt it
 // only when both the mode bytes and every color still match our saved claim.
 const recovery=records[model];
 if(!state&&!recovery?.restored&&recovery?.profile===profile&&recovery.side?.length===8&&recovery.palette?.length===count){
  const liveColors=await palette();
  const ownsSide=same(side,recovery.expected)||same(side,recovery.previousSide);
  const ownsColors=same(liveColors,recovery.colors)||same(liveColors,recovery.previousColors);
  if(ownsSide&&ownsColors){
   state={model,profile,sdk,original:{side:recovery.side,palette:recovery.palette},expected:side,colors:liveColors,brightness:side[1],active:true,manual:false,externalSeq:evidence?.seq??0};window[key]=state;
  }
 }
 const backup=()=>{const expected=[...side];expected[0]=sdk.sideLightColorRange.customEffectValue;expected[1]=p.brightness;expected[3]=0;return {model,profile,...state.original,previousSide:side,previousColors:state.colors,expected,colors:p.colors,brightness:p.brightness,at:Date.now()};};
 const prepare=async()=>{
  const previous=await palette();if(previous.length!==count)throw Error('氛围灯布局与已适配型号不一致');
  state={model,profile,sdk,original:{side,palette:previous},active:false,manual:false,version:p.version,preparedAt:Date.now(),externalSeq:evidence?.seq??0};window[key]=state;
 };
 const restore=async({manual=false}={})=>{
  if(!state?.active)return;
  const oldProfile=state.profile,raw=await state.sdk.channel.getFuncConfig(oldProfile),live=Array.from(raw.slice(24,32)),colors=await state.sdk.getSideKeyColors(oldProfile);
   if(!same(colors,state.original.palette)&&(same(colors,state.colors)||same(colors,state.previousColors))){
    await setPalette(state.sdk,oldProfile,state.original.palette);
    if(!same(await state.sdk.getSideKeyColors(oldProfile),state.original.palette))throw Error('余额灯图恢复未确认');
   }
   if(!manual&&!same(live,state.original.side)&&(same(live,state.expected)||same(live,state.previousSide))){
    await ownedSend(state.sdk.channel,6,oldProfile*64+24,state.original.side,{priority:-1});
    const checked=await state.sdk.channel.getFuncConfig(oldProfile);
    if(!same(Array.from(checked.slice(24,32)),state.original.side))throw Error('余额灯条模式恢复未确认');
   }
  state.active=false;state.manual=manual;
  state.previousSide=undefined;state.previousColors=undefined;
 };
 if(state&&(state.sdk!==sdk||state.profile!==profile)){
  // A removed keyboard cannot be restored through its stale SDK. Its per-model
  // recovery journal is retained and adopted when that keyboard reconnects.
  if(state.sdk===sdk)await restore();state=null;delete window[key];
  return await ambientRenderer({...p,recovery:p.recovery});
 }
 if(p.action==='release'){
  await restore();
  pendingModels.delete(model);
  return {...capability,active:false,releasedModel:model,reason:pendingModels.size?'other-device-pending':state?.manual?'manual-change':'disabled',pendingRestore:pendingModels.size>0};
 }
 if(!state?.active&&(!p.enabled||!p.show||!p.colors))return {...capability,active:false,reason:!p.enabled?'disabled':!p.show?'game-active':'balance-unavailable'};
 if(!state||p.claim&&!state.active){await prepare();return {...capability,prepared:true,backup:backup()};}
 if(p.claim)state.externalSeq=evidence?.seq??0;
 if(state.manual&&!p.claim)return {...capability,active:false,manualChanged:true,reason:'manual-change'};
 if(state.active&&evidence&&evidence.seq>(state.externalSeq??evidence.seq)&&!p.claim){
  state.lastExternalEdit=evidence.last;await restore({manual:true});return {...capability,active:false,manualChanged:true,reason:'manual-change'};
 }
 const emptyRead=colors=>model==='GT 75'&&colors.length===count&&colors.every(c=>/^#0{6}$/i.test(c))&&state.colors?.some(c=>!/^#0{6}$/i.test(c));
 if(state.active&&!p.reassert){
  const colors=await palette();
  if(!same(side,state.expected)||!same(colors,state.colors)){
   state.lastMismatch={side,expected:state.expected,colors,expectedColors:state.colors,at:Date.now()};
   if(same(side,state.expected)&&emptyRead(colors)){
    state.emptyReads=(state.emptyReads??0)+1;
    if(p.nativeSideLease)state.paletteReadback='empty-while-native-owned';
    else if(p.claim||Date.now()-(state.lastPaletteRepair??0)>5000)p={...p,reassert:true};
    else return {...capability,active:true,profile,reason:null,paletteReadback:'repair-pending'};
   }else{await restore({manual:true});return {...capability,active:false,manualChanged:true,reason:'manual-change'};}
  }else state.paletteReadback='verified';
 }
 if(!p.enabled||!p.show||!p.colors){await restore();return {...capability,active:false,reason:!p.enabled?'disabled':!p.show?'game-active':'balance-unavailable'};}
 if(!state.active||p.reassert||p.claim||!same(state.colors,p.colors)||state.brightness!==p.brightness){
  if(!p.prepared)return {...capability,prepared:true,backup:backup()};
  const raw=await sdk.channel.getFuncConfig(profile);
   const baseline=state.active?state.expected:state.original.side;
   const baselineColors=state.active?state.colors:state.original.palette;
   const baselineSideMatches=same(Array.from(raw.slice(24,32)),baseline),baselineRead=await palette();
   const ownedEmptyBaseline=baselineSideMatches&&emptyRead(baselineRead);
   if(!p.reassert&&(!baselineSideMatches||!same(baselineRead,baselineColors)&&!ownedEmptyBaseline)){
    await restore({manual:true});
    state.manual=true;
    return {...capability,active:false,manualChanged:true,reason:'manual-change'};
   }
  // Native custom side-light map. No live main-key frames or performance fields are written.
  raw[24]=sdk.sideLightColorRange.customEffectValue;raw[25]=p.brightness;raw[27]=0;
  state.previousSide=state.active?state.expected:side;
  state.previousColors=state.active?state.colors:undefined;
  state.expected=Array.from(raw.slice(24,32));state.colors=[...p.colors];state.brightness=p.brightness;state.active=true;state.manual=false;
  try{
   await setPalette(sdk,profile,p.colors);
   await ownedSend(sdk.channel,6,profile*64+24,state.expected,{priority:-1});state.lastPaletteRepair=Date.now();
  }catch(error){
   try{await restore();}catch(cleanup){throw new AggregateError([error,cleanup],'余额灯条写入及恢复失败');}
   throw error;
  }
  state.previousSide=undefined;state.previousColors=undefined;
 }
  if(state.active){
   const actual=await sdk.channel.getFuncConfig(profile);
   const colors=await palette(),sideMatches=same(Array.from(actual.slice(24,32)),state.expected);
   if(sideMatches&&emptyRead(colors))state.paletteReadback=p.nativeSideLease?'empty-while-native-owned':'repair-pending';
   else if(!sideMatches||!same(colors,state.colors)){await restore();return {...capability,active:false,profile,reason:'write-unconfirmed'};}
  }
 state.version=p.version;return {...capability,active:state.active,profile,reason:null,syncActive,paletteReadback:state.paletteReadback??'verified',emptyReads:state.emptyReads??0};
 };
 if(typeof ownership.runPassive!=='function')return readAndUpdate();
 const result=await ownership.runPassive({id:model},readAndUpdate);
 return result?.sent===false?{...capability,active:false,reason:'driver-writing',deferred:true,pendingRestore}:result;
}
export class AmbientStrip{
 constructor({evaluate=evaluateInMhub,backup=new URL('balance-bar/native-backup.json',import.meta.url)}={}){this.evaluate=evaluate;this.backup=backup;this.loaded=false;this.last=0;this.version=null;this.force=false;this.status=null;}
 reassert(){this.force=true;this.last=0;}
 async loadRecovery(){
  if(this.loaded)return;
  try{this.recovery=JSON.parse(await fs.readFile(this.backup,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  this.loaded=true;
 }
 async sync(view,settings,show=true,{nativeSideLease=false}={}){
  const requestedKey=JSON.stringify({enabled:settings.enabled,version:settings.controlVersion,brightness:settings.brightness,layout:settings.gt75Layout,show,nativeSideLease,view:view?{ratio:view.ratio,level:view.level,color:view.color}:null});
  if(Date.now()-this.last<500&&(!this.force||this.status?.deferred)&&requestedKey===this.requestedKey)return this.status;
  this.last=Date.now();this.requestedVersion=settings.controlVersion;this.requestedKey=requestedKey;
  const claim=settings.enabled&&this.version!==settings.controlVersion;
  await this.loadRecovery();
  const input={models:BALANCE_KEYBOARDS,enabled:settings.enabled,show,nativeSideLease,palettes:Object.fromEntries(BALANCE_KEYBOARDS.map(spec=>[spec.id,view?balancePalette(view,spec,settings.gt75Layout):null])),brightness:settings.brightness,version:settings.controlVersion,claim,reassert:this.force,recovery:this.recovery};
  let result=await this.evaluate(ambientRenderer,input,5000);
  if(result.prepared){const devices=this.recovery?.devices??(this.recovery?{[this.recovery.model??'Ace 75 8K']:this.recovery}:{});this.recovery={version:2,devices:{...devices,[result.model]:result.backup}};await writeJson(this.backup,this.recovery);result=await this.evaluate(ambientRenderer,{...input,recovery:this.recovery,claim:false,prepared:true},5000);}
  if(!result.syncActive&&!result.deferred)this.version=settings.controlVersion;
  if(!result.deferred)this.force=false;return this.status=result;
 }
 async close(){
  await this.loadRecovery();
  const result=await this.evaluate(ambientRenderer,{models:BALANCE_KEYBOARDS,action:'release',recovery:this.recovery},5000);
  const devices=this.recovery?.devices??(this.recovery?{[this.recovery.model??'Ace 75 8K']:this.recovery}:{});
  const record=devices[result?.releasedModel];
  if(record&&!record.restored){
   const released={version:2,devices:{...devices,[result.releasedModel]:{...record,restored:true}}};
   await writeJson(this.backup,released);this.recovery=released;
  }
  return result;
 }
}
