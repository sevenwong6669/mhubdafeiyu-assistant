import {intentToken,invalidateIntent} from './device-intent.mjs?v=device-link-1';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import profiles from './device-asset-profiles.json' with {type:'json'};
import {gifMetadata} from './native-gif.mjs';
import {requireDeviceLink,withDeviceWrite} from '../harness-mhub-sync/device-link-mode.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export const ASSET_ROOT=path.join(root,'state/device-assets');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
export function readDeviceAsset(id,{base=ASSET_ROOT,chatId}={}){
 if(!ID.test(id??''))throw Error('素材编号无效。');
 const dir=path.join(base,id),request=read(path.join(dir,'request.json')),manifest=read(path.join(dir,'prepared/manifest.json'));
 if(chatId&&request.chatId&&request.chatId!==chatId)throw Error('这份素材属于另一个私聊，未导入。');
 const spec=profiles.profiles[manifest.target];
 if(!spec||manifest.target==='keyboard'||manifest.kind!==spec.kind||manifest.width!==spec.width||manifest.height!==spec.height||!['asset.gif','asset.png'].includes(manifest.file))throw Error('素材规格不符合当前设备规则，请重新适配。');
 const file=path.join(dir,'prepared',manifest.file),bytes=fs.readFileSync(file);
 if(bytes.length>16*1024*1024)throw Error('适配素材超过16MB。');
 let actual;
 if(manifest.file==='asset.gif')actual=gifMetadata(bytes);
 else{if(!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('不是有效的PNG。');actual={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),frames:1};}
 if(actual.width!==spec.width||actual.height!==spec.height||actual.frames!==manifest.frames||actual.frames>16)throw Error('素材文件与记录的尺寸或帧数不一致。');
 return {id,dir,request,manifest,file,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}
export function latestDeviceAsset(chatId,{base=ASSET_ROOT,target}={}){
 if(!fs.existsSync(base))throw Error('还没有可导入的设备素材，请先生成。');
 const rows=[];for(const id of fs.readdirSync(base).filter(x=>ID.test(x))){try{const p=readDeviceAsset(id,{base,chatId});if(target&&(target==='keyboard'?!['gt75','ace75'].includes(p.manifest.target):p.manifest.target!==target))continue;rows.push({...p,at:fs.statSync(p.file).mtimeMs});}catch{}}
 rows.sort((a,b)=>b.at-a.at);if(!rows.length)throw Error('还没有可导入的设备素材，请先生成或指定素材编号。');return rows[0];
}
// Import only: no scene selection, no master switch, no HID output.
export async function importRgbDraft(p,{name,evaluate=evaluateInMhub}={}){
 if(p.manifest.kind!=='rgb')throw Error('音箱小屏需要通过联动控制器上传，不能导入RGB灯效画布。');
 const sceneId='scene-qq-'+p.id,assetId='media-qq-'+p.id;
 const result=await withDeviceWrite(()=>evaluate(async({sceneId,assetId,base64,meta,name,digest})=>{
  const m=await loadMhubModule(),s=m.c3(),clone=x=>JSON.parse(JSON.stringify(x));
  const verifyMedia=async()=>{const load=Object.values(m).find(v=>typeof v==='function'&&v.name==='loadCustomMedia');if(!load)throw Error('M HUB媒体读回接口不可用。');const record=await load(assetId),blob=record?.blob;if(!(blob instanceof Blob))throw Error('M HUB媒体文件未保存。');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==digest)throw Error('M HUB媒体文件校验不一致。');};
  // This M HUB build exposes no $persist hook for externally updated scenes.
  // Persist exactly its published lightSync2 pick list, never other settings.
  const persist=()=>{const key='mhub-light-sync-2-multi-surface-v1',value={};for(const k of ['schemaVersion','masterEnabled','activeSceneId','assetCatalog','scenes'])value[k]=clone(s[k]??(k==='schemaVersion'?1:null));const previous=JSON.parse(localStorage.getItem(key)||'null'),playing=window.__dafeiyuNativeLightEngine?.status()?.assetSceneId;if(playing&&playing===s.activeSceneId&&previous?.scenes){value.activeSceneId=previous.activeSceneId;value.masterEnabled=previous.masterEnabled;const old=previous.scenes.find(v=>v.id===playing),scene=value.scenes.find(v=>v.id===playing);if(old&&scene)for(const d of scene.devices){const saved=old.devices.find(v=>v.id===d.id);if(saved)d.selected=saved.selected;}}localStorage.setItem(key,JSON.stringify(value));const saved=JSON.parse(localStorage.getItem(key));if(!saved.scenes?.some(v=>v.id===sceneId)||!saved.assetCatalog?.[assetId])throw Error('M HUB导入记录未持久化，请检查存储空间。');};
  const existing=s.scenes.find(x=>x.id===sceneId);
  if(existing){if(existing.qqAssetDigest!==digest)throw Error('同编号素材已存在且内容不同，未覆盖。');if(!s.assetCatalog?.[assetId]||existing.surfaces?.[0]?.light?.customAssetId!==assetId)throw Error('已有导入记录被修改，请检查M HUB对应场景。');await verifyMedia();persist();return {imported:true,existing:true,persisted:true,sceneId,assetId,name:existing.name,activated:s.activeSceneId===sceneId};}
  if(s.personalSceneCount>=30)throw Error('M HUB自定义场景已满，未删除任何已有场景。');
  const before={active:s.activeSceneId,master:s.masterEnabled,selected:s.selectedObjectId},original=s.activeScene;
  if(!original?.surfaces?.length)throw Error('M HUB当前没有可用的画布模板。');
  const connected=new Set(s.connectedDeviceIds??[]),want=meta.target==='gt75'?'GT 75':meta.target==='ace75'?'Ace 75 8K':null;
  const devices=original.devices.filter(d=>connected.has(d.id)&&(want?d.id===want:meta.target==='sync'||d.selected));
  if(!devices.length)throw Error(want?'目标键盘未连接或不在当前场景，请重新检测。':'当前场景没有勾选且已连接的同步设备。');
  let transform;
  if(want){
   const d=devices[0],layout=await m.c2(d),limit=want==='GT 75'?99:95;
   const keys=layout.keys.filter(k=>!k.nativeLight&&Number.isInteger(k.ledIndex)&&k.ledIndex>=0&&k.ledIndex<limit);
   if(keys.length<60)throw Error('键盘主键区布局异常，未导入。');
   const l=Math.min(...keys.map(k=>k.x)),r=Math.max(...keys.map(k=>k.x+k.width)),t=Math.min(...keys.map(k=>k.y)),b=Math.max(...keys.map(k=>k.y+k.height));
   const tf=d.transform,a=(tf.rotation||0)*Math.PI/180,k=tf.scale||1,x=((l+r)/2-.5)*tf.width,y=((t+b)/2-.5)*tf.height;
   transform={...tf,x:tf.x+(x*Math.cos(a)-y*Math.sin(a))*k,y:tf.y+(x*Math.sin(a)+y*Math.cos(a))*k,width:tf.width*(r-l),height:tf.height*(b-t)};
  }else{
   const points=[];for(const d of devices){const t=d.transform,a=(t.rotation||0)*Math.PI/180,k=t.scale||1;for(const x of [-t.width/2,t.width/2])for(const y of [-t.height/2,t.height/2])points.push([t.x+k*(x*Math.cos(a)-y*Math.sin(a)),t.y+k*(x*Math.sin(a)+y*Math.cos(a))]);}
   const xs=points.map(x=>x[0]),ys=points.map(x=>x[1]),l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys);transform={x:(l+r)/2,y:(t+b)/2,width:r-l,height:b-t,rotation:0,scale:1};
  }
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),mime=meta.file.endsWith('.gif')?'image/gif':'image/png';
  const scene=clone(original),surface=clone(original.surfaces[0]);scene.id=sceneId;scene.name=name;scene.updatedAt=Date.now();delete scene.desktopCompanionVersion;scene.qqAssetDigest=digest;
  surface.id=sceneId+'-surface';surface.name=name;surface.enabled=true;surface.visible=true;surface.locked=false;surface.viewportFit=false;surface.assetRefs=[];surface.transform=transform;
  surface.light={...surface.light,source:'custom',sourcePanel:'custom',customAssetId:assetId,customBrightness:100,customSaturation:100};
  if(surface.interactive)surface.interactive.enabled=false;
  scene.surfaces=[surface];scene.activeSurfaceId=surface.id;for(const d of scene.devices)d.selected=devices.some(x=>x.id===d.id);
  let stored=false,inserted=false;
  try{
   await m.b1(assetId,new File([bytes],meta.file,{type:mime}));stored=true;await verifyMedia();s.scenes.unshift(scene);inserted=true;
   if(!s.addCustomAsset(surface.id,{id:assetId,kind:meta.file.endsWith('.gif')?'gif':'image',name,mime,size:bytes.length,width:meta.width,height:meta.height,createdAt:Date.now()}))throw Error('M HUB没有接受素材记录。');
   // addCustomAsset auto-fits ordinary media; retain the measured device bounds.
   s.scenes.find(x=>x.id===sceneId).surfaces[0].transform=transform;
   if(s.activeSceneId!==before.active||s.masterEnabled!==before.master||s.selectedObjectId!==before.selected)throw Error('导入过程意外改变当前选择，请检查M HUB。');
   const actual=s.scenes.find(x=>x.id===sceneId);if(actual?.surfaces?.[0]?.light?.customAssetId!==assetId||!s.assetCatalog?.[assetId])throw Error('M HUB场景读回验证失败。');
   persist();
   return {imported:true,activated:false,persisted:true,sceneId,assetId,name,devices:devices.map(d=>({id:d.id,type:d.type})),width:meta.width,height:meta.height,mainKeyArea:!!want};
  }catch(error){if(inserted){const at=s.scenes.findIndex(x=>x.id===sceneId);if(at>=0&&s.activeSceneId!==sceneId)s.scenes.splice(at,1);}const used=s.scenes.some(x=>x.surfaces.some(v=>v.light?.customAssetId===assetId));if(stored&&!used){s.removeCustomAsset(assetId);await m.b2(assetId).catch(()=>{});}throw error;}
 },{sceneId,assetId,base64:p.bytes.toString('base64'),meta:p.manifest,name:name??'QQ · '+p.manifest.label,digest:p.sha256},15000));
 fs.writeFileSync(path.join(p.dir,'mhub-import.json'),JSON.stringify({...result,at:Date.now(),sha256:p.sha256},null,2));return result;
}
function processAlive(pid){try{if(!Number.isSafeInteger(pid)||pid<=0)return false;process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
export function activePhone(syncRoot,now=Date.now()){
 try{
   const call=read(path.join(syncRoot,'phone/state.json'));
   const server=Number(fs.readFileSync(path.join(syncRoot,'voice-chat/server.pid'),'utf8'));
   return call.pid===server&&processAlive(server)&&Number.isFinite(call.at)&&now-call.at>=0&&now-call.at<5000&&['incoming','dialing','connecting','connected'].includes(call.phase);
 }catch(error){if(error.code==='ENOENT'||error.name==='SyntaxError')return false;throw error;}
}
export async function queueSpeakerAsset(p,{timeout=145000,syncRoot=path.resolve(root,'../harness-mhub-sync'),applyToken}={}){
 if(p.manifest.target!=='speaker')throw Error('不是音箱素材。');
 return queueScreenCommand({kind:'screen-device-asset',assetId:p.id,applyToken},{timeout,syncRoot});
}
export async function queueDefaultTheme(options={}){
 requireDeviceLink(options?.syncRoot);invalidateIntent(options?.syncRoot);return queueScreenCommand({kind:'device-default-theme'},options);
}
async function queueScreenCommand(payload,{timeout=145000,syncRoot=path.resolve(root,'../harness-mhub-sync'),applyToken}={}){
 requireDeviceLink(syncRoot);
 const sync=syncRoot,health=read(path.join(sync,'controller-health.json'));
 if(!Number.isFinite(health.at)||Date.now()-health.at<0||Date.now()-health.at>10000||health.phase!=='running'||health.connection?.state!=='ready')throw Error('设备联动未就绪，请先恢复联动。');
 const status=read(path.join(sync,'control-status.json'));
 if(status.pid===health.pid&&Date.now()-status.at>=0&&Date.now()-status.at<10000&&['voice','game'].includes(status.screenFeedback?.phase))throw Error('正在通话或互动，稍后再上传音箱。');
 if(activePhone(sync))throw Error('正在通话，稍后再上传音箱。');
 const id=randomUUID(),inbox=path.join(sync,'interaction-inbox'),receipts=path.join(sync,'asset-receipts');fs.mkdirSync(inbox,{recursive:true});fs.mkdirSync(receipts,{recursive:true});
 const lock=path.join(sync,'device-asset-upload.lock');
 if(fs.existsSync(lock)){
   const old=read(lock);
   // A receipt does not relinquish ownership: its caller may still be polling.
   if((old.waiting===false||!processAlive(old.pid))&&fs.existsSync(path.join(receipts,old.id+'.json')))fs.unlinkSync(lock);
   else throw Error('已有音箱上传未确认，请先检查其结果，不会重复上传。');
 }
 const release=()=>{try{if(read(lock).id===id)fs.unlinkSync(lock);}catch(error){if(error.code!=='ENOENT')throw error;}};
 let fd;try{fd=fs.openSync(lock,'wx');}catch{throw Error('已有音箱上传正在进行。');}
 try{fs.writeFileSync(fd,JSON.stringify({id,pid:process.pid,at:Date.now(),waiting:true}));}catch(error){fs.closeSync(fd);fs.rmSync(lock,{force:true});throw error;}fs.closeSync(fd);
 const command={id,...payload,at:Date.now()},file=path.join(inbox,command.at+'-'+id+'.json');try{fs.writeFileSync(file+'.tmp',JSON.stringify(command));fs.renameSync(file+'.tmp',file);}catch(error){fs.rmSync(file+'.tmp',{force:true});release();throw error;}
 const until=Date.now()+timeout;while(Date.now()<until){const receipt=path.join(receipts,id+'.json');if(fs.existsSync(receipt)){const r=read(receipt);release();if(!r.ok)throw Error(r.error);return r;}await new Promise(r=>setTimeout(r,250));}
 try{const old=read(lock);if(old.id===id){const temp=lock+'.'+id+'.tmp';fs.writeFileSync(temp,JSON.stringify({...old,waiting:false}));fs.renameSync(temp,lock);}}catch(error){if(error.code!=='ENOENT')throw error;}
 throw Error('上传结果尚未确认，请先检查音箱；没有重发上传请求。');
}

export async function queueRgbAsset(p,{stop=false,timeout=145000,syncRoot=path.resolve(root,'../harness-mhub-sync'),applyToken}={}){
 requireDeviceLink(syncRoot);
 if(stop)invalidateIntent(syncRoot);else if(applyToken!==undefined&&applyToken!==intentToken())throw Error('自动应用已取消，素材已保留。');
 if(!stop&&p?.manifest.kind!=='rgb')throw Error('不是RGB设备素材。');
 const health=read(path.join(syncRoot,'controller-health.json')),age=Date.now()-health.at;
 if(!Number.isFinite(age)||age<0||age>10000||health.phase!=='running'||health.connection?.state!=='ready')throw Error('设备联动未就绪，请先恢复联动，再应用现有素材；无需重新生成。');
 if(!stop&&activePhone(syncRoot))throw Error('请先结束通话，再切换设备动画。');
 const id=randomUUID(),at=Date.now(),command={id,at,kind:stop?'rgb-device-asset-stop':'rgb-device-asset-play',...(!stop?{assetId:p.id,applyToken}:{})};
 const inbox=path.join(syncRoot,'interaction-inbox'),receipts=path.join(syncRoot,'asset-receipts');fs.mkdirSync(inbox,{recursive:true});fs.mkdirSync(receipts,{recursive:true});
 const file=path.join(inbox,at+'-'+id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(command));fs.renameSync(file+'.tmp',file);
 const until=Date.now()+timeout;while(Date.now()<until){const file=path.join(receipts,id+'.json');if(fs.existsSync(file)){const r=read(file);if(!r.ok)throw Error(r.error);return r;}await new Promise(r=>setTimeout(r,200));}
 throw Error('播放操作尚未确认，没有重复执行；请先查询设备状态。');
}
