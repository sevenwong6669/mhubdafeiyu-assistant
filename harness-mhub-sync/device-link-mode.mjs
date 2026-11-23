import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('./',import.meta.url));
export const DEVICE_LINK_PAUSED='设备联动总开关已关闭，请先在总览开启。';

// Loss of the supervisor's mutex helper is an internal release condition,
// including Windows shutdown. It does not revoke saved user startup intent.
// Unknown, unreadable and explicit user stop requests remain authoritative.
export function automaticStopAllowsResume(rootDir=root){
  try{return fs.readFileSync(path.join(rootDir,'stop.request'),'utf8').trim()==='mutex-lost';}
  catch(error){return error.code==='ENOENT';}
}

export function readDeviceLink(rootDir=root){
  try{
    const value=JSON.parse(fs.readFileSync(path.join(rootDir,'device-link-mode.json'),'utf8'));
    if(typeof value?.enabled==='boolean')return value;
  }catch(error){if(error.code==='ENOENT')return {enabled:true};}
  return {enabled:false,invalid:true};
}

export function requireDeviceLink(rootDir){
  if(!readDeviceLink(rootDir).enabled)throw Error(DEVICE_LINK_PAUSED);
}

export function setDeviceLink(rootDir,value){
  const file=path.join(rootDir,'device-link-mode.json');
  const temporary=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({...value,at:Date.now()}),{flag:'wx'});
  fs.renameSync(temporary,file);
}

export async function withDeviceWrite(write,rootDir=root){
  requireDeviceLink(rootDir);
  const file=path.join(rootDir,`device-write-${process.pid}-${randomUUID()}.lease`);
  fs.writeFileSync(file,String(Date.now()),{flag:'wx'});
  try{requireDeviceLink(rootDir);return await write();}
  finally{fs.rmSync(file,{force:true});}
}

export function deviceWritePending(rootDir=root){
  try{return fs.readdirSync(rootDir).some(name=>{
    const match=/^device-write-(\d+)-[a-f0-9-]+\.lease$/.exec(name);
    if(!match)return false;
    try{if(Date.now()-fs.statSync(path.join(rootDir,name)).mtimeMs>150000)return false;}catch{return false;}
    try{process.kill(Number(match[1]),0);return true;}catch(error){return error.code==='EPERM';}
  });}catch{return false;}
}
