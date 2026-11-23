import fs from 'node:fs/promises';
import {connectMhubDebug,invoke} from './mhub_light_sync_api.mjs';

const ROOT=new URL('./ace75-gif-test/',import.meta.url);
async function loadMhubModule(){
  const bootstrap=Array.from(document.scripts).find(s=>s.type==='module'&&s.src.startsWith('mchose-renderer:'))?.src;
  if(!bootstrap)throw Error('Current M HUB bootstrap not found');
  const source=await(await fetch(bootstrap)).text();
  const match=source.match(/import\("(\.\/main-[^"\s]+\.js)"\)/);
  if(!match)throw Error('Could not resolve current M HUB shared module');
  const module=await import(new URL(match[1],bootstrap).href);
  const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('lightSync2');
  if(module.c3()!==store)throw Error('Refusing to use a different M HUB module instance');
  return module;
}
async function evaluate(fn,arg){
  const client=await connectMhubDebug();
  try{
    const expression=`(async()=>{const loadMhubModule=${loadMhubModule.toString()};return JSON.stringify(await (${fn.toString()})(${JSON.stringify(arg)}));})()`;
    const result=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},25000);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return JSON.parse(result.result.value);
  }finally{client.close();}
}

async function playGif({base64,name,width,height,assetId}){
  const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('lightSync2');
  const module=await loadMhubModule();
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  const file=new File([bytes],name,{type:'image/gif'});
  await module.b1(assetId,file);
  const sceneId=store.duplicateScene(store.activeSceneId);
  if(!sceneId)throw Error('Could not duplicate current scene');
  store.renameScene(sceneId,'Ace75流星GIF');
  await new Promise(resolve=>setTimeout(resolve,150));
  const keyboard=store.activeScene.devices.find(d=>d.type==='keyboard'&&/Ace\s*75/i.test(d.deviceName||d.productName||d.id));
  if(!keyboard)throw Error('Ace75 not found in test scene');
  const surfaceId=store.createSurface('Ace75 GIF');
  if(!store.addCustomAsset(surfaceId,{id:assetId,kind:'gif',name,mime:'image/gif',size:bytes.length,width,height,createdAt:Date.now()})){
    throw Error('M HUB did not accept GIF metadata');
  }
  const surface=store.activeScene.surfaces.find(s=>s.id===surfaceId);
  const layout=await module.c2(keyboard);
  const main=layout.keys.filter(k=>!k.nativeLight&&Number.isInteger(k.ledIndex)&&k.ledIndex<95);
  if(main.length<75)throw Error('Unexpected Ace75 key layout');
  const bounds={left:Math.min(...main.map(k=>k.x)),top:Math.min(...main.map(k=>k.y)),
    right:Math.max(...main.map(k=>k.x+k.width)),bottom:Math.max(...main.map(k=>k.y+k.height))};
  const transform=keyboard.transform;
  const localX=((bounds.left+bounds.right)/2-.5)*transform.width;
  const localY=((bounds.top+bounds.bottom)/2-.5)*transform.height;
  const angle=(transform.rotation||0)*Math.PI/180,scale=transform.scale||1;
  store.updateSurface(surfaceId,{viewportFit:false,transform:{...transform,
    x:transform.x+(localX*Math.cos(angle)-localY*Math.sin(angle))*scale,
    y:transform.y+(localX*Math.sin(angle)+localY*Math.cos(angle))*scale,
    width:transform.width*(bounds.right-bounds.left),height:transform.height*(bounds.bottom-bounds.top)},
    light:{...surface.light,source:'custom',sourcePanel:'custom',customAssetId:assetId,customBrightness:85,customSaturation:100}});
  store.setMasterEnabled(true);
  await new Promise(resolve=>setTimeout(resolve,1500));
  return {sceneId,surfaceId,assetId,keyboardId:keyboard.id,mainKeyCount:main.length,bounds,
    selectedSceneName:store.activeScene.name,gifSavedInMhub:true};
}

async function inspectPlayback({surfaceId,keyboardId}){
  const module=await loadMhubModule();
  const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('lightSync2');
  const frames=module.b7();
  const runtime=module.cb();
  const media=frames.mediaBySurface?.frames?.[surfaceId];
  const keyboard=frames.keyboard?.frames?.find(f=>f.deviceId===keyboardId);
  const colors=keyboard?.colors;
  return {masterEnabled:store.masterEnabled,sceneId:store.activeSceneId,
    gifSource:store.activeScene.surfaces.find(s=>s.id===surfaceId)?.light.source,
    runtimeKeys:Object.keys(frames),runtimeMedia:frames.mediaBySurface?Object.keys(frames.mediaBySurface):null,
    visibility:document.visibilityState,route:window.$router.currentRoute.value.name,
    assetUrls:Object.keys(runtime.customAssetUrls||{}),
    previews:Object.entries(runtime.customMediaPreviews||{}).map(([id,p])=>({id,kind:p.kind,width:p.element?.width,height:p.element?.height})),
    imageDecoderAvailable:typeof ImageDecoder!=='undefined',
    moduleStoreMatches:module.c3()===store,
    mainModules:performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/main-CGTiXbF-/.test(n)),
    pageUrl:location.href,scripts:Array.from(document.scripts).map(s=>s.src).filter(Boolean),
    mainPreloads:Array.from(document.querySelectorAll('link[rel="modulepreload"]')).map(s=>s.href).filter(n=>/main-/.test(n)),
    assetMetadata:store.assetCatalog[store.activeScene.surfaces.find(s=>s.id===surfaceId)?.light.customAssetId],
    mediaFrameAvailable:!!media,mediaFrameTime:frames.mediaBySurface?.capturedAt,
    mediaChecksum:media?.colors?Array.from(media.colors).reduce((a,b,i)=>(a+b*(i%97+1))%1000000007,0):null,
    keyboardFrameAvailable:!!keyboard,keyboardFrameTime:frames.keyboard?.capturedAt,
    keyboardChecksum:colors?Array.from(colors).reduce((a,b,i)=>(a+b*(i+1))%1000000007,0):null,
    keySamples:keyboard?.keys?.filter(k=>!k.nativeLight).slice(0,16).map(k=>({index:k.ledIndex,color:k.color}))};
}

async function restoreState(before){
  const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('lightSync2');
  const original=before.scenes.find(s=>s.id===before.activeSceneId);
  const index=store.scenes.findIndex(s=>s.id===before.activeSceneId);
  if(index<0)throw Error('Original scene no longer exists');
  store.scenes.splice(index,1,original);
  store.$patch({activeSceneId:before.activeSceneId,selectedObjectId:before.selectedObjectId,
    masterEnabled:before.masterEnabled});
  await new Promise(resolve=>setTimeout(resolve,500));
  return {restored:store.masterEnabled===before.masterEnabled&&store.activeSceneId===before.activeSceneId,
    scene:store.activeScene.name,masterEnabled:store.masterEnabled,gifTestSceneRetained:true};
}

try{
  const action=process.argv[2]||'status';
  if(action==='play'){
    const before=await evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('lightSync2').$state,{});
    await fs.writeFile(new URL('mhub-before-gif.json',ROOT),JSON.stringify(before,null,2));
    const metadata=JSON.parse(await fs.readFile(new URL('animation.json',ROOT),'utf8'));
    const data=await fs.readFile(new URL('Ace75-blue-purple-meteor.gif',ROOT));
    await invoke('view');
    const playback=await evaluate(playGif,{base64:data.toString('base64'),name:'Ace75蓝紫流星.gif',
      width:metadata.width,height:metadata.height,assetId:`media-ace75-meteor-${Date.now()}`});
    await fs.writeFile(new URL('playback.json',ROOT),JSON.stringify(playback,null,2));
    console.log(JSON.stringify(playback,null,2));
  }else if(action==='status'){
    const playback=JSON.parse(await fs.readFile(new URL('playback.json',ROOT),'utf8'));
    const result=await evaluate(inspectPlayback,playback);
    await fs.writeFile(new URL('playback-status.json',ROOT),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }else if(action==='restore'){
    const before=JSON.parse(await fs.readFile(new URL('mhub-before-gif.json',ROOT),'utf8'));
    const result=await evaluate(restoreState,before);
    await fs.writeFile(new URL('restored.json',ROOT),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }else throw Error('Expected play, status or restore');
}catch(error){console.error(error.message);process.exitCode=1;}
