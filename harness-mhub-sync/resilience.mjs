import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function writeJson(file,value,{io=fs,wait=sleep}={}){
  const tmp=new URL(String(file)+'.'+randomUUID()+'.tmp');
  try{
    await io.writeFile(tmp,JSON.stringify(value,null,2));
    for(let i=0;;i++){
      try{await io.rename(tmp,file);return;}
      catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||i>=11)throw error;await wait(Math.min(25*(i+1),150));}
    }
  }finally{await io.rm(tmp,{force:true}).catch(()=>{});}
}
export class RecoveryGate{
  constructor(clock=Date.now){this.clock=clock;this.failures=0;this.nextAt=0;this.lastError=null;this.recoveries=0;}
  get ready(){return this.clock()>=this.nextAt;}
  fail(error){this.failures++;this.lastError=String(error.message??error).slice(0,300);const delay=this.failures<3?500*2**(this.failures-1):Math.min(10000,2000*2**Math.min(3,this.failures-3));this.nextAt=this.clock()+delay;return delay;}
  success(){const recovered=this.failures>0;if(recovered)this.recoveries++;this.failures=0;this.nextAt=0;this.lastError=null;return recovered;}
  snapshot(){return {state:this.failures>=3?'open':this.failures?'reconnecting':'ready',failures:this.failures,nextRetryAt:this.nextAt,error:this.lastError,recoveries:this.recoveries};}
}
export class RestartPolicy{
  constructor(clock=Date.now){this.clock=clock;this.failures=0;this.startedAt=0;}
  started(){this.startedAt=this.clock();}
  exited(){if(this.clock()-this.startedAt>=60000)this.failures=0;return Math.min(15000,500*2**Math.min(this.failures++,5));}
}
