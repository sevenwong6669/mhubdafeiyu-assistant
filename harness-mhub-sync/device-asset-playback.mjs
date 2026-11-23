import {runtime} from '../runtime-paths.mjs';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {mhub} from '../dafeiyu-mhub-bridge/mhub.mjs';
import {deviceLighting} from './native-light-state.mjs';
import {LightSession} from './light-session.mjs';
import {writeJson} from './resilience.mjs';
import {readDeviceAsset} from '../mhub-community-assistant/device-asset-import.mjs';

const journal=new URL('device-asset-playback.json',import.meta.url);
export async function prepareRgbGif(p){
 if(p.manifest.file!=='asset.gif')return null;
 const output=await new Promise((resolve,reject)=>{
  const script=fileURLToPath(new URL('../mhub-community-assistant/scripts/pack-rgb-gif.py',import.meta.url));
  const child=execFile(runtime.python,['-X','utf8',script],
   {windowsHide:true,timeout:20000,maxBuffer:20*1024*1024,encoding:'buffer'},(error,stdout)=>error?reject(Error('本地 GIF 解码失败，素材已保留；请检查设备素材转换器。')):resolve(stdout));
  child.stdin.on('error',()=>{});
  child.stdin.end(p.bytes);
 });
 const end=output.indexOf(10),png=output.subarray(end+1);
 if(end<0||!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('本地 GIF 播放帧格式无效。');
 const meta=JSON.parse(output.subarray(0,end));
 if(meta.durations?.length!==p.manifest.frames||meta.width!==png.readUInt32BE(16)||meta.height*meta.durations.length!==png.readUInt32BE(20))throw Error('本地 GIF 播放帧与素材记录不一致。');
 return {id:'media-qq-'+p.id,...meta,png:png.toString('base64')};
}
export class DeviceAssetPlayback{
 constructor({evaluate=evaluateInMhub,readAsset=readDeviceAsset,session,status=()=>mhub('status')}={}){
  this.evaluate=evaluate;this.readAsset=readAsset;this.status=status;this.info=null;
  this.session=session??new LightSession({devices:(action,p)=>deviceLighting(action,{...p,preserveSide:true}),persist:v=>writeJson(journal,{...v,draftCleanupPending:!!this.info,playback:this.info}),load:async()=>JSON.parse(await fs.readFile(journal,'utf8'))});
 }
 get active(){return this.session.active;}
 get sceneId(){return this.info?.sceneId??null;}
 async recover(){
  let old;try{old=await this.session.load();}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if((!old.active&&!old.draftCleanupPending)||!old.saved)return null;
  this.info=old.playback??this.info;this.session.saved=old.saved;this.session.active=!!old.active;
  if(old.saved.writePending){const current=await this.status();if(current.signature===this.info?.activatedSignature)await this.session.markApplied(current.signature);else await this.session.cancelWrite();}
  const result=await this.end();return result.restored;
 }
 async prepare(assetId){
  const p=this.readAsset(assetId);
  if(p.manifest.kind!=='rgb')throw Error('音箱素材使用小屏上传通道。');
  return {p,media:await prepareRgbGif(p)};
 }
 async start(assetId,prepared){
  if(this.active||this.info)throw Error('请先停止当前设备动画并完成恢复，再播放另一份素材。');
  const {p,media}=prepared??await this.prepare(assetId);
  const sceneId='scene-qq-'+p.id,mediaId='media-qq-'+p.id;
  const plan=await this.evaluate(async({sceneId,mediaId,digest,allConnected})=>{
   const m=await loadMhubModule(),s=m.c3(),scene=s.scenes.find(v=>v.id===sceneId),connected=new Set(s.connectedDeviceIds??[]);
   if(scene?.qqAssetDigest!==digest||scene.surfaces?.[0]?.light?.customAssetId!==mediaId)throw Error('请先导入并校验这份素材。');
   const ids=scene.devices.filter(d=>(allConnected||d.selected)&&connected.has(d.id)).map(d=>d.id);if(!ids.length)throw Error('场景所选设备未连接。');
   const keyboardIds=scene.devices.filter(d=>d.type==='keyboard'&&ids.includes(d.id)).map(d=>d.id);
   const draftSelections=scene.devices.map(d=>({id:d.id,selected:d.selected}));
   const draftTransform=scene.surfaces[0].transform;let playbackTransform=draftTransform;
   if(allConnected){
    const points=[];for(const d of scene.devices.filter(d=>ids.includes(d.id))){const t=d.transform;if(!t||![t.x,t.y,t.width,t.height].every(Number.isFinite))throw Error('同步设备布局无效。');const a=(t.rotation||0)*Math.PI/180,k=t.scale||1;for(const x of [-t.width/2,t.width/2])for(const y of [-t.height/2,t.height/2])points.push([t.x+k*(x*Math.cos(a)-y*Math.sin(a)),t.y+k*(x*Math.sin(a)+y*Math.cos(a))]);}
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys);playbackTransform={x:(l+r)/2,y:(t+b)/2,width:r-l,height:b-t,rotation:0,scale:1};
   }
   const activatedSignature=JSON.stringify({master:true,id:sceneId,lights:scene.surfaces.map(x=>({id:x.id,enabled:x.enabled,light:x.light})),devices:scene.devices.map(x=>({id:x.id,selected:keyboardIds.includes(x.id)?false:ids.includes(x.id)?true:x.selected}))});
   return {ids,name:scene.name,activatedSignature,keyboardIds,draftSelections,draftTransform,playbackTransform};
  },{sceneId,mediaId,digest:p.sha256,allConnected:p.manifest.target==='sync'},5000);
  await this.session.begin(plan.ids);
  this.info={assetId,sceneId,name:plan.name,ids:plan.ids,startedAt:Date.now(),keyboardIds:plan.keyboardIds,draftSelections:plan.draftSelections,draftTransform:plan.draftTransform,playbackTransform:plan.playbackTransform,activatedSignature:plan.activatedSignature};
  this.media=media;
  // Journal the planned owner before touching the scene so recovery can undo
  // a renderer interruption between activation and its acknowledgement.
  await this.session.beforeWrite();
  try{
   const result=await this.evaluate(async({sceneId,digest,expected,keyboardIds,ids,playbackTransform})=>{
    const m=await loadMhubModule(),s=m.c3();
    const signature=()=>JSON.stringify({master:s.masterEnabled,id:s.activeSceneId,lights:s.activeScene?.surfaces.map(x=>({id:x.id,enabled:x.enabled,light:x.light})),devices:s.activeScene?.devices.map(x=>({id:x.id,selected:x.selected}))});
    if(signature()!==expected)throw Error('M HUB设置已改变，未覆盖你的选择。');
    const scene=s.scenes.find(v=>v.id===sceneId);if(scene?.qqAssetDigest!==digest)throw Error('素材场景校验失败。');
    s.selectScene(sceneId);if(playbackTransform)scene.surfaces[0].transform=playbackTransform;for(const d of scene.devices)if(ids.includes(d.id))s.setDeviceSelected(d.id,!keyboardIds.includes(d.id));s.setMasterEnabled(true);
    return {signature:signature(),activated:s.activeSceneId===sceneId&&s.masterEnabled};
   },{sceneId,digest:p.sha256,expected:this.session.saved.lastApplied,keyboardIds:plan.keyboardIds,ids:plan.ids,playbackTransform:plan.playbackTransform},5000);
   await this.session.markApplied(result.signature);return {...this.info,...result};
  }catch(error){
   // A timed-out activation may already have selected our scene. Retain a
   // recoverable claim only when its digest still matches; never replay it.
   const current=await this.status().catch(()=>null);
   if(current?.signature===plan.activatedSignature)await this.session.markApplied(current.signature);
   else await this.session.cancelWrite();
   throw error;
  }
 }
 async end(){if(!this.active&&!this.info)return {stopped:true,alreadyStopped:true};const info=this.info,result=await this.session.end()??this.session.lastResult??{};if(info&&!(result.preserved?.length))await this.evaluate(async({sceneId,selections,draftTransform,playbackTransform,keyboardIds,ids})=>{const m=await loadMhubModule(),s=m.c3(),scene=s.scenes.find(v=>v.id===sceneId);if(scene){for(const d of scene.devices){const old=selections.find(v=>v.id===d.id);if(old&&d.selected===(keyboardIds.includes(d.id)?false:ids.includes(d.id)?true:old.selected))d.selected=old.selected;}if(draftTransform&&JSON.stringify(scene.surfaces[0]?.transform)===JSON.stringify(playbackTransform))scene.surfaces[0].transform=draftTransform;}return {updated:true};},{sceneId:info.sceneId,keyboardIds:info.keyboardIds??[],ids:info.ids??[],selections:info.draftSelections??(info.keyboardIds??[]).map(id=>({id,selected:true})),draftTransform:info.draftTransform,playbackTransform:info.playbackTransform},3000);this.info=null;try{await this.session.persist({active:false,saved:this.session.saved,lastResult:result,draftCleanupPending:false});}catch(error){this.info=info;throw error;}this.media=null;return {stopped:true,...info,restored:result};}
 async changed(){return this.active&&(await this.status()).signature!==this.session.saved.lastApplied;}
 snapshot(){if(!this.active)return {active:false,pendingCleanup:!!this.info};const {activatedSignature,...info}=this.info??{};return {active:true,...info};}
}
