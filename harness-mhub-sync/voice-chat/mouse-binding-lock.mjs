import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function processAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return false;
 try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
const validPid=pid=>Number.isSafeInteger(pid)&&pid>0;
async function exists(file){try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function snapshot(file){
 try{return {text:await fs.readFile(file,'utf8'),stat:await fs.stat(file)};}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function same(a,b){return a&&b&&a.text===b.text&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a.stat[key]===b.stat[key]);}
function parsed(text){try{return JSON.parse(text);}catch{return null;}}
// Serialize stale-file removal across processes. Acquirers also check this
// short-lived guard before entering the hardware transaction.
async function reclaim(file,guard,staleMs){
 try{await fs.mkdir(guard);}catch(error){
  if(error.code!=='EEXIST')throw error;
  const owner=await snapshot(guard+'/owner.json');
  const stat=await fs.stat(guard).catch(()=>null);
  if(stat&&Date.now()-stat.mtimeMs>staleMs&&(!owner||!validPid(parsed(owner.text)?.pid)||!processAlive(parsed(owner.text).pid))){
   if(owner&&same(owner,await snapshot(guard+'/owner.json')))await fs.unlink(guard+'/owner.json').catch(()=>{});
   await fs.rmdir(guard).catch(()=>{});
  }
  return;
 }
 try{
  await fs.writeFile(guard+'/owner.json',JSON.stringify({pid:process.pid}));
  const before=await snapshot(file);if(!before)return;
  const record=parsed(before.text);
  if(validPid(record?.pid)){if(processAlive(record.pid))return;}
  else if(Date.now()-before.stat.mtimeMs<staleMs)return;
  // A just-created legacy file may still be receiving its owner record.
  await wait();if(same(before,await snapshot(file)))await fs.unlink(file);
 }finally{await fs.unlink(guard+'/owner.json').catch(()=>{});await fs.rmdir(guard).catch(()=>{});}
}
export async function withMouseBindingLock(file,action,{timeoutMs=5000,staleMs=30000}={}){
 file=file instanceof URL?fileURLToPath(file):file;
 const token=randomUUID(),record=JSON.stringify({pid:process.pid,token}),temporary=file+'.'+token+'.pending',guard=file+'.reclaim';
 const deadline=Date.now()+timeoutMs;
 // Publish a complete, flushed owner record atomically and exclusively. A
 // crash cannot leave a zero-filled public lock between open and write.
 const handle=await fs.open(temporary,'wx');
 try{await handle.writeFile(record);await handle.sync();}finally{await handle.close();}
 const release=async()=>{if((await snapshot(file))?.text===record)await fs.unlink(file);};
 try{
  while(true){
   if(!await exists(guard)){
    let acquired=false;
    try{await fs.link(temporary,file);acquired=true;}catch(error){if(error.code!=='EEXIST')throw error;}
    if(acquired){
     if(!await exists(guard)){try{return await action();}finally{await release();}}
     await release();
    }else await reclaim(file,guard,staleMs);
   }else await reclaim(file,guard,staleMs);
   if(Date.now()>=deadline)throw Error('鼠标绑定正在切换，请稍后重试。');
   await wait();
  }
 }finally{await fs.unlink(temporary).catch(()=>{});}
}
