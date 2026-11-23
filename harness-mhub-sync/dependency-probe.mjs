import {selectMhubPage} from '../mhub_light_sync_api.mjs';

const origin='http://127.0.0.1:49763';
function localSocket(value){
 try{const u=new URL(value);return u.protocol==='ws:'&&['127.0.0.1','localhost'].includes(u.hostname)&&u.port==='49763'&&!u.username&&!u.password;}catch{return false;}
}
// HTTP 200 alone is not a driver handshake. Never launch a second driver into
// an occupied port, or send commands to an unrelated local HTTP service.
export async function probeMhubDebug(fetchImpl=fetch,signal){
 let contacted=false,listResponded=false;
 const get=async route=>{
  const response=await fetchImpl(origin+route,{signal:AbortSignal.any([AbortSignal.timeout(1500),...(signal?[signal]:[])]),redirect:'error'});
  contacted=true;if(route==='/json/list')listResponded=true;
  if(!response.ok)throw Error('HTTP '+response.status);
  return response.json();
 };
 let version;
 try{version=await get('/json/version');}catch(error){signal?.throwIfAborted();return contacted?{ready:false,state:'occupied',error:'49763 返回了无法识别的服务，未启动或接管驱动。'}:{ready:false,state:'unavailable',error:'M HUB 联动端口尚未就绪。'};}
 if(!version||!/^\d+(?:\.\d+)*$/.test(version['Protocol-Version']??'')||!/(?:Chrome|Chromium|Electron)\//.test(version.Browser??'')||!localSocket(version.webSocketDebuggerUrl))return {ready:false,state:'occupied',error:'49763 返回了无法识别的服务，未启动或接管驱动。'};
 try{
  const targets=await get('/json/list');
  if(!Array.isArray(targets))throw Error('invalid list');
  const target=selectMhubPage(targets);
  if(!localSocket(target.webSocketDebuggerUrl))throw Error('invalid renderer socket');
  return {ready:true,state:'ready',browser:version.Browser,renderer:target.id??null};
 }catch(error){signal?.throwIfAborted();return {ready:false,state:'initializing',noResponse:!listResponded,error:'M HUB 主界面尚未就绪或版本不兼容，等待唯一的主界面连接。'};}
}
