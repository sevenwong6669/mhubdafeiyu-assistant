export const SYNTHESIS_TIMEOUT_MS=120000;
export function idleForShutdown(value){
 return !value.phoneActive&&!value.request&&!value.nativeTurn&&!value.ttsOperation&&!value.playing&&!value.producing&&!value.speechJobs;
}
export function abortable(task,signal){
 const pending=Promise.resolve(task);
 if(!signal)return pending;
 // The caller may have created its async task before noticing cancellation.
 // Observe its eventual rejection even when there is nothing left to await.
 if(signal.aborted){pending.catch(()=>{});return Promise.reject(signal.reason);}
 return new Promise((resolve,reject)=>{
  const aborted=()=>reject(signal.reason);
  signal.addEventListener('abort',aborted,{once:true});
  pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
 });
}
// A cancelable synthesis owns its worker exclusively. Killing that worker can
// then abort an upstream HTTP request without cancelling unrelated utterances.
export function cancellableWorker(handle){
 const run=handle.run.bind(handle);handle.busy=0;handle.exclusive=false;
 handle.run=async(data,progress,{signal}={})=>{
  signal?.throwIfAborted();
  if(handle.exclusive||signal&&handle.busy)throw Error('语音合成正在使用，请稍后重试。');
  if(signal)handle.exclusive=true;handle.busy++;
  let aborted;
  const cancellation=signal?new Promise((resolve,reject)=>{
   aborted=()=>{Promise.resolve().then(()=>handle.dispose()).then(()=>reject(signal.reason),()=>reject(signal.reason));};
   signal.addEventListener('abort',aborted,{once:true});
  }):null;
  try{const result=await(cancellation?Promise.race([run(data,progress),cancellation]):run(data,progress));signal?.throwIfAborted();return result;}
  finally{signal?.removeEventListener('abort',aborted);handle.busy--;if(signal)handle.exclusive=false;}
 };
 return handle;
}
export class SpeechJobs{
 constructor({timeoutMs=SYNTHESIS_TIMEOUT_MS}={}){this.timeoutMs=timeoutMs;this.jobs=new Map();}
 async run({speechId,owner,signal},action){
  if(this.jobs.size)throw Error('上一句语音仍在生成或取消，请稍后重试。');
  const controller=new AbortController(),job={speechId,owner,controller};
  const timeout=AbortSignal.timeout(this.timeoutMs);
  job.signal=AbortSignal.any([controller.signal,timeout,...(signal?[signal]:[])]);
  job.signal.throwIfAborted();this.jobs.set(speechId,job);
  try{return await action(job.signal);}
  finally{if(this.jobs.get(speechId)===job)this.jobs.delete(speechId);}
 }
 cancelOwner(owner){for(const job of this.jobs.values())if(job.owner===owner)job.controller.abort(new DOMException('通话已结束','AbortError'));}
 cancelAll(){for(const job of this.jobs.values())job.controller.abort(new DOMException('语音已取消','AbortError'));}
}
