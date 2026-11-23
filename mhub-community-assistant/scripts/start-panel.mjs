import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {PanelService,createPanelHandler,PANEL_PREFIX,panelBodyLimit} from '../panel-service.mjs';
import {readLanConfig,resolveLanBinding,createLanAccess,localizeLanRequest} from '../lan-access.mjs';
import {RuntimeResume} from '../runtime-resume.mjs';
import {readVersionStatus} from '../version-status.mjs';
import {runtimeVersion} from '../../harness-mhub-sync/runtime-version.mjs';
import {configureVoiceNetwork} from '../../harness-mhub-sync/voice-chat/network.mjs';

export function createPanelListener({handler,health,port=18782,lanAccess=null}){
 return async(req,res)=>{
  const client=new AbortController();
  res.once('close',()=>client.abort());
  const write=async response=>{
   res.writeHead(response.status,Object.fromEntries(response.headers));
   if(!response.body){res.end();return;}
   await pipeline(Readable.fromWeb(response.body),res);
  };
  if(!lanAccess&&!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)){res.writeHead(403).end();return;}
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   const limit=panelBodyLimit(pathname.startsWith(PANEL_PREFIX+'/')?pathname.slice(PANEL_PREFIX.length):'');
   const body=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit){res.writeHead(413).end();return;}body.push(chunk);}
   let request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,signal:client.signal,...(body.length?{body:Buffer.concat(body)}:{})});
   if(lanAccess){const denial=await lanAccess(request,req.socket.remoteAddress);if(denial){await write(denial);return;}request=localizeLanRequest(request,port);}
   if(req.url==='/health'&&req.method==='GET'){await write(Response.json(health(),{headers:{'cache-control':'no-store'}}));return;}
   if(req.url==='/'){res.writeHead(302,{location:PANEL_PREFIX+'/panel'}).end();return;}
   await write(await handler(request));
  }catch{if(!res.destroyed){if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"面板暂时无法响应"}');}}
 };
}
export function startPanel(){
 configureVoiceNetwork();
 const port=18782,service=new PanelService(),handler=createPanelHandler(service),servers=[];
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),lan={enabled:false,running:false,address:null,requireAuth:true,error:null};
 const instanceId=randomUUID(),startedAt=Date.now(),version=runtimeVersion();
 service.versionInfo=()=>readVersionStatus(service.stateDir,version);
 const resume=new RuntimeResume({syncRoot:path.resolve(root,'../harness-mhub-sync'),stateRoot:path.join(root,'state'),startup:service.controls.syncStartup,status:()=>service.controls.syncStatus(),recovery:()=>service.controls.recovery.status()});
 const health=()=>({service:'dafeiyu-panel',pid:process.pid,instanceId,startedAt,version,...service.versionInfo(),ok:true,lan,runtimeResume:resume.state});
 const record=()=>{try{fs.writeFileSync(path.join(root,'state/lan-status.json'),JSON.stringify({...lan,at:Date.now()}));}catch{}};
 const local=createServer(createPanelListener({handler,health,port}));servers.push(local);
 let retryTimer=null,resumeTimer=null,closing=false;
 const connectLan=()=>{
  if(closing||lan.running)return;
  try{
   const saved=readLanConfig(path.join(root,'state/lan-access.json'));if(!saved){record();return;}
   const config=resolveLanBinding(saved);
   Object.assign(lan,{enabled:true,address:config.address,requireAuth:config.requireAuth!==false});
   const remote=createServer(createPanelListener({handler,health,port,lanAccess:createLanAccess(config,{port})}));servers.push(remote);
   remote.once('error',error=>{
    const at=servers.indexOf(remote);if(at>=0)servers.splice(at,1);
    lan.running=false;lan.error='局域网入口未启动：'+error.code;lan.nextRetryAt=Date.now()+10000;record();
    if(!closing)retryTimer=setTimeout(connectLan,10000);
   });
   remote.listen(port,config.address,()=>{lan.running=true;lan.error=null;lan.nextRetryAt=null;record();console.log('LAN panel: http://'+config.address+':'+port);});
  }catch(error){lan.error=error.message;record();if(!closing)retryTimer=setTimeout(connectLan,10000);}
 };
 local.listen(port,'127.0.0.1',()=>{
  service.live2d.activate();service.companion.activate();
  console.log('Local panel: http://127.0.0.1:'+port);
  fs.writeFileSync(path.join(root,'state/panel-instance.json'),JSON.stringify({pid:process.pid,instanceId,startedAt,script:fileURLToPath(import.meta.url)}));
  connectLan();
  void resume.tick();void service.wallpapers.tick();resumeTimer=setInterval(()=>{void resume.tick();void service.wallpapers.tick();},5000);resumeTimer.unref();
 });
 process.once('SIGTERM',()=>{closing=true;clearTimeout(retryTimer);clearInterval(resumeTimer);resume.close();void service.dispose().finally(()=>{for(const server of servers){server.close();server.closeIdleConnections();}});});
 return {servers,service};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)startPanel();
