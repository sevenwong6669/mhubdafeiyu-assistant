import fs from 'node:fs/promises';
import {writeJson} from './resilience.mjs';
export function commandExpired(command,now=Date.now()){
 const durable=['screen-device-asset','device-default-theme','rgb-device-asset-play','rgb-device-asset-stop'];
 return !command||!Number.isFinite(command.at)||Math.abs(now-command.at)>(durable.includes(command.kind)?180000:10000);
}
export async function recoverCommands(root){
 const processing=new URL('interaction-processing/',root),receipts=new URL('asset-receipts/',root);await fs.mkdir(processing,{recursive:true});await fs.mkdir(receipts,{recursive:true});
 const fail=async id=>{if(!/^[a-f0-9-]{36}$/.test(id??''))return;const receipt=new URL(id+'.json',receipts);try{await fs.access(receipt);}catch{await writeJson(receipt,{ok:false,error:'上次操作被中断，已保留素材；请核对设备后重新应用。',at:Date.now()});}};
 for(const name of (await fs.readdir(processing)).filter(n=>n.endsWith('.json'))){const file=new URL(name,processing);let c;try{c=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error instanceof SyntaxError){await fs.rename(file,new URL(name+'.invalid',processing));continue;}throw error;}await fail(c.id);await fs.rm(file,{force:true});}
 // Legacy controllers removed the inbox before recording a claim. Reconcile
 // only an old orphan, never a producer in the middle of publishing its inbox.
 try{const lock=JSON.parse(await fs.readFile(new URL('device-asset-upload.lock',root),'utf8'));const inbox=await fs.readdir(new URL('interaction-inbox/',root)).catch(()=>[]);if(Date.now()-lock.at>180000&&!inbox.some(n=>n.includes(lock.id)))await fail(lock.id);}catch(error){if(error.code!=='ENOENT')throw error;}
}
