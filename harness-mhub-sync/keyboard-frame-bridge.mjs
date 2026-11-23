import {runtime} from '../runtime-paths.mjs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
export const KEYBOARD_MODELS=JSON.parse(fs.readFileSync(new URL('keyboard-models.json',import.meta.url),'utf8'));

export function keyboardFrame(value){
 const spec=value&&Object.hasOwn(KEYBOARD_MODELS,value.deviceId)?KEYBOARD_MODELS[value.deviceId]:null;
 if(!spec||!Array.isArray(value.colors)||value.colors.length<(spec.minimumFrameBytes??spec.frameBytes)||value.colors.length>384||value.colors.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('Invalid keyboard RGB frame');
 const colors=value.colors.slice(0,spec.frameBytes);while(colors.length<spec.frameBytes)colors.push(0);
 return {enabled:true,deviceId:value.deviceId,at:Date.now(),colors};
}
export class KeyboardFrameBridge{
 constructor({spawnImpl=spawn,clock=Date.now}={}){this.spawn=spawnImpl;this.clock=clock;this.token=randomBytes(32).toString('hex');this.workers=new Map();this.status={state:'waiting'};this.enabled=true;}
 async start(){
  this.server=createServer(async(req,res)=>{
   res.setHeader('access-control-allow-origin','*');
   if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-methods':'POST','access-control-allow-headers':'content-type,x-dafeiyu-frame'}).end();return;}
   const token=Buffer.from(String(req.headers['x-dafeiyu-frame']??'')),expected=Buffer.from(this.token);
   if(req.url!=='/frame'||req.method!=='POST'||token.length!==expected.length||!timingSafeEqual(token,expected)){res.writeHead(403).end();return;}
   try{
    let text='';for await(const chunk of req){text+=chunk;if(text.length>5000)throw Error('Frame too large');}
     if(!this.enabled||expected.toString()!==this.token){res.writeHead(409).end();return;}
    const value=JSON.parse(text),items=value.enabled===false?[]:value.frames??[value];
    if(!Array.isArray(items)||items.length>2)throw Error('Invalid keyboard frame batch');
    const frames=items.map(keyboardFrame);if(new Set(frames.map(f=>f.deviceId)).size!==frames.length)throw Error('Duplicate keyboard');
    for(const frame of frames)this.writeFrame(frame);
    for(const [id,worker] of this.workers)if(!frames.some(f=>f.deviceId===id))this.pauseWorker(worker);
    res.writeHead(204).end();
   }catch{res.writeHead(400).end();}
  });
  await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(18783,'127.0.0.1',resolve);});
 }
 ensureWorker(deviceId){
  let worker=this.workers.get(deviceId);if(!worker){worker={child:null,failures:0,retryAt:0};this.workers.set(deviceId,worker);}
  if(worker.child||this.clock()<worker.retryAt)return worker;
  let child,finished=false;
  const finish=error=>{
   if(finished)return;finished=true;
   if(worker.child===child){this.discardOutput(worker);worker.child=null;}
   if(this.enabled){worker.failures++;worker.retryAt=this.clock()+Math.min(5000,500*2**Math.min(4,worker.failures-1));this.status={state:'reconnecting',deviceId,at:this.clock(),nextRetryAt:worker.retryAt,...(error?{error:error.message}:{})};worker.status=this.status;}
  };
  try{child=this.spawn(runtime.python,['-X','utf8',fileURLToPath(new URL('native_keyboard_writer.py',import.meta.url)),'--parent',String(process.pid),'--device',deviceId,...(this.mainOnly?['--main-only']:[])],{windowsHide:true,stdio:['pipe','pipe','ignore']});}
  catch(error){finish(error);return worker;}
  worker.child=child;
  createInterface({input:child.stdout}).on('line',line=>{if(finished||worker.child!==child)return;try{this.status=JSON.parse(line);worker.status=this.status;if(this.status.state==='running'){worker.failures=0;worker.retryAt=0;}}catch{}});
  child.stdin.on('error',()=>{});child.on('error',finish);
  child.on('exit',()=>finish());child.on('close',()=>finish());
  return worker;
 }
 outputFor(worker){
  const child=worker.child;if(!child)return null;
  if(worker.output?.child===child)return worker.output;
  this.discardOutput(worker);
  const output={child,blocked:false,ending:false,pendingFrame:null,pause:false,paused:false};
  output.drain=()=>{if(worker.child!==child||worker.output!==output||output.ending)return;output.blocked=false;this.flushOutput(worker,output);};
  child.stdin.on?.('drain',output.drain);worker.output=output;return output;
 }
 discardOutput(worker){
  const output=worker.output;if(!output)return;
  output.ending=true;output.pendingFrame=null;output.pause=false;
  if(output.drain)output.child.stdin.removeListener?.('drain',output.drain);worker.output=null;
 }
 flushOutput(worker,output){
  if(worker.child!==output.child||worker.output!==output||output.ending||output.blocked||!output.child.stdin.writable)return;
  while(!output.blocked&&!output.ending&&(output.pause||output.pendingFrame)){
   let value;
   if(output.pause){value={enabled:false};output.pause=false;output.paused=true;}
   else{value=output.pendingFrame;output.pendingFrame=null;output.paused=false;}
   // A false return already accepted this one message. Retain at most the
   // latest unsent frame until drain instead of appending an animation backlog.
   try{output.blocked=output.child.stdin.write(JSON.stringify(value)+'\n')===false;}
   catch{output.blocked=true;output.pendingFrame=null;}
  }
 }
 pauseWorker(worker){
  const output=this.outputFor(worker);if(!output||output.ending)return;
  output.pendingFrame=null;if(!output.paused)output.pause=true;this.flushOutput(worker,output);
 }
 writeFrame(frame){
  if(this.mainOnly&&this.sidePalettes?.[frame.deviceId])frame={...frame,balanceColors:this.sidePalettes[frame.deviceId]};
  const worker=this.ensureWorker(frame.deviceId),output=this.outputFor(worker);if(!output||output.ending)return;
  output.pendingFrame=frame;this.flushOutput(worker,output);
 }
 allow(enabled){
  if(this.enabled!==enabled)this.token=randomBytes(32).toString('hex');
  this.enabled=enabled;
  if(!enabled)for(const w of this.workers.values())this.pauseWorker(w);
 }
 send(colors,deviceId='Ace 75 8K'){this.enabled=true;this.writeFrame(keyboardFrame({deviceId,colors}));}
 async stopWriter({restore=true}={}){
  // Keep each worker's backup until its stop command is handled. A preceding
  // pause message could discard it before the final restore runs.
  if(this.enabled)this.token=randomBytes(32).toString('hex');this.enabled=false;
  await Promise.all([...this.workers.values()].map(async w=>{const child=w.child;if(!child)return;this.discardOutput(w);
   // No unsent pause may precede stop: pause intentionally drops the native
   // backup, whereas stop must still restore it. end appends only this control.
   w.output={child,ending:true,pendingFrame:null,pause:false};
   let timer,onExit;
   const exited=new Promise(resolve=>{onExit=resolve;child.once('exit',onExit);});
   try{if(child.stdin.writable)child.stdin.end(JSON.stringify({command:'stop',restore})+'\n');}
   catch{/* A broken pipe still follows the bounded exit/kill cleanup. */}
   await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);
   clearTimeout(timer);child.removeListener('exit',onExit);if(child.exitCode===null)child.kill();
  }));
 }
 async close(){this.server?.close();await this.stopWriter();}
}
