import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deviceInventory} from '../devices.mjs';
import {KnowledgeStore} from '../assistant.mjs';
import {CommunityClient,normalizeShare,communityDeviceNames,sameCommunityDevice,hash} from '../community.mjs';
import {learningError} from '../learning-errors.mjs';
import {writeJson} from '../../harness-mhub-sync/resilience.mjs';

export async function learnCommunity(options={}){
 const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),stateDir=options.stateDir??path.join(root,'state');
 const now=options.now??Date.now,signal=AbortSignal.any([AbortSignal.timeout(60000),...(options.signal?[options.signal]:[])]);
 const progress=options.onProgress??(()=>{}),client=options.client??new CommunityClient(),store=options.store??new KnowledgeStore(stateDir);
 signal.throwIfAborted();progress({stage:'reading-devices',requests:0});
 const inventory=await (options.inventoryImpl??deviceInventory)(stateDir,{signal,now});signal.throwIfAborted();
 // Validate existing knowledge before external requests; never replace a damaged file.
 store.read();
 const fetchedAt=new Date(now()).toISOString(),seen=new Map(),results=[],devices=inventory.devices,jobs=[];
 for(const d of devices){if(d.family==='mouse')jobs.push({category:2001,device:d.model});if(d.family==='keyboard')for(const category of [1001,1002,1003])jobs.push({category,device:d.model});}
 if(devices.some(d=>d.family==='mouse'))jobs.push({category:2002});
 if(devices.some(d=>d.family==='keyboard'))jobs.push({category:1004});
 if(devices.some(d=>['headset','speaker'].includes(d.family)))jobs.push({category:3001});
 let requests=0;
 for(const job of jobs.slice(0,8)){
  signal.throwIfAborted();requests++;progress({stage:'reading-community',requests,planned:Math.min(jobs.length,8),category:job.category});
  const query={category1:Math.floor(job.category/1000),category2:job.category,deviceName:communityDeviceNames(job.category,job.device),tag:'',keyword:'',sort:2,page:1,size:20};
  try{
   const response=await client.search(query,{signal});signal.throwIfAborted();let kept=0;
   for(const raw of response.items){const item=normalizeShare(raw,{queriedCategory:job.category,fetchedAt});if(!item)continue;if([1001,1002,1003,2001,3001].includes(job.category)&&!devices.some(d=>sameCommunityDevice(job.category,d.model,item.device)))continue;seen.set(hash(item.shareCode),item);kept++;}
   results.push({...job,sourceTotal:response.total,observed:response.items.length,kept,ok:true});
  }catch(error){signal.throwIfAborted();const failure=learningError(error);results.push({...job,ok:false,error:failure.message,errorKind:failure.code});}
 }
 signal.throwIfAborted();options.assertOwner?.();progress({stage:'saving-knowledge',requests});
 let counts={added:0,changed:0,totalStored:Object.keys(store.read().observations).length};
 if(seen.size)counts=store.update(state=>{let added=0,changed=0;for(const [key,item] of seen){const previous=state.observations[key];if(!previous)added++;else if(previous.contentHash!==item.contentHash)changed++;state.observations[key]={...previous,...item};}return {added,changed,totalStored:Object.keys(state.observations).length};});
 signal.throwIfAborted();options.assertOwner?.();
 const receipt={fetchedAt,completedAt:new Date(now()).toISOString(),mode:'bounded-read-only-refresh',inventory,results,...counts,requests,failed:results.filter(x=>!x.ok).length,noDeviceScope:!jobs.length,usedHistoricalDevices:!!inventory.stale,hardwareWrites:0,outboundMessages:0,coverage:'每类只检查当前排序第一页，最多八次请求；不代表完整覆盖社区。键盘与音频型号别名可能漏掉结果。'};
 await writeJson(pathToFileURL(path.join(stateDir,'learning-last-run.json')),receipt);
 progress({stage:'completed',requests});return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {LearningClient}=await import('../learning-client.mjs');const client=new LearningClient();
 const result=await client.runAndWait();console.log(JSON.stringify(result));if(result.status!=='completed')process.exitCode=1;
}
