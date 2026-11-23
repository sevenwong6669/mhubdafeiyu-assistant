import fs from 'node:fs';
import path from 'node:path';
import {PANEL_PREFIX,PANEL_ASSET_ROUTES,PANEL_API_ROUTES,createPanelHandler,panelBodyLimit} from './panel-service.mjs';
import {stateDirectoryId} from './learning-client.mjs';
const TARGET='http://127.0.0.1:18782';
export function createNativeProxy({owner,stateDir,fetchImpl=fetch}){
 const assetHandler=createPanelHandler(null,{nativeTransport:true}),dataId=stateDirectoryId(stateDir);
 return async request=>{
  const url=new URL(request.url),route=url.pathname.slice(PANEL_PREFIX.length),asset=request.method==='GET'&&PANEL_ASSET_ROUTES.includes(route);
  const native=['dsh-app:','dsh:'].includes(url.protocol)&&url.hostname==='app',internal=url.origin==='http://dsh.internal';
  const source=request.headers.get('origin'),expected=internal?'dsh-app://app':`${url.protocol}//${url.host}`;
  if(!native&&!internal||!asset&&(source&&source!==expected||['cross-site','same-site'].includes(request.headers.get('sec-fetch-site'))))return Response.json({error:'仅接受 Harness 所有者页面的请求。'},{status:403});
  if(asset)return assetHandler(request);
  if(!url.pathname.startsWith(PANEL_PREFIX+'/')||!PANEL_API_ROUTES.includes(route)||!['GET','POST'].includes(request.method))return Response.json({error:'没有这个功能。'},{status:404});
  try{
   const body=request.method==='POST'?await request.arrayBuffer():null;
   if(body?.byteLength>panelBodyLimit(route))return new Response(null,{status:413});
   const headers={'origin':TARGET,'content-type':request.headers.get('content-type')??'application/json','x-mhub-panel-token':request.headers.get('x-mhub-panel-token')??'','x-dafeiyu-host-owner':owner,'x-dafeiyu-data-id':dataId};
   if(request.headers.has('range'))headers.range=request.headers.get('range');
   const timeout=AbortSignal.timeout(request.method==='GET'?7500:route==='/controls/tts'?195000:route.startsWith('/live2d/')?175000:40000);
   const response=await fetchImpl(TARGET+PANEL_PREFIX+route+url.search,{method:request.method,headers,...(body?{body}:{}),redirect:'error',signal:AbortSignal.any([request.signal,timeout])});
   return new Response(response.body,{status:response.status,headers:response.headers});
  }catch{
   let backend;try{backend=JSON.parse(fs.readFileSync(path.join(stateDir,'companion/native-host-status.json'),'utf8')).backend;}catch{}
   if(backend?.phase==='failed')return Response.json({code:'BACKEND_START_FAILED',error:String(backend.error??'后台未启动，请重新检查运行环境。').slice(0,240)},{status:503});
   return Response.json({error:'本机后台正在恢复，页面会自动重连；未保存的修改会保留。'},{status:503});
  }
 };
}
