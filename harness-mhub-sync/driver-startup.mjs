import net from 'node:net';
import {acquireSupervisorLock} from './process-lock.mjs';

// All callers share the same Windows mutex because they share one CDP port.
// Keep it until the interface is ready, not merely until CreateProcess returns.
export async function probeDriverPort({host='127.0.0.1',port=49763}={}){
 const server=net.createServer();
 return new Promise(resolve=>{
  server.once('error',error=>resolve({available:false,code:error.code}));
  server.listen({host,port,exclusive:true},()=>server.close(error=>resolve(error?{available:false,code:error.code}:{available:true})));
 });
}

export async function prepareDriver({probeDebug,probeRuntime,launch,persist=async()=>{},describeUnavailable,
 check=async()=>{},signal,clock=Date.now,wait,acquire=()=>acquireSupervisorLock({name:'DafeiyuMhubDriverStartup'}),portProbe=probeDriverPort,onStage=async()=>{}}){
 const checkpoint=async()=>{signal?.throwIfAborted();await check();signal?.throwIfAborted();};
 const inspect=async()=>{await checkpoint();const debug=await probeDebug();await checkpoint();if(debug.state==='occupied')throw Error(debug.error);return debug;};
 const ready=async()=>{
  let debug=await inspect();
  while(!debug.ready){await wait(300,signal);debug=await inspect();}
  return debug;
 };
 if((await inspect()).ready)return {ready:true,launched:false};
 await checkpoint();const lease=await acquire();
 if(!lease){
  await onStage('waiting-launcher','另一个启动入口正在准备 M HUB，等待同一联动接口…');
  await ready();return {ready:true,launched:false,shared:true};
 }
 let receipt;
 try{
  // The process/port snapshot taken by a caller before the mutex is stale.
  const existing=await inspect();
  if(existing.ready)return {ready:true,launched:false};
  if(existing.state==='initializing'){await ready();return {ready:true,launched:false};}
  const meta=await probeRuntime();await checkpoint();
  if(meta.debugListeners?.some(row=>row.ownerAlive===false))throw Error('旧 M HUB 已退出，但 49763 端口仍未释放。未重复启动驱动。');
  if(meta.mhubRunning){
   const recent=meta.mhubMain?.some(row=>row.debugRequested&&clock()-row.startedAt>=0&&clock()-row.startedAt<30000);
   if(!recent)throw Error(describeUnavailable(meta));
   await onStage('waiting-mhub','M HUB 已带联动参数启动，等待首次初始化…');await ready();return {ready:true,launched:false};
  }
  await onStage('checking-port','正在核对 M HUB 联动端口是否可用…');
  const deadline=clock()+6000;let port;
  do{
   await checkpoint();port=await portProbe();
   if(port.available)break;
   if((await inspect()).ready)return {ready:true,launched:false};
   if(!['EADDRINUSE','EACCES'].includes(port.code)||clock()>=deadline)throw Error('M HUB 联动端口 49763 暂不可用（'+(port.code??'UNKNOWN')+'），稍后自动重试；未启动第二个驱动。');
   await wait(400,signal);
  }while(true);
  // A vendor/Windows startup can race independently of our mutex.
  const current=await probeRuntime();await checkpoint();
  const finalCheck=await inspect();
  if(finalCheck.ready)return {ready:true,launched:false};
  if(finalCheck.state==='initializing'){await ready();return {ready:true,launched:false};}
  if(current.mhubRunning)throw Error(describeUnavailable(current));
  await onStage('opening-mhub','正在打开 M HUB 联动接口…');
  await checkpoint();receipt=await launch();
  if(receipt?.executable)await persist({...receipt,phase:'waiting-interface'});
  await onStage('waiting-mhub','M HUB 启动请求已受理，正在等待联动接口…');
  await ready();
  if(receipt?.executable)await persist({...receipt,phase:'ready',readyAt:clock()});
  return {ready:true,launched:true,receipt};
 }catch(error){
  if(receipt?.executable)await persist({...receipt,phase:'failed',failedAt:clock(),error:String(error.message).slice(0,350)}).catch(()=>{});
  throw error;
 }finally{lease.release();}
}
