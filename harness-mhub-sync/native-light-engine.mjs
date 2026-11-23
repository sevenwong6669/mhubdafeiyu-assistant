import {evaluateInMhub} from '../mhub_runtime_access.mjs';

// M HUB's visible canvas normally publishes these frames. Keep using its own
// samplers/builders when that page is unmounted; no effect is reimplemented.
async function runtime({enabled,keyboardToken,assetSceneId=null,assetDeviceIds=[],assetMediaId=null,assetMedia}){
 const key='__dafeiyuNativeLightEngine';
 if(!enabled){window[key]?.stop();delete window[key];return {running:false};}
 if(window[key]){
  const state=window[key];
  Object.assign(state,{leaseUntil:Date.now()+6000,keyboardToken,assetSceneId,assetDeviceIds,assetMediaId});
  if(assetMedia||!assetMediaId)state.assetMedia=assetMedia;
  return state.status();
 }
 const m=await loadMhubModule(),store=m.c3(),fn=name=>{
  const matches=Object.values(m).filter(v=>typeof v==='function'&&v.name===name);
  if(matches.length!==1)throw Error('M HUB native lighting function unavailable: '+name);return matches[0];
 };
 const buildKeyboard=fn('buildDeviceLightFrame'),buildPeripheral=fn('buildPeripheralLightFrame'),sampler=fn('createSceneSurfaceSampler'),samplePreset=fn('samplePresetEffect'),profile=fn('resolveLightingProfile'),publish=fn('updateLightSync2RuntimeFrames');
 const owner='dafeiyu-background',layouts=new Map(),media=new Map(),state={leaseUntil:Date.now()+6000,running:true,lastFrameAt:0,devices:[],error:null,busy:false,keyboardToken,keyboardSending:false,lastKeyboardPost:0,assetSceneId,assetDeviceIds,assetMediaId,assetMedia,nonBlack:0};
 // Keep the native output router as the sole peripheral writer. Its visible
 // and hidden paths consume different runtime channels; merge our leased
 // custom scene into both, without discarding publications from M HUB.
 const channels=m.b7(),bindings=[];let channelScene=null,ownedPeripheral=null,ownedMedia=null;
 const ownsChannels=()=>state.running&&Date.now()<=state.leaseUntil&&store.masterEnabled&&store.activeScene===channelScene&&channelScene?.id===state.assetSceneId;
 for(const name of ['peripheral','mediaBySurface']){const d=Object.getOwnPropertyDescriptor(channels,name);if(d&&(!d.configurable||d.get||d.set))throw Error('M HUB runtime channel is not configurable data: '+name);}
 for(const name of ['peripheral','mediaBySurface']){
  const descriptor=Object.getOwnPropertyDescriptor(channels,name);let underlying=channels[name];
  const get=()=>{
   if(!ownsChannels())return underlying;
   if(name==='mediaBySurface'&&ownedMedia)return {...underlying,...ownedMedia,frames:{...underlying?.frames,...ownedMedia.frames}};
   if(name==='peripheral'&&ownedPeripheral){const ids=new Set(ownedPeripheral.frames.map(f=>f.deviceId));return {...underlying,...ownedPeripheral,frames:[...(underlying?.frames??[]).filter(f=>!ids.has(f.deviceId)),...ownedPeripheral.frames]};}
   return underlying;
  };
  Object.defineProperty(channels,name,{configurable:true,enumerable:true,get,set:value=>{underlying=value;}});
  bindings.push(()=>{if(Object.getOwnPropertyDescriptor(channels,name)?.get===get){if(descriptor)Object.defineProperty(channels,name,{...descriptor,value:underlying});else{delete channels[name];channels[name]=underlying;}}});
 }
 // A one-zone speaker cannot display a tiny spatial firework. Follow the
 // bright part of the same frame, while retaining genuinely dark intervals.
 const representativeColor=data=>{
  const histogram=new Uint32Array(256);let active=0,total=0;
  for(let i=0;i<data.length;i+=16){if(data[i+3]<128)continue;total++;const peak=Math.max(data[i],data[i+1],data[i+2]);if(peak>=16){histogram[peak]++;active++;}}
  if(!active)return [0,0,0];
  let cutoff=255,n=0;const wanted=Math.max(1,Math.ceil(total*.05));
  while(cutoff>16){n+=histogram[cutoff];if(n>=wanted)break;cutoff--;}
  const rgb=[0,0,0];let count=0;
  for(let i=0;i<data.length;i+=16)if(data[i+3]>=128&&Math.max(data[i],data[i+1],data[i+2])>=cutoff){for(let k=0;k<3;k++)rgb[k]+=data[i+k];count++;}
  const energy=Math.min(1,Math.sqrt(active/Math.max(1,total)/.08));return rgb.map(v=>Math.round(v/Math.max(1,count)*energy));
 };
 const decode=async id=>{
  if(media.has(id))return media.get(id);
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true}),frames=[];
  const capture=(duration)=>{const colors=context.getImageData(0,0,canvas.width,canvas.height).data;frames.push({width:canvas.width,height:canvas.height,colors,representative:representativeColor(colors),duration:Math.max(20,duration)});};
  const staged=state.assetMedia;
  if(staged?.id===id){
   const {width,height,durations,png}=staged;
   const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));
   const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
   try{
    if(image.width!==width||image.height!==height*durations.length)throw Error('本地 GIF 播放帧尺寸校验失败');
    canvas.width=width;canvas.height=height;
    for(const [index,duration] of durations.entries()){
     context.clearRect(0,0,width,height);
     context.drawImage(image,0,index*height,width,height,0,0,width,height);
     capture(duration);
    }
   }finally{image.close();}
  }else{
   const record=await fn('loadCustomMedia')(id);if(!(record?.blob instanceof Blob))throw Error('M HUB自定义媒体缺失');
   if(record.mime==='image/gif'||record.blob.type==='image/gif')throw Error('GIF 播放帧未准备，请重新应用已有素材');
   const image=await createImageBitmap(record.blob);
   try{canvas.width=Math.min(512,image.width);canvas.height=Math.max(1,Math.round(image.height*canvas.width/image.width));context.drawImage(image,0,0,canvas.width,canvas.height);capture(200);}finally{image.close();}
  }
  const item={frames,total:frames.reduce((n,f)=>n+f.duration,0),started:performance.now()};media.set(id,item);return item;
 };
 const keyboardPost=frames=>{
  if(!state.keyboardToken||state.keyboardSending||Date.now()-state.lastKeyboardPost<100)return;
  const selected=frames.filter(f=>['Ace 75 8K','GT 75'].includes(f.deviceId));state.keyboardSending=true;state.lastKeyboardPost=Date.now();
  fetch('http://127.0.0.1:18783/frame',{method:'POST',headers:{'content-type':'application/json','x-dafeiyu-frame':state.keyboardToken},body:JSON.stringify({frames:selected.map(frame=>({deviceId:frame.deviceId,colors:Array.from(frame.colors)}))}),signal:AbortSignal.timeout(800)}).catch(()=>{}).finally(()=>state.keyboardSending=false);
 };
 const clear=()=>{channelScene=null;ownedPeripheral=null;ownedMedia=null;const frames=m.b7();const patch={};if(frames.keyboard?.owner===owner)patch.keyboard=null;if(frames.peripheral?.owner===owner)patch.peripheral=null;if(frames.mediaBySurface?.owner===owner)patch.mediaBySurface=null;if(Object.keys(patch).length)publish(patch);};
 const step=async()=>{
  if(Date.now()>state.leaseUntil){state.stop();delete window[key];return;}
  if(!state.running||state.busy)return;
  const scene=store.activeScene,custom=!!state.assetSceneId&&scene?.id===state.assetSceneId&&!!scene.qqAssetDigest;
  if(!store.masterEnabled||scene?.desktopCompanionVersion!==1&&!custom){clear();state.devices=[];return;}
  if(custom&&state.assetMediaId&&state.assetMedia?.id!==state.assetMediaId)return;
  const frames=m.b7(),now=performance.now();
  // When M HUB's own page publishes frames, let that renderer lead.
  if(!custom&&frames.keyboard&&frames.keyboard.owner!==owner&&now-frames.keyboard.capturedAt<700){keyboardPost(frames.keyboard.frames??[]);state.devices=frames.keyboard.frames?.map(f=>f.deviceId)??[];state.lastFrameAt=Date.now();return;}
  state.busy=true;
  try{
   const connected=new Set(store.connectedDeviceIds??[]),devices=scene.devices.filter(d=>(custom?state.assetDeviceIds.includes(d.id):d.selected)&&connected.has(d.id));
   const customFrames=new Map();if(custom)for(const surface of scene.surfaces.filter(v=>v.enabled&&v.light.source==='custom')){const item=await decode(surface.light.customAssetId);let elapsed=(now-item.started)%item.total;if(elapsed<0)elapsed=0;let frame=item.frames.at(-1);for(const candidate of item.frames){if(elapsed<candidate.duration){frame=candidate;break;}elapsed-=candidate.duration;}customFrames.set(surface.id,frame);}
   const sample=sampler({scene,sampleSurface:(surface,uv,time)=>{
    const light=surface.light;
    if(light.source!=='custom')return samplePreset(uv,time,light.effect,light.presetConfigs?.[light.effect]??{},surface.transform);
    const frame=customFrames.get(surface.id)??frames.mediaBySurface?.frames?.[surface.id];if(!frame?.colors||!frame.width||!frame.height)return null;
    const x=Math.min(frame.width-1,Math.max(0,Math.floor(uv.u*frame.width))),y=Math.min(frame.height-1,Math.max(0,Math.floor(uv.v*frame.height))),at=(y*frame.width+x)*4;
    return {r:frame.colors[at],g:frame.colors[at+1],b:frame.colors[at+2],alpha:frame.colors[at+3]/255};
   }}),keyboard=[],peripheral=[];
   for(const device of devices){
    if(device.type==='keyboard'){
     const id=device.id+':'+(device.firmwareVersion??'');if(!layouts.has(id))layouts.set(id,await m.c2(device));
     const layout=layouts.get(id);if(layout){const frame=buildKeyboard({device,layout,scene,now,sampleSceneEffect:sample});keyboard.push(frame);}
    }else{const f=buildPeripheral({device,profile:profile(device),scene,now,sampleSceneEffect:sample});
     if(f&&custom&&device.id==='MCHOSE K20 GT'&&f.ledCount===1){
      const surface=scene.surfaces.find(v=>v.enabled&&v.light.source==='custom'),frame=surface&&customFrames.get(surface.id);
      if(frame){const gain=Math.max(0,Math.min(100,surface.light.customBrightness??100))/100,rgb=frame.representative.map(v=>Math.round(v*gain));f.colors=new Uint8Array(rgb);f.globalFrameColor=true;f.zones=f.zones.map(z=>({...z,rgb,color:'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join(''),sampleSource:'global-frame'}));}
     }
     if(f)peripheral.push(f);
    }
   }
   if(!state.running||window[key]!==state||Date.now()>state.leaseUntil||
      store.activeScene!==scene||!store.masterEnabled)return;
   if(custom){
    // The hidden native sampler reads pixels instead of peripheral frames.
    // Map the speaker's five sample pixels to the same whole-frame colour.
    // Only the transient runtime buffer is changed, never the GIF or scene.
    const adapted=new Map(customFrames),speaker=peripheral.find(f=>f.globalFrameColor);
    if(speaker){const surface=scene.surfaces.find(v=>v.enabled&&v.light.source==='custom'),frame=surface&&customFrames.get(surface.id);
     if(frame){const colors=new Uint8ClampedArray(frame.colors),t=surface.transform,a=-(t.rotation||0)*Math.PI/180,k=t.scale||1;
      for(const point of speaker.zones.flatMap(z=>z.samples?.length?z.samples.map(v=>v.worldPoint):[z.worldPoint])){if(!point)continue;const dx=point.x-t.x,dy=point.y-t.y,u=(dx*Math.cos(a)-dy*Math.sin(a))/k/t.width+.5,v=(dx*Math.sin(a)+dy*Math.cos(a))/k/t.height+.5;if(u<0||u>1||v<0||v>1)continue;const at=(Math.min(frame.height-1,Math.floor(v*frame.height))*frame.width+Math.min(frame.width-1,Math.floor(u*frame.width)))*4;colors.set([...speaker.colors,255],at);}
      adapted.set(surface.id,{...frame,colors});
     }
    }
    channelScene=scene;ownedMedia={capturedAt:now,owner,frames:Object.fromEntries(adapted)};ownedPeripheral={capturedAt:now,owner,frames:peripheral};
   }else{channelScene=null;ownedMedia=null;ownedPeripheral=null;}
   publish({keyboard:custom?null:{capturedAt:now,owner,frames:keyboard},...(!custom?{peripheral:{capturedAt:now,owner,frames:peripheral}}:{})});
   keyboardPost(keyboard);
   state.lastFrameAt=Date.now();state.devices=[...keyboard,...peripheral].map(f=>f.deviceId);state.nonBlackByDevice=Object.fromEntries([...keyboard,...peripheral].map(f=>[f.deviceId,Array.from(f.colors??[]).filter(v=>v>0).length]));state.nonBlack=Object.values(state.nonBlackByDevice).reduce((n,v)=>n+v,0);state.speakerColor=Array.from(peripheral.find(f=>f.deviceId==='MCHOSE K20 GT')?.colors??[]);state.error=null;
  }catch(error){state.error=String(error.message).slice(0,250);}
  finally{state.busy=false;}
 };
 const timer=setInterval(()=>void step(),50);
 state.stop=()=>{clearInterval(timer);state.running=false;media.clear();clear();bindings.forEach(restore=>restore());};
 state.status=()=>({running:state.running,lastFrameAt:state.lastFrameAt,devices:[...state.devices],error:state.error,nonBlack:state.nonBlack,nonBlackByDevice:{...state.nonBlackByDevice},speakerColor:state.speakerColor??[],assetSceneId:state.assetSceneId,assetMediaId:state.assetMedia?.id??null});
 window[key]=state;await step();return state.status();
}
export class NativeLightEngine{
 constructor(){this.last=0;this.status=null;}
 async poll(enabled=true,keyboardToken,{assetMedia,...options}={}){
  if(Date.now()-this.last<1000)return;
  this.last=Date.now();
  const assetMediaId=assetMedia?.id??null;
  this.status=await evaluateInMhub(runtime,{enabled,keyboardToken,...options,assetMediaId,
   ...(assetMedia&&this.status?.assetMediaId!==assetMediaId?{assetMedia}:{})},10000);
 }
 async close(){this.status=await evaluateInMhub(runtime,{enabled:false},3000);}
 async withLease(operation,lease,{every=setInterval,cancel=clearInterval}={}){
  let pending=null,closed=false;
  const renew=()=>{
   if(closed||pending)return pending;
   const current=lease();if(!current.enabled)return;
   pending=Promise.resolve().then(()=>this.poll(true,current.token,current.options)).catch(error=>{this.leaseError=error.message;}).finally(()=>{pending=null;});return pending;
  };
  const timer=every(()=>void renew(),1000);
  try{await renew();return await operation();}
  finally{closed=true;cancel(timer);await pending;}
 }
}
