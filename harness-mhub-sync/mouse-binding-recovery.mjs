import fs from 'node:fs/promises';
import {mouseMode} from './voice-chat/mouse.mjs';
import {processAlive} from './voice-chat/mouse-binding-lock.mjs';
import {writeJson} from './resilience.mjs';
const folder=new URL('voice-chat/',import.meta.url);
async function optional(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}

// This controller never starts the microphone or models. It only releases a
// temporary physical binding after its voice process has demonstrably exited.
export class MouseBindingRecovery{
 constructor({root=folder,restore=()=>mouseMode(false,'native',{ifVoiceInactive:true}),alive=processAlive,fetchImpl=fetch,now=Date.now,publish=writeJson}={}){
  Object.assign(this,{root,restore,alive,fetch:fetchImpl,now,publish});this.last=0;this.retryAt=0;this.closed=false;this.status={phase:'checking'};
 }
 poll(){
  if(this.closed||this.pending||this.now()<this.retryAt||this.now()-this.last<1500)return this.pending;
  this.last=this.now();const task=this.check().catch(error=>{this.retryAt=this.now()+5000;this.status={phase:'retrying',error:error.message};}).finally(async()=>{
   try{await this.publish(new URL('mouse-binding-status.json',this.root),{...this.status,parent:process.pid,at:this.now()});}catch{}
   if(this.pending===task)this.pending=null;
  });this.pending=task;return task;
 }
 async check(){
  const mode=await optional(new URL('mouse-mode.json',this.root));
  if(!mode?.enabled){this.deadSince=undefined;this.status={phase:'macro',error:null};return;}
  const server=await optional(new URL('server.pid',this.root));
  if(this.alive(mode.ownerPid)||this.alive(server)){this.deadSince=undefined;this.status={phase:'voice',error:null};return;}
  // A newly starting server can listen before writing its PID file.
  try{const r=await this.fetch('http://127.0.0.1:18780/status',{signal:AbortSignal.timeout(800)});if(r.ok){this.deadSince=undefined;this.status={phase:'voice',error:null};return;}}catch{}
  if(this.deadSince===undefined){this.deadSince=this.now();this.status={phase:'waiting',error:null};return;}
  if(this.now()-this.deadSince<2000)return;
  const result=await this.restore();this.deadSince=undefined;
  this.status={phase:result.reason==='voice-running'?'voice':'restored',error:null,restoredAt:this.now()};
 }
 async close(){this.closed=true;await this.pending;}
}
