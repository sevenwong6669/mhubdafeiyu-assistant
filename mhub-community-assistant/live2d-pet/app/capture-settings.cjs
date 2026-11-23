const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const keys=['call','watch'];

// This file stores unacknowledged local stops, never a second copy of settings.
// A user can stop capture immediately even while the backend is unavailable.
class CaptureSettings {
 constructor({file,post,onStop=()=>{},onChange=()=>{},onError=()=>{},storage}={}) {
  this.post=post;this.onStop=onStop;this.onChange=onChange;this.onError=onError;this.epochs={call:0,watch:0};this.busy=new Map();
  this.storage=storage??{read:()=>fs.readFileSync(file,'utf8'),write:value=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}};
  this.pending={version:1,call:false,watch:false};
  try {const saved=JSON.parse(this.storage.read());if(saved.version!==1||keys.some(k=>typeof saved[k]!=='boolean'))throw Error('停止标记格式无效');this.pending=saved;}
  catch(error){if(error.code!=='ENOENT'){this.pending={version:1,call:true,watch:true};this.notify('onError','采集停止标记无法读取，已保持停止：'+error.message);}}
 }
 notify(name,...args){try{this[name](...args);}catch(error){if(name!=='onError')try{this.onError('本地状态显示未更新：'+error.message);}catch{}}}
 blocked(key){return this.pending[key]===true;}
 mask(key,value){return this.blocked(key)?{...value,on:false}:value;}
 set(key,on) {
  if(!keys.includes(key)||typeof on!=='boolean')return Promise.resolve(false);
  const epoch=++this.epochs[key];
  if(!on){
   this.pending={...this.pending,[key]:true};
   try{this.storage.write(this.pending);}catch(error){this.notify('onError','本地已停止，停止标记尚未保存：'+error.message);}
   this.notify('onStop',key);this.notify('onChange',key);
  }
  const previous=this.busy.get(key)??Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
   try {
    const result=await this.post('/ext/live2d/'+key+'-config',{on},8000);
    if(result?.ok===false)throw Error(result.message||result.error||'设置未保存');
    if(result?.[key]?.on!==on)throw Error('后台尚未确认采集开关状态');
    if(this.epochs[key]===epoch){const next={...this.pending,[key]:false};this.storage.write(next);this.pending=next;}
    this.notify('onChange',key);return true;
   }catch(error){this.notify('onError',(on?'开启失败：':'本地已停止，等待后台保存：')+error.message);return false;}
  }).finally(()=>{if(this.busy.get(key)===task)this.busy.delete(key);this.notify('onChange',key);});
  this.busy.set(key,task);return task;
 }
 retryPending(){for(const key of keys)if(this.blocked(key)&&!this.busy.has(key))void this.set(key,false);}
}
module.exports={CaptureSettings};
