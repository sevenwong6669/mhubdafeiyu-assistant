// Restricted adapter for the real M HUB lightSync2 store; no GUI clicks.
// Temporary M HUB launch flag: --remote-debugging-port=49763
// node mhub_light_sync_api.mjs status|verify|enabled|scene|light|device [JSON]
import fs from 'node:fs/promises';

const PORT=49763;
const EFFECTS=['steady','breathing','center-breathing','expansion','wave','rainbow','time-cycle','music','screen'];
const INPUT_ACTIONS=new Set(['status','verify','enabled','scene','light','device','view']);

function validate(action,input){
  if(!INPUT_ACTIONS.has(action))throw Error('Unsupported action');
  if(['status','verify','view'].includes(action))return {};
  if(action==='enabled'){
    if(typeof input.enabled!=='boolean')throw Error('enabled must be boolean');
    return {enabled:input.enabled};
  }
  if(action==='scene'){
    if(typeof input.id!=='string'||!input.id||input.id.length>160)throw Error('Invalid scene id');
    return {id:input.id};
  }
  if(action==='device'){
    if(typeof input.id!=='string'||!input.id||typeof input.selected!=='boolean')throw Error('Invalid device selection');
    return {id:input.id,selected:input.selected};
  }
  const allowed=new Set(['effect','brightness','speed','color','mode','direction']);
  for(const key of Object.keys(input))if(!allowed.has(key))throw Error(`Unsupported light field: ${key}`);
  if(input.effect!==undefined&&!EFFECTS.includes(input.effect))throw Error('Unknown effect');
  if(input.brightness!==undefined&&(!Number.isFinite(input.brightness)||input.brightness<0||input.brightness>100))throw Error('brightness must be 0..100');
  if(input.speed!==undefined&&(!Number.isInteger(input.speed)||input.speed<1||input.speed>5))throw Error('speed must be 1..5');
  if(input.color!==undefined&&!/^#[0-9a-f]{6}$/i.test(input.color))throw Error('color must be #RRGGBB');
  if(input.mode!==undefined&&!['solid','rainbow','linear','gradient','day-night','custom'].includes(input.mode))throw Error('Unknown mode');
  if(input.direction!==undefined&&!['left','right','up','down','inward','outward'].includes(input.direction))throw Error('Unknown direction');
  if(!Object.keys(input).length)throw Error('No light parameters supplied');
  return input;
}

export function selectMhubPage(targets){
  const pages=targets.filter(target=>{
    if(target.type!=='page'||typeof target.url!=='string')return false;
    try{
      const url=new URL(target.url);
      return url.protocol==='mchose-renderer:'&&/^app(?:-\d+)?$/.test(url.hostname)
        &&/^\/(?:cdn\.mchose\.com\.cn\/)?customPage\/(?:\d+|prod)\/index\.html$/.test(url.pathname);
    }catch{return false;}
  });
  if(pages.length!==1)throw Error(`Expected one M HUB main renderer; found ${pages.length}`);
  return pages[0];
}

async function connect({signal}={}){
  signal?.throwIfAborted();
  const response=await fetch(`http://127.0.0.1:${PORT}/json/list`,{signal:AbortSignal.any([AbortSignal.timeout(2500),...(signal?[signal]:[])])});
  if(!response.ok)throw Error(`Debug target list: HTTP ${response.status}`);
  const targets=await response.json();
  const address=new URL(selectMhubPage(targets).webSocketDebuggerUrl);
  if(address.hostname!=='127.0.0.1'&&address.hostname!=='localhost')throw Error('Only local debugging is allowed');
  signal?.throwIfAborted();const socket=new WebSocket(address);
  return createDebugClient(socket,{signal});
}

export async function createDebugClient(socket,{openTimeout=2500,signal}={}){
  await new Promise((resolve,reject)=>{
    let timer;const clean=()=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',failed);signal?.removeEventListener('abort',cancelled);};
    const cancelled=()=>{clean();socket.close();reject(signal.reason);};
    const opened=()=>{clean();resolve();},failed=()=>{clean();reject(Error('M HUB connection unavailable'));};
    socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',failed,{once:true});
    timer=setTimeout(()=>{clean();socket.close();reject(Error('M HUB connection timed out'));},openTimeout);
    if(signal?.aborted)cancelled();else signal?.addEventListener('abort',cancelled,{once:true});
  });
  let sequence=0;const pending=new Map();
  let closed=false;
  const rejectPending=()=>{closed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('M HUB connection closed'));}pending.clear();};
  const aborted=()=>{rejectPending();socket.close();};signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  socket.addEventListener('close',rejectPending);socket.addEventListener('error',rejectPending);
  socket.addEventListener('message',({data})=>{
    let response;try{response=JSON.parse(data);}catch{return;}const item=pending.get(response.id);if(!item)return;
    pending.delete(response.id);clearTimeout(item.timer);
    response.error?item.reject(Error(response.error.message)):item.resolve(response.result);
  });
  return {
    call(method,params,timeoutMs=8000){return new Promise((resolve,reject)=>{
      if(closed){reject(Error('M HUB connection closed'));return;}
      const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Debug call timed out'));},timeoutMs);
      pending.set(id,{resolve,reject,timer});try{socket.send(JSON.stringify({id,method,params}));}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
    });},
    close(){signal?.removeEventListener('abort',aborted);rejectPending();socket.close();}
  };
}

export {connect as connectMhubDebug};

async function rendererCall(action,input){
  const app=document.querySelector('#app')?.__vue_app__;
  const store=app?.config?.globalProperties?.$pinia?._s?.get('lightSync2');
  if(!store)throw Error('M HUB lightSync2 store is not initialized');
  const describe=()=>({masterEnabled:store.masterEnabled,activeSceneId:store.activeSceneId,
    uiRoute:window.$router?.currentRoute?.value?.name,
    activeSurfaceId:store.activeScene?.activeSurfaceId,
    scenes:store.scenes.map(s=>({id:s.id,name:s.name,surfaces:s.surfaces.map(v=>({id:v.id,name:v.name,effect:v.light.effect,source:v.light.source,config:v.light.presetConfigs?.[v.light.effect]})),
      devices:s.devices.map(d=>({id:d.id,name:d.deviceName||d.productName,type:d.type,selected:d.selected}))})),
    methods:Object.fromEntries(['setMasterEnabled','selectScene','updateLight','setDeviceSelected','updateInteractive'].map(k=>[k,typeof store[k]]))});
  if(action==='verify'){
    const before=JSON.stringify(store.$state);store.setMasterEnabled(store.masterEnabled);
    const unchanged=before===JSON.stringify(store.$state);
    if(!unchanged)throw Error('No-op action unexpectedly changed state');
    return {real_store_action_called:true,state_unchanged:true,status:describe()};
  }
  if(action==='enabled')store.setMasterEnabled(input.enabled);
  if(action==='view'){
    if(!window.$router)throw Error('M HUB router not found');
    await window.$router.push({name:'LightSync2'});
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  if(action==='scene'){
    if(!store.scenes.some(s=>s.id===input.id))throw Error('Scene does not exist');
    store.selectScene(input.id);
  }
  if(action==='device'){
    if(!store.activeScene?.devices.some(d=>d.id===input.id))throw Error('Device does not exist in active scene');
    store.setDeviceSelected(input.id,input.selected);
  }
  if(action==='light'){
    if(!store.activeSurface)throw Error('No active light surface');
    store.updateLight(input);
  }
  return describe();
}

export async function invoke(action,input={}){
  input=validate(action,input);const client=await connect();
  try{
    // Serialize inside the renderer so nested Vue proxies preserve their properties.
    const expression=`(async()=>JSON.stringify(await (${rendererCall.toString()})(${JSON.stringify(action)},${JSON.stringify(input)})))()`;
    const response=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
    return JSON.parse(response.result.value);
  }finally{client.close();}
}

async function closeDebugSession(){
  const client=await connect();
  try{
    const response=await client.call('Runtime.evaluate',{
      expression:`(()=>{if(location.protocol!=='mchose-renderer:'||typeof window.electronAPI?.quit!=='function')throw Error('Expected M HUB quit API');setTimeout(()=>window.electronAPI.quit(),500);return {normal_quit_requested:true};})()`,
      returnByValue:true});
    if(response.exceptionDetails)throw Error(response.exceptionDetails.text);
    return response.result.value;
  }finally{client.close();}
}

if(process.argv[1]&&new URL(import.meta.url).pathname.toLowerCase().endsWith(process.argv[1].replaceAll('\\','/').split('/').at(-1).toLowerCase())){
  try{
    if(process.argv[2]==='close-session'){
      console.log(JSON.stringify(await closeDebugSession()));
    }else if(process.argv[2]==='selfcheck'){
      const bad=[['light',{speed:99}],['enabled',{enabled:'yes'}],['light',{command:'anything'}]];
      for(const [a,p] of bad){let failed=false;try{validate(a,p);}catch{failed=true;}if(!failed)throw Error('Invalid input accepted');}
      console.log(JSON.stringify({adapter_validation_passed:true,effects:EFFECTS}));
    }else{
      const action=process.argv[2]||'status';const result=await invoke(action,JSON.parse(process.argv[3]||'{}'));
      const output=JSON.stringify(result,null,2);console.log(output);
      if(['status','verify'].includes(action)){const dir=new URL('./harness-mhub-sync/state/',import.meta.url);await fs.mkdir(dir,{recursive:true});await fs.writeFile(new URL(`mhub-interface-${action}.json`,dir),output);}
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
