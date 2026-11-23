import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {writeJson} from './resilience.mjs';
const root=new URL('./',import.meta.url);
export function communityTaskState(record,{now=Date.now(),alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}}={}){
 if(!record?.active||!/^[a-f0-9-]{36}$/.test(record.id??'')||!Number.isInteger(record.pid)||record.pid<=0
  ||!Number.isFinite(record.at)||now-record.at<0||now-record.at>10000||record.until<=now||record.until>now+185000||!alive(record.pid))return null;
 return {id:record.id,stage:record.stage??'thinking',keyboardId:record.keyboardId??null,at:record.at};
}
export function communityRawState(harness,job){return job&&['IDLE','SUCCESS','DISCONNECTED'].includes(harness)?'BUSY':harness;}
export const communityWriting=job=>!!job&&['preparing-write','writing'].includes(job.stage);
export async function readCommunityTask(file=new URL('voice-community-task.json',root)){
 try{return communityTaskState(JSON.parse(await fs.readFile(file,'utf8')));}catch{return null;}
}
// The existing voice job is also the scoped lighting lease; no extra daemon.
export class CommunityWork {
 constructor({file=new URL('voice-community-task.json',root),statusFile=new URL('control-status.json',root),clock=Date.now}={}){Object.assign(this,{file:file instanceof URL?file:pathToFileURL(file),statusFile:statusFile instanceof URL?statusFile:pathToFileURL(statusFile),clock});this.tail=Promise.resolve();}
 async read(){try{return JSON.parse(await fs.readFile(this.file,'utf8'));}catch{return null;}}
 async run(id,operation){
  if(this.running)throw Error('已有社区任务在处理，请稍后再试。');
  this.running=true;
  try{
  const previous=await this.read();
  if(communityTaskState(previous)&&previous.id!==id)throw Error('已有社区任务在处理，请稍后再试。');
  const job={id:id??randomUUID(),pid:process.pid,active:true,stage:'thinking',at:this.clock(),until:this.clock()+180000};
  const enqueue=fn=>{const result=this.tail.then(fn);this.tail=result.catch(()=>{});return result;};
  const current=async()=>{const disk=await this.read();return job.active&&this.clock()<job.until&&disk?.id===job.id&&disk.active===true;};
  const publish=()=>enqueue(async()=>{if(await current())await writeJson(this.file,{...job,at:this.clock()});});
  await enqueue(()=>writeJson(this.file,job));
  const timer=setInterval(()=>void publish().catch(()=>{job.active=false;}),2000);timer.unref();
  const work={id:job.id,current,async requireCurrent(){if(!await current())throw Error('社区任务已取消或过期，未继续写入。');},
   prepareWrite:async keyboardId=>{
    job.stage='preparing-write';job.keyboardId=keyboardId;await publish();
    const deadline=this.clock()+20000;
    while(this.clock()<deadline){
     await work.requireCurrent();
     try{const s=JSON.parse(await fs.readFile(this.statusFile,'utf8'));
      if(this.clock()-s.at>=0&&this.clock()-s.at<5000&&s.communityTask?.id===job.id&&s.communityTask.keyboardReleased===true){job.stage='writing';await publish();return;}
     }catch{}
     await new Promise(r=>setTimeout(r,200));
    }
    throw Error('尚未确认键盘灯光写入通道已释放，请开启设备联动并重试确认。');
   }};
  try{return await operation(work);}finally{
   job.active=false;clearInterval(timer);
   await enqueue(async()=>{if((await this.read())?.id===job.id)await writeJson(this.file,{...job,at:this.clock()});});
  }
  }finally{this.running=false;}
 }
}
