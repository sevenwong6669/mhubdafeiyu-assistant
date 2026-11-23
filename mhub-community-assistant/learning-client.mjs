import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
export const stateDirectoryId=directory=>createHash('sha256').update(process.platform==='win32'?path.resolve(directory).toLowerCase():path.resolve(directory)).digest('hex');
const ORIGIN='http://127.0.0.1:18782',PREFIX='/api/mhub-community';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class LearningClient{
 constructor({fetchImpl=fetch,version='0.10.0',intervalMs=5000,owner=randomUUID(),timers=globalThis,stateDir}={}){Object.assign(this,{fetch:fetchImpl,version,intervalMs,owner,timers});this.dataId=stateDir?stateDirectoryId(stateDir):null;this.token=null;this.stopped=true;this.pending=null;}
 async state(signal){const response=await this.fetch(ORIGIN+PREFIX+'/learning/state',{headers:this.dataId?{'x-dafeiyu-data-id':this.dataId}:{},signal:AbortSignal.any([AbortSignal.timeout(3000),...(signal?[signal]:[])])});if(!response.ok)throw Error('本机学习服务尚未就绪，或与插件数据目录不一致。');const value=await response.json();this.token=value.token;return value;}
 async call(route,input,signal){
  if(!this.token)await this.state(signal);
  const send=()=>this.fetch(ORIGIN+PREFIX+route,{method:'POST',headers:{'content-type':'application/json','x-mhub-panel-token':this.token,...(this.dataId?{'x-dafeiyu-data-id':this.dataId}:{})},body:JSON.stringify(input),signal:AbortSignal.any([AbortSignal.timeout(4000),...(signal?[signal]:[])])});
  let response=await send();if(response.status===403){await this.state(signal);response=await send();}
  const value=await response.json();if(!response.ok)throw Error(value.error??'学习服务暂不可用。');return value;
 }
 async tick(){if(this.stopped||this.pending)return;const task=this.call('/learning/host',{action:'tick',owner:this.owner,version:this.version},this.abort.signal);this.pending=task;try{this.last=await task;this.error=null;}catch(error){this.error=error.message;}finally{if(this.pending===task)this.pending=null;}}
 start(){if(!this.stopped)return;this.stopped=false;this.abort=new AbortController();void this.tick();this.timer=this.timers.setInterval(()=>{void this.tick();},this.intervalMs);this.timer.unref?.();}
 async stop(){if(this.stopped)return;this.stopped=true;this.timers.clearInterval(this.timer);this.abort.abort();await this.pending?.catch(()=>{});try{await this.call('/learning/host',{action:'release',owner:this.owner,version:this.version});}catch{}}
 async runAndWait(){const job=await this.call('/learning/run',{});const until=Date.now()+75000;while(Date.now()<until){const state=await this.state();if(state.schedule.job?.id===job.id&&state.schedule.job.status!=='running')return state.schedule.job;await pause(500);}throw Error('整理仍未返回结果，请在后台查看运行状态，未重复执行。');}
}
