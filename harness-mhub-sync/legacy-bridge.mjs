import fs from 'node:fs/promises';
import path from 'node:path';
import {processIdentity} from '../mhub-community-assistant/process-identity.mjs';

// Old installations may still have the NAS-era writer. Stop only a verified
// owner; a stale PID file must not block the new standalone controller.
export async function stopLegacyBridge({directory,identity=processIdentity,clock=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=10000}={}){
 const file=path.join(directory,'bridge.pid'),script=path.join(directory,'bridge.mjs');
 let raw;try{raw=await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return {stopped:true,reason:'absent'};throw error;}
 const pid=Number(raw),initial=await identity(pid,script);
 const retire=async()=>{try{if(await fs.readFile(file,'utf8')===raw)await fs.rm(file,{force:true});}catch(error){if(error.code!=='ENOENT')throw error;}};
 if(initial.matches===false){await retire();return {stopped:true,reason:'stale-pid'};}
 if(initial.matches!==true||!Number.isFinite(initial.startedAt))throw Error('无法核对旧设备桥接进程，已保留该进程。');
 await fs.writeFile(path.join(directory,'stop.request'),'standalone-controller');
 const until=clock()+timeoutMs;
 while(clock()<until){
  const current=await identity(pid,script);
  if(current.matches===false){await retire();return {stopped:true,reason:'released'};}
  if(current.matches!==true||current.startedAt!==initial.startedAt)throw Error('旧设备桥接进程身份已变化，未启动新的硬件写入。');
  await wait(Math.min(200,Math.max(0,until-clock())));
 }
 throw Error('旧设备桥接仍未退出，请停止该桥接后重试。');
}
