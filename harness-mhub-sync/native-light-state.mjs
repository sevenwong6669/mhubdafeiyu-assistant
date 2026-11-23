import {runtime} from '../runtime-paths.mjs';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export async function deviceLighting(action,{ids=[],saved={},preserve=[],preserveSide=false}={},evaluate=evaluateInMhub){
 return evaluate(async({action,ids,saved,preserve,preserveSide})=>{
  const m=await loadMhubModule(),ownership=Object.values(m).find(v=>v?.constructor?.name==='LightingOwnership');
  const out={},wanted=new Set(ids),skip=new Set(preserve);
  if(action==='release'){
   for(const id of ids)await ownership.release({id},{restore:!skip.has(id)});
   return {released:true};
  }
  const state=window.ALL_CZ_STATE;
  for(const spec of [{id:'Ace 75 8K',pid:12348,key:'keyboard'},{id:'GT 75',pid:12333,key:'GT 75'}]){
   const device=[...state.deviceStateMap.keys()].find(d=>d.vendorId===14391&&d.productId===spec.pid);
   if(!device||!wanted.has(spec.id))continue;
   const {sdk}=await state.getDeviceState(device),base=await sdk.getBase(),profile=base.profileIndex;
   const raw=await sdk.channel.getFuncConfig(profile);
   if(action==='capture')out[spec.key]={profile,main:Array.from(raw.slice(8,17)),aux:Array.from(raw.slice(44,52)),...(spec.id==='GT 75'&&!preserveSide?{side:Array.from(raw.slice(24,32))}:{})};
   else if(saved[spec.key]&&!skip.has(spec.id)&&profile!==saved[spec.key].profile){out[spec.key]={restored:true,preserved:true,reason:'profile-changed',profile};}
   else if(saved[spec.key]&&!skip.has(spec.id)&&profile===saved[spec.key].profile){
    // Only main keys and the extra indicator; never overwrite the independent balance strip.
    const before=saved[spec.key];
    await sdk.channel._simpleSendCommand(6,profile*64+8,before.main,{priority:-1});
    await sdk.channel._simpleSendCommand(6,profile*64+44,before.aux,{priority:-1});
    if(before.side){
     const options={priority:-1};sdk.channel.__dafeiyuSideWrites?.own.add(options);
     await sdk.channel._simpleSendCommand(6,profile*64+24,before.side,options);
    }
    const actual=await sdk.channel.getFuncConfig(profile);
    out[spec.key]={restored:JSON.stringify(Array.from(actual.slice(8,17)))===JSON.stringify(before.main)&&JSON.stringify(Array.from(actual.slice(44,52)))===JSON.stringify(before.aux)&&(!before.side||JSON.stringify(Array.from(actual.slice(24,32)))===JSON.stringify(before.side))};
   }
  }
  for(const d of m.aH.devices.value){
   const id=d.modelKey==='MCHOSE K20 GT'?'MCHOSE K20 GT':d.modelKey==='MCHOSE V9 TURBO+ DOCK'?'V9 Turbo$$$14391$$$24584':null;
   if(!id||!wanted.has(id))continue;
   if(action==='capture')out[id]=d.modelKey==='MCHOSE K20 GT'?(await m.de.getK20GtLighting(d.logicalDeviceId)).lighting:await m.de.getDockLightingSyncState(d.logicalDeviceId);
   else if(saved[id]&&!skip.has(id)){
    const v=saved[id];
    if(d.modelKey==='MCHOSE K20 GT'){
     await m.de.setK20GtSmartLighting(d.logicalDeviceId,false);
     await m.de.setK20GtLightingDetail(d.logicalDeviceId,{controlMode:v.controlMode,brightness:v.brightness,cycle:v.cycle});
     await m.de.setK20GtLightingColor(d.logicalDeviceId,v.color);
     if(v.smartEnabled)await m.de.setK20GtSmartLighting(d.logicalDeviceId,true);
      const actual=(await m.de.getK20GtLighting(d.logicalDeviceId)).lighting;
      const fields=['controlMode','brightness','cycle','color','smartEnabled'];
      out[id]={...actual,restored:fields.every(key=>JSON.stringify(actual?.[key])===JSON.stringify(v[key]))};
     }else{
      // The driver assigns a new sessionId when the same dock reconnects.
      const fields=['enabled','mode','modeCount','speed','brightness','lightSyncEnabled','baseColor','direction'];
      const matches=actual=>!!actual&&fields.every(key=>JSON.stringify(actual[key])===JSON.stringify(v[key]));
      let actual=await m.de.getDockLightingSyncState(d.logicalDeviceId);
      if(!matches(actual)){
       await m.de.setDockLightingSyncState(d.logicalDeviceId,v);
       actual=await m.de.getDockLightingSyncState(d.logicalDeviceId);
      }
      out[id]={...actual,restored:matches(actual)};
     }
   }
  }
  return out;
 },{action,ids,saved,preserve,preserveSide},12000);
}
export function magdockState(action,state){
 return new Promise((resolve,reject)=>{
  const child=execFile(runtime.python,['-X','utf8',fileURLToPath(new URL('magdock-state.py',import.meta.url))],{windowsHide:true,timeout:5000,maxBuffer:8192},(error,out)=>{if(error)return reject(Error('MagDock 状态保存／恢复失败：'+error.message));try{resolve(JSON.parse(out));}catch{reject(Error('MagDock 状态无效'));}});
  child.stdin.end(JSON.stringify({action,state}));
 });
}
