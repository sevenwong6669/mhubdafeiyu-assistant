import {probeMhubDebug} from './dependency-probe.mjs';
import {runtimeProbe,unavailableMhubMessage} from './startup.mjs';
import {RecoveryGate,writeJson} from './resilience.mjs';

export const driverRetryDelay=failures=>Math.min(600000,500*2**Math.min(11,Math.max(0,failures-1)));

export class ControllerConnection extends RecoveryGate{
 constructor({clock=Date.now,debug=probeMhubDebug,runtime=runtimeProbe}={}){
  super(clock);
  Object.assign(this,{debug,runtime,diagnosis:null});
 }
 async fail(error){
  super.fail(error);
  if(this.failures>=3){
   const probe=await this.debug().catch(()=>null);
   if(probe?.ready)this.diagnosis=null;
   else if(probe){
    const status=await this.runtime({signal:AbortSignal.timeout(4000)}).catch(()=>null);
    const ordinary=probe.state==='unavailable'&&status?.mhubMain?.length&&status.mhubMain.every(row=>row.debugRequested===false);
    if(ordinary)this.diagnosis={code:'mhub-no-debug-port',message:unavailableMhubMessage(status)};
    else if((probe.state==='unavailable'||probe.noResponse)&&status?.mhubRunning)
      this.diagnosis={code:'mhub-unresponsive',message:'M HUB 无响应，请重启 M HUB。'};
    else this.diagnosis={code:probe.state,message:probe.error};
   }
  }
  const delay=driverRetryDelay(this.failures);
  this.nextAt=this.clock()+delay;
  return delay;
 }
 success(){this.diagnosis=null;return super.success();}
 snapshot(){return {...super.snapshot(),...(this.diagnosis?{code:this.diagnosis.code,error:this.diagnosis.message}:{})};}
}

export function createConnectionReporter(root){
 let published='';
 return async health=>{
  const {connection,at,pid}=health,key=JSON.stringify(connection);
  if(key!==published){
   try{await writeJson(new URL('sync-state.json',root),{connection,at,pid});published=key;}catch{}
  }
  await writeJson(new URL('controller-health.json',root),health).catch(()=>{});
 };
}
