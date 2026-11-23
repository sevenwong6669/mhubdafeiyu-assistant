import fs from 'node:fs/promises';
import path from 'node:path';
import {readDeviceLink,automaticStopAllowsResume} from '../harness-mhub-sync/device-link-mode.mjs';

// The panel remains available while the existing startup transaction waits for
// Harness/M HUB. This scheduler never clears a user's stop or owns hardware.
export class RuntimeResume {
 constructor({syncRoot,stateRoot,startup,status,recovery,clock=Date.now}){
  Object.assign(this,{syncRoot,stateRoot,startup,status,recovery,clock});
  this.pending=null;this.closed=false;this.nextAt=0;this.failures=0;
  this.state={phase:'checking'};
 }
 tick(){
  if(this.closed)return Promise.resolve();
  if(this.pending)return this.pending;
  const task=this.check().catch(error=>{this.defer('failed',error.message);}).finally(()=>{if(this.pending===task)this.pending=null;});
  this.pending=task;return task;
 }
 defer(phase,error){
  this.nextAt=this.clock()+Math.min(120000,10000*2**Math.min(this.failures++,4));
  this.state={phase,error,at:this.clock(),nextRetryAt:this.nextAt};
 }
 async wanted(){
  if(this.closed||!readDeviceLink(this.syncRoot).enabled)return false;
  if(!automaticStopAllowsResume(this.syncRoot))return false;
  let intent;
  try{intent=JSON.parse((await fs.readFile(path.join(this.stateRoot,'runtime-intent.json'),'utf8')).replace(/^\uFEFF/,''));}
  catch(error){if(error.code==='ENOENT')return false;throw Error('启动意愿配置无法读取，请检查配置后重试。');}
  return intent.sync===true;
 }
 async check(){
  if(!await this.wanted()){this.nextAt=0;this.failures=0;this.state={phase:'stopped',at:this.clock()};return;}
  if((await this.recovery?.())?.active){this.state={phase:'recovering',at:this.clock()};return;}
  const current=await this.status();
  if(current.supervised){this.failures=0;this.state={phase:current.ready?'running':'waiting',at:this.clock()};return;}
  // Do not claim or duplicate a live orphan controller. Explicit recovery can
  // inspect and release it; startup's ready fast path would not create a guard.
  if(current.running){this.state={phase:'unmanaged',at:this.clock(),error:'控制器仍在运行，缺少根守护，请使用重启插件恢复。'};return;}
  if(this.clock()<this.nextAt||this.startup.pending||this.startup.reserving)return;
  if(!await this.wanted())return;
  this.state={phase:'starting',at:this.clock()};
  await this.startup.request({automatic:true});
  await this.startup.pending;
  if(!await this.wanted()){this.state={phase:'stopped',at:this.clock()};return;}
  // Startup already reports its precise dependency error in startup-status.
  // Back off even after acceptance until a fresh guard heartbeat is observed.
  this.defer('waiting');
 }
 close(){this.closed=true;this.startup.cancel();}
}
