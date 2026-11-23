import {connectMhubDebug} from '../mhub_light_sync_api.mjs';
import {LIGHT_EFFECTS} from '../harness-mhub-sync/control-settings.mjs';
import {validateSyncDevices} from '../harness-mhub-sync/sync-devices.mjs';

export function renderer({action,payload}){
  const store=document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia?._s?.get('lightSync2');
  if(!store)throw Error('M HUB 神光同步尚未就绪');
  const clone=value=>JSON.parse(JSON.stringify(value));
  const signature=()=>JSON.stringify({master:store.masterEnabled,id:store.activeSceneId,
    lights:store.activeScene?.surfaces.map(x=>({id:x.id,enabled:x.enabled,light:x.light})),
    devices:store.activeScene?.devices.map(x=>({id:x.id,selected:x.selected}))});
  const describe=()=>{
    const light=(store.activeScene?.surfaces.find(s=>!s.desktopBalanceVersion&&!s.desktopFireworksVersion)??store.activeSurface)?.light,cfg=light?.presetConfigs?.[light.effect];
    const devices=document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('global')?.finalDeviceList??[];
    return {scene:store.activeScene?.name,sceneId:store.activeSceneId,master:store.masterEnabled,
      companion:store.activeScene?.desktopCompanionVersion===1,deviceKey:JSON.stringify({devices:devices.map(d=>[d.productName||d.deviceName,d.vendorId,d.productId,d.batteryLevel==='breakConnect']),connected:[...(store.connectedDeviceIds??[])].sort()}),
      connectedDeviceIds:[...(store.connectedDeviceIds??[])],
      signature:signature(),style:light?.source==='preset'&&/^#[\dA-F]{6}$/i.test(cfg?.color||'')?
        {color:cfg.color,brightness:cfg.brightness}:null};
  };
  if(action==='status')return describe();
  if(action==='capture')return {...describe(),snapshot:{scene:clone(store.activeScene),master:store.masterEnabled}};
  if(action==='suspend-master'){
    if(signature()!==payload.expected)throw Error('M HUB 设置已被手动改变');
    store.setMasterEnabled(false);
    return describe();
  }
  if(action==='restore'){
    if(signature()!==payload.expected)return {restored:false,reason:'manual-change',...describe()};
    const saved=payload.snapshot;
    const index=store.scenes.findIndex(s=>s.id===saved.scene.id);
    if(index<0)return {restored:false,reason:'original-scene-missing',...describe()};
    // A user-edited companion scene can itself be the baseline. Other scenes are never overwritten.
    if(saved.scene.desktopCompanionVersion===1){
      const current=store.scenes[index],originals=new Map(saved.scene.surfaces.map(s=>[s.id,s]));
      current.surfaces=current.surfaces.filter(s=>originals.has(s.id)||!s.desktopBalanceVersion&&!s.desktopFireworksVersion);
      for(const surface of current.surfaces){const original=originals.get(surface.id);if(original){surface.light=clone(original.light);surface.enabled=original.enabled;}}
      for(const device of current.devices){const original=saved.scene.devices.find(d=>d.id===device.id);if(original)device.selected=original.selected;}
    }
    store.selectScene(saved.scene.id);store.setMasterEnabled(saved.master);
    return {restored:true,...describe()};
  }
  if(action!=='emotion')throw Error('不支持的 M HUB 操作');
  if(payload.expected&&signature()!==payload.expected)throw Error('M HUB 设置已被手动改变');
  const before={sceneId:store.activeSceneId,master:store.masterEnabled};
  const undo=[];
  const copy=value=>value===undefined?undefined:clone(value);
  // Store actions can throw after changing reactive state. Remember only fields
  // this operation writes; scene names, transforms and layouts stay user-owned.
  const write=(target,key,apply,restore)=>{
    const previous=copy(target[key]);
    try{return apply();}
    finally{
      const applied=copy(target[key]);
      if(JSON.stringify(previous)!==JSON.stringify(applied))undo.push(()=>{
        if(JSON.stringify(target[key])!==JSON.stringify(applied))return;
        if(restore)restore(previous);else target[key]=copy(previous);
      });
    }
  };
  try{
    let scene=store.scenes.find(s=>s.desktopCompanionVersion===1),createdNow=false;
    if(!scene){
      const base=clone(store.scenes.find(s=>s.id==='scene-default')||store.activeScene);
      if(!base?.surfaces?.length)throw Error('没有可复用的灯效画布');
      let id=null;
      for(let n=0;n<4&&!id;n++)id=store.createScene(n?'大肥鱼陪伴'+n:'大肥鱼陪伴');
      if(!id)throw Error('M HUB 场景数量已满或场景名称冲突');
      const created=store.scenes.find(s=>s.id===id),name=created.name;
      Object.assign(created,base,{id,name,desktopCompanionVersion:1,autoIncludeDevices:false});
      created.surfaces=[clone(base.surfaces[0])];created.surfaces[0].id=id+'-surface';created.activeSurfaceId=created.surfaces[0].id;
      created.surfaces[0].enabled=true;created.surfaces[0].visible=true;created.surfaces[0].assetRefs=[];
      scene=created;createdNow=true;
    }
    store.selectScene(scene.id);
    for(const device of scene.devices){
      const name=[device.id,device.deviceName,device.productName].filter(Boolean).join(' ');
      const selected=(Array.isArray(payload.deviceIds)?payload.deviceIds.includes(device.id):/(K20\s*GT|Ace\s*75|MagDock)/i.test(name))&&!(payload.keyboardOverride&&device.type==='keyboard');
      if(device.selected!==selected)write(device,'selected',()=>store.setDeviceSelected(device.id,selected),value=>{
        if(store.activeSceneId===scene.id)store.setDeviceSelected(device.id,value);else device.selected=value;
      });
    }
    const surface=scene.surfaces.find(s=>!s.desktopBalanceVersion&&!s.desktopFireworksVersion)??scene.surfaces[0],oldActive=scene.activeSurfaceId;
    // A selected balance overlay must not accidentally receive the task effect.
    // The native M HUB preset always belongs to the main companion surface.
    scene.activeSurfaceId=surface.id;
    try{write(surface,'light',()=>store.updateLight({source:'preset',sourcePanel:'preset',effect:payload.effect,
      color:payload.color,brightness:payload.brightness,speed:payload.speed,mode:payload.colorMode??'solid'}));write(surface,'enabled',()=>{surface.enabled=true;});}
    finally{scene.activeSurfaceId=oldActive;}
    if(createdNow&&typeof store.fitInitialSurfaces==='function')store.fitInitialSurfaces();
    store.setMasterEnabled(true);
    return describe();
  }catch(error){
    const failures=[];
    for(const restore of undo.reverse())try{restore();}catch(failure){failures.push(failure.message);}
    try{store.selectScene(before.sceneId);}catch(failure){failures.push(failure.message);}
    try{store.setMasterEnabled(before.master);}catch(failure){failures.push(failure.message);}
    if(failures.length)throw Error(error.message+'；灯效恢复未完成：'+failures.join('；'));
    throw error;
  }
}

export function validateResume(value){
  if(!value||value.kind!=='resume'||value.source!=='owner'||!Number.isInteger(value.seq)||value.seq<1)throw Error('Invalid resume');
  if(Object.keys(value).some(k=>!['seq','kind','source','createdAt','expiresAt'].includes(k)))throw Error('Unexpected resume fields');
  if(!Number.isFinite(value.expiresAt)||value.expiresAt*1000<Date.now()||value.expiresAt*1000>Date.now()+60000)throw Error('Expired or invalid resume');
  return value;
}

export function validateEmotion(value){
  if(value?.keyboardOverride!==undefined&&typeof value.keyboardOverride!=='boolean')throw Error('Invalid keyboard override');
  if(!value||value.kind!=='emotion'||!['calm','happy','shy','comfort','thinking','sleepy'].includes(value.mood))throw Error('Invalid emotion');
  if(!/^#[0-9a-f]{6}$/i.test(value.color))throw Error('Invalid color');
  if(!LIGHT_EFFECTS.includes(value.effect))throw Error('Invalid effect');
  if(!Number.isInteger(value.brightness)||value.brightness<1||value.brightness>100)throw Error('灯光亮度需为 1～100%');
  if(!Number.isInteger(value.speed)||value.speed<1||value.speed>5)throw Error('Invalid speed');
  if(value.colorMode!==undefined&&!['solid','rainbow'].includes(value.colorMode))throw Error('Invalid colour mode');
  if(value.deviceIds!==undefined&&value.deviceIds!==null)validateSyncDevices({deviceIds:value.deviceIds});
  if(!Number.isInteger(value.seconds)||value.seconds<3||value.seconds>300)throw Error('Invalid duration');
  if(!Number.isFinite(value.expiresAt)||value.expiresAt*1000<Date.now())throw Error('Expired emotion');
  return value;
}

export async function mhub(action,payload={}){
  if(action==='emotion')validateEmotion(payload);
  const client=await connectMhubDebug();
  try{
    const expression=`JSON.stringify((${renderer.toString()})(${JSON.stringify({action,payload})}))`;
    const result=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return JSON.parse(result.result.value);
  }finally{client.close();}
}
