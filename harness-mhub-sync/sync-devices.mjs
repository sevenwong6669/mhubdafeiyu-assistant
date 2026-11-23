import fs from 'node:fs/promises';
import {isSpeakerControlError} from './screen-recovery.mjs';
export const DEFAULT_SYNC_DEVICES={deviceIds:null};
export function connectedSelection(current,requested){
 const connected=new Set(current.connectedDeviceIds??[]);
 const ids=requested??[...connected].filter(id=>/(K20\s*GT|Ace\s*75|GT\s*75|MagDock)/i.test(id));
 return ids.filter(id=>connected.has(id));
}
// This flag describes the USB control transport, not ownership of the picture.
// A user-selected picture must never prevent independently backed-up lighting.
export function previewSelection(ids,speakerControlReady){
 const skipped=speakerControlReady?[]:ids.filter(id=>id==='MCHOSE K20 GT');
 return {ids:ids.filter(id=>!skipped.includes(id)),skipped};
}
export async function beginLightingSession(session,ids,speakerControlReady,onSpeakerError=()=>{}){
 let selection=previewSelection(ids,speakerControlReady);
 const begin=async()=>{
  if(!selection.ids.length)throw Error('音箱 USB 控制通道未响应，当前没有其他可试用的设备。');
  await session.begin(selection.ids);
 };
 try{await begin();}
 catch(error){
  if(!speakerControlReady||!ids.includes('MCHOSE K20 GT')||!isSpeakerControlError(error))throw error;
  // Native backup fails before takeover. Retry once on independent devices.
  await onSpeakerError(error);selection=previewSelection(ids,false);await begin();
 }
 return selection;
}
// Preserve the established entry point for callers and existing integrations.
export const beginPreviewSession=beginLightingSession;
export function validateSyncDevices(values){
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(k=>k!=='deviceIds'))throw Error('同步设备设置无效。');
 const ids=values.deviceIds;if(ids===null)return {deviceIds:null};
 if(!Array.isArray(ids)||!ids.length||ids.length>24||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id.trim()||id.length>180||/[\x00-\x1f]/.test(id)))throw Error('请至少选择一台设备，且不要重复选择。');
 return {deviceIds:[...ids]};
}
export class LiveSyncDevices{
 constructor(){this.deviceIds=null;this.version=null;this.last=0;this.error=null;}
 async poll(){
  if(Date.now()-this.last<500)return false;this.last=Date.now();
  try{const {controlVersion,...values}=JSON.parse(await fs.readFile(new URL('sync-devices.json',import.meta.url),'utf8'));if(controlVersion===this.version)return false;this.deviceIds=validateSyncDevices(values).deviceIds;this.version=controlVersion;this.error=null;return true;}
  catch(error){if(error.code!=='ENOENT')this.error=error.message;return false;}
 }
}
