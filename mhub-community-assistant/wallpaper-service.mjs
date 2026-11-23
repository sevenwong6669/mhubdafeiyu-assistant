import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {readDeviceLink,DEVICE_LINK_PAUSED} from '../harness-mhub-sync/device-link-mode.mjs';

export const WALLPAPER_MAX_BYTES=32*1024*1024;
export const WALLPAPER_BODY_LIMIT=45*1024*1024;
const root=path.dirname(fileURLToPath(import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])])):value;
const equal=(a,b)=>JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
export const WALLPAPER_RECOVERY_LIMIT=3;
const TRANSFER_CHUNK=128*1024;
const NATIVE_WALLPAPER='my-wallpaper-custom';
const nativeWallpaperPending=snapshot=>{
 const id=snapshot.selection?.wallpaperId;
 return id===NATIVE_WALLPAPER?!snapshot.customHash:snapshot.config?.bgWallpaperV2?.wallpaperId===NATIVE_WALLPAPER;
};
export function wallpaperRecoveryOwns(current,journal){
 const before=journal.before,target=journal.operation==='restore'?journal.target:null;
 const selectionIds=snapshot=>{
  const ids=[snapshot.selection?.wallpaperId];
  if(snapshot.managedAssetId&&snapshot.renderer!==current.renderer)ids.push(snapshot.config?.bgWallpaperV2?.wallpaperId);
  return ids;
 };
 const previousIds=selectionIds(before);
 const matches=(config,ids,hash)=>equal(config,current.config)&&ids.includes(current.selection?.wallpaperId)&&hash===current.customHash;
 if(matches(before.config,previousIds,before.customHash))return true;
 if(!target&&journal.kind==='video')return matches(before.config,['dafeiyu-wallpaper-'+journal.assetId],before.customHash);
 const updatedHash=target?(target.file?target.customHash:before.customHash):journal.assetHash;
 const updatedConfig=target?.config??{bgWallpaperV2:{schemaVersion:2,wallpaperId:NATIVE_WALLPAPER},bgWallpaperDefaultMigrationVersion:1};
 const updatedIds=[...previousIds,...(target?selectionIds(target):[NATIVE_WALLPAPER])];
 // Native writes progress from bytes to configuration to selection. Match a
 // complete stage so an old asset cannot be combined with the new selection.
 return matches(before.config,previousIds,updatedHash)
   || matches(updatedConfig,updatedIds,updatedHash)
   || Boolean(target&&matches({...before.config,...target.config},updatedIds,updatedHash));
}
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('壁纸记录无法读取，原文件已保留。');}};
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';try{const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
export function wallpaperType(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<16||bytes.length>WALLPAPER_MAX_BYTES)throw Error('壁纸文件无效或超过 32 MB。');
 if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.length>=33&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0)return {ext:'png',mime:'image/png',kind:'static'};
 if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(8)>0)return {ext:'gif',mime:'image/gif',kind:'gif'};
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {ext:'jpg',mime:'image/jpeg',kind:'static'};
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {ext:'webp',mime:'image/webp',kind:'static'};
 if(bytes.toString('ascii',4,8)==='ftyp'&&bytes.readUInt32BE(0)>=16)return {ext:'mp4',mime:'video/mp4',kind:'video'};
 if(bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))&&bytes.subarray(0,4096).includes(Buffer.from('webm')))return {ext:'webm',mime:'video/webm',kind:'video'};
 throw Error('请选择 PNG、JPG、WebP、GIF、MP4 或 WebM 文件。');
}

// Executed inside M HUB's existing renderer. No device, lighting or driver files are touched.
export async function wallpaperTransaction(args){
 const p=document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
 const w=p?._s.get('wallpaperStore'),pc=p?._s.get('pcConfigStore'),api=window.electronAPI;
 if(!w||!pc||typeof w.setSelectedWallpaper!=='function'||typeof api?.saveBgImg!=='function')throw Error('当前 M HUB 版本未提供可用的壁纸接口。');
 const copy=x=>x==null?null:JSON.parse(JSON.stringify(x));
 // CDP connections can close on multi-megabyte messages. Bound each transfer,
 // expire abandoned buffers, and never expose a filesystem read operation.
 const maxBytes=32*1024*1024,chunkSize=128*1024;
 const transfers=window.__dafeiyuWallpaperTransfers??=new Map();
 for(const [id,item] of transfers)if(item.expires<Date.now())transfers.delete(id);
 const addTransfer=(id,bytes,mode)=>{if(!/^[a-f0-9-]{36}$/.test(id)||transfers.has(id)||transfers.size>=2||bytes.byteLength>maxBytes)throw Error('壁纸传输无效或已过期，请重试。');transfers.set(id,{bytes,mode,received:0,expires:Date.now()+60000});};
 if(args.operation==='transfer-begin'){if(!Number.isInteger(args.size)||args.size<16||args.size>maxBytes)throw Error('壁纸传输无效或已过期，请重试。');addTransfer(args.transferId,new Uint8Array(args.size),'write');return {ready:true};}
 if(args.operation==='transfer-release'){transfers.delete(args.transferId);return {released:true};}
 if(args.operation==='transfer-read'||args.operation==='transfer-write'){
  const item=transfers.get(args.transferId),offset=args.offset;
  if(!item||!Number.isInteger(offset)||offset<0||offset>=item.bytes.length)throw Error('壁纸传输无效或已过期，请重试。');item.expires=Date.now()+60000;
  if(args.operation==='transfer-read'){
   if(item.mode!=='read')throw Error('壁纸传输无效或已过期，请重试。');const bytes=item.bytes.subarray(offset,Math.min(offset+chunkSize,item.bytes.length));let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return {data:btoa(text),offset};
  }
  if(item.mode!=='write'||item.received!==offset||typeof args.data!=='string'||args.data.length>Math.ceil(chunkSize/3)*4)throw Error('壁纸传输无效或已过期，请重试。');const bytes=Uint8Array.from(atob(args.data),c=>c.charCodeAt(0));if(!bytes.length||bytes.length>chunkSize||offset+bytes.length>item.bytes.length)throw Error('壁纸传输无效或已过期，请重试。');item.bytes.set(bytes,offset);item.received+=bytes.length;return {received:item.received};
 }
 const videoBytes=video=>{if(!video.transferId)return Uint8Array.from(atob(video.data),c=>c.charCodeAt(0));const item=transfers.get(video.transferId);if(!item||item.mode!=='write'||item.received!==item.bytes.length)throw Error('壁纸传输无效或已过期，请重试。');return item.bytes;};
 let marker=window.__dafeiyuWallpaper;
 const media=()=>{const el=document.querySelector('.wallpaper-background__media');return el?{tag:el.tagName,ready:el.tagName==='VIDEO'?el.readyState>=2:el.complete&&el.naturalWidth>0,width:el.videoWidth||el.naturalWidth||0,height:el.videoHeight||el.naturalHeight||0,paused:el.tagName==='VIDEO'?el.paused:null,time:el.currentTime??null,error:el.error?.code??null}:null;};
 const snapshot=async content=>{
  const selected=copy(w.selection),custom=copy(w.customWallpaper);let customData=null,customHash=null,transferId=null,customSize=null;
  if(custom?.status==='available'&&custom.src){
   const r=await fetch(custom.src),bytes=await r.arrayBuffer();if(bytes.byteLength>32*1024*1024)throw Error('原壁纸超过备份上限，未替换。');
   if(!crypto.subtle)throw Error('当前驱动无法校验壁纸备份，未替换。');
   customHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
   if(content){const data=new Uint8Array(bytes);if(args.transferId){addTransfer(args.transferId,data,'read');transferId=args.transferId;customSize=data.length;}else {let text='';for(let i=0;i<data.length;i+=16384)text+=String.fromCharCode(...data.subarray(i,i+16384));customData=btoa(text);}}
  }
  return {renderer:performance.timeOrigin,selection:selected,customHash,customData,...(transferId?{transferId,customSize}:{}),config:{bgWallpaperV2:copy(pc.systemConfig.bgWallpaperV2),bgWallpaperDefaultMigrationVersion:pc.systemConfig.bgWallpaperDefaultMigrationVersion},media:media(),marker:marker?{id:marker.id,renderer:marker.renderer}:null};
 };
 if((args.operation==='inspect'||args.operation==='backup')&&!args.quiesce)return snapshot(args.operation==='backup');
 // A disconnected debugger does not cancel JavaScript already awaiting IPC.
 // Cancel its later steps and wait for its actual completion before rollback.
 const untilIdle=Date.now()+10000;
 while(window.__dafeiyuWallpaperPending){
  const previous=window.__dafeiyuWallpaperPending;previous.cancelled=true;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('上次壁纸操作仍未结束，请稍后恢复。')),Math.max(1,untilIdle-Date.now()));previous.done.then(()=>{clearTimeout(timer);resolve();});});
  if(Date.now()>=untilIdle&&window.__dafeiyuWallpaperPending)throw Error('上次壁纸操作仍未结束，请稍后恢复。');
 }
 marker=window.__dafeiyuWallpaper;
 if(args.operation==='inspect')return snapshot(false);
 let complete;const token={cancelled:false,done:new Promise(resolve=>{complete=resolve;})};window.__dafeiyuWallpaperPending=token;
 const checkpoint=()=>{if(token.cancelled)throw Error('壁纸操作已由后续恢复接替。');};
 const changed=()=>Error('M HUB 壁纸已改变，已保留当前壁纸。');
 const normalized=value=>Array.isArray(value)?value.map(normalized):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalized(value[k])])):value;
 const checkSelection=()=>{checkpoint();if(args.expected&&(w.selection?.wallpaperId!==args.expected.selection?.wallpaperId||JSON.stringify(normalized({bgWallpaperV2:copy(pc.systemConfig.bgWallpaperV2),bgWallpaperDefaultMigrationVersion:pc.systemConfig.bgWallpaperDefaultMigrationVersion}))!==JSON.stringify(normalized(args.expected.config))))throw changed();};
 try{
 if(args.expected){const current=await snapshot(false);checkpoint();if(current.renderer!==args.expected.renderer||current.customHash!==args.expected.customHash)throw changed();checkSelection();}
 const loadNative=async()=>{checkpoint();w.releaseCustomPreviewBlobUrl?.();const src=await api.getBgImg();checkpoint();if(typeof src!=='string'||!src)throw Error('M HUB 未返回已保存的壁纸。');const preview=await w.resolveCustomPreviewSrc(src);checkpoint();if(!preview)throw Error('M HUB 壁纸预览加载失败。');w.setCustomWallpaper({status:'available',src:preview});return preview;};
 const selection=item=>({wallpaperId:item.id,wallpaper:item,source:'v2',reason:null,shouldPersist:false});
 if(args.operation==='restore'){
  const saved=args.saved;
  if(saved.file){
   checkpoint();if(await api.saveBgImg(saved.file)!==true)throw Error('原壁纸文件恢复失败。');checkpoint();
   const src=await loadNative(),bytes=await(await fetch(src)).arrayBuffer();
   const restoredHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
   if(restoredHash!==saved.customHash)throw Error('原壁纸文件读回校验失败。');
  }
  checkSelection();const patch=saved.config??{},updated=await api.setConfig('system',patch);checkpoint();pc.updateSystemConfig(updated||patch);
  const confirmed=await api.getConfig('system');checkpoint();if(Object.keys(patch).some(key=>JSON.stringify(confirmed?.[key]??null)!==JSON.stringify(patch[key]??null)))throw Error('M HUB 未确认原壁纸设置恢复。');
  let item=copy(saved.selection?.wallpaper);
  if(saved.video){const bytes=videoBytes(saved.video),src=URL.createObjectURL(new Blob([bytes],{type:saved.video.mime}));item={...item,src,cover:''};}
  if(item?.id==='my-wallpaper-custom'){
   const src=await loadNative();item={...item,src,cover:src};
  }else if(item){for(const category of w.catalog?.categories??[])for(const group of category.groups??[]){const current=group.wallpapers?.find(x=>x.id===item.id);if(current)item=copy(current);}}
  checkpoint();w.setSelectedWallpaper(item?selection(item):null);
  if(marker?.ownedBlob&&marker.ownedBlob!==item?.src)URL.revokeObjectURL(marker.ownedBlob);
  if(saved.marker?.id)window.__dafeiyuWallpaper={id:saved.marker.id,renderer:performance.timeOrigin,ownedBlob:item?.mediaType==='video'?item.src:null};else delete window.__dafeiyuWallpaper;
  return {restored:true,renderer:performance.timeOrigin,wallpaperId:item?.id??null};
 }
 if(args.operation!=='apply')throw Error('不支持的壁纸操作。');
 let item,ownedBlob=null;
 if(args.asset.kind==='video'){
  const bytes=videoBytes(args);ownedBlob=URL.createObjectURL(new Blob([bytes],{type:args.asset.mime}));
  item={id:'dafeiyu-wallpaper-'+args.asset.id,name:args.asset.name,kind:'dynamic',mediaType:'video',source:'custom',theme:null,src:ownedBlob,cover:''};
 }else{
  checkpoint();if(await api.saveBgImg(args.file)!==true)throw Error('M HUB 壁纸导入失败。');checkpoint();
  const src=await loadNative(),copied=await(await fetch(src)).arrayBuffer();
  const copiedHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',copied)),n=>n.toString(16).padStart(2,'0')).join('');
  if(copiedHash!==args.asset.sha256)throw Error('M HUB 壁纸文件读回校验失败。');
  item={id:'my-wallpaper-custom',name:args.asset.name,kind:args.asset.kind==='gif'?'dynamic':'static',mediaType:'image',source:'custom',theme:null,src,cover:src};
  checkSelection();const patch={bgWallpaperV2:{schemaVersion:2,wallpaperId:item.id},bgWallpaperDefaultMigrationVersion:1};
  const updated=await api.setConfig('system',patch);checkpoint();pc.updateSystemConfig(updated||patch);
  if((await api.getConfig('system'))?.bgWallpaperV2?.wallpaperId!==item.id)throw Error('M HUB 未确认壁纸设置保存。');
 }
 checkpoint();w.setSelectedWallpaper(selection(item));
 window.__dafeiyuWallpaper={id:args.asset.id,renderer:performance.timeOrigin,ownedBlob};
 const until=Date.now()+9000;
 while(Date.now()<until){checkpoint();const el=document.querySelector('.wallpaper-background__media'),matches=el&&(el.currentSrc===item.src||el.getAttribute('src')===item.src),current=media();if(matches&&current?.error)throw Error('M HUB 无法解码该视频或图片。');if(matches&&current?.ready){if(marker?.ownedBlob&&marker.ownedBlob!==ownedBlob)URL.revokeObjectURL(marker.ownedBlob);return {applied:true,renderer:performance.timeOrigin,wallpaperId:item.id,media:current,kind:args.asset.kind};}await new Promise(r=>setTimeout(r,80));}
 throw Error('壁纸已提交，但 M HUB 未确认画面解码。');
 }finally{if(window.__dafeiyuWallpaperPending===token)delete window.__dafeiyuWallpaperPending;complete();}
}

export class WallpaperService{
 constructor({stateDir=path.join(root,'state'),evaluate=evaluateInMhub,preset=path.join(root,'panel/themes/assets/dafeiyu-wallpaper.png'),clock=Date.now,link=()=>readDeviceLink(path.join(root,'../harness-mhub-sync')).enabled}={}){
  this.dir=path.join(stateDir,'wallpapers');this.file=path.join(this.dir,'library.json');this.evaluate=async(...args)=>{try{return await evaluate(...args);}catch(error){if(error.cause?.code==='ECONNREFUSED'||/M HUB connection unavailable|M HUB connection timed out|Expected one M HUB main renderer/.test(error.message))throw Error('M HUB 联动接口未连接，请先在总览恢复联动。');throw error;}};this.clock=clock;this.link=link;this.preset=preset;this.pending=null;this.closed=false;this.nextTick=0;
  const empty={schemaVersion:1,assets:[],active:null,original:null};this.last={phase:'idle'};
  try{this.data=read(this.file)??empty;if(this.data.schemaVersion!==1||!Array.isArray(this.data.assets)||this.data.assets.length>20||this.data.assets.some(a=>!a||!/^[a-f0-9]{64}$/.test(a.id)||typeof a.name!=='string'||a.name.length>120||!['png','jpg','gif','webp','mp4','webm'].includes(a.ext)||!['static','gif','video'].includes(a.kind)||typeof a.mime!=='string'||!/^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm))$/.test(a.mime)||a.preset))throw Error('壁纸记录格式无效，原文件已保留。');}
  catch(error){this.data=empty;this.configError=error.message;this.last={phase:'failed',error:error.message};}
  if(!this.configError&&(this.data.active||this.data.original))this.last={phase:'unverified'};
  const j=this.data.recovery;
  if(!this.configError&&j){
   if(!/^[a-f0-9-]{36}$/.test(j.id)||!['apply','restore'].includes(j.operation)||!['pending','recovering','retrying','failed'].includes(j.phase)||!Number.isInteger(j.attempts)||j.attempts<0||j.attempts>WALLPAPER_RECOVERY_LIMIT||!j.before?.config||!j.previous||j.operation==='restore'&&!j.target){this.configError='壁纸记录格式无效，原文件已保留。';this.last={phase:'failed',error:this.configError};}
   else {j.nextRetryAt=Math.min(Number.isFinite(j.nextRetryAt)?j.nextRetryAt:0,this.clock()+15000);this.last={phase:j.phase==='failed'?'recovery-failed':'recovery-pending',error:j.error??null};}
  }
 }
 persist(value=this.data){atomic(this.file,value);}
 requireWrite(){if(this.closed)throw Error('壁纸操作已中断，下次启动时恢复。');if(!this.link())throw Error(DEVICE_LINK_PAUSED);}
 commit(value){try{this.persist(value);this.data=value;}catch(error){if(this.data.recovery){this.recoveryBlocked=true;this.last={phase:'recovery-failed',error:error.message,at:this.clock()};}throw error;}}
 verifyBackup(saved){
  if(!saved?.file)return;
  try{
   const real=fs.realpathSync(saved.file),base=fs.realpathSync(path.join(this.dir,'backup'));
   if(path.dirname(real)!==base||!/^[a-f0-9]{64}$/.test(saved.customHash)||fs.statSync(real).size>WALLPAPER_MAX_BYTES)throw Error('Invalid backup');
   const bytes=fs.readFileSync(real);wallpaperType(bytes);if(sha(bytes)!==saved.customHash)throw Error('Changed backup');
  }catch{throw Error('原壁纸备份校验失败，未替换。');}
 }
 asset(id){if(id==='dafeiyu-blue')return {id,name:'大肥鱼 · 深海蓝',kind:'static',mime:'image/png',ext:'png',preset:true};const a=this.data.assets.find(x=>x.id===id);if(!a)throw Error('壁纸文件不存在。');return a;}
 assetFile(a){return a.preset?this.preset:path.join(this.dir,'media',a.id+'.'+a.ext);}
 snapshot(){const j=this.data.recovery,status=j&&!this.recoveryBlocked&&!this.link()?{...this.last,phase:'recovery-paused'}:this.last;return {assets:[this.asset('dafeiyu-blue'),...this.data.assets],active:this.data.active?{id:this.data.active.id,kind:this.data.active.kind}:null,canRestore:!!(this.data.original||j),recovery:j?{id:j.id,phase:this.recoveryBlocked?'failed':j.phase,attempts:j.attempts,limit:WALLPAPER_RECOVERY_LIMIT,nextRetryAt:j.nextRetryAt??null}:null,status:clone(status),busy:!!this.pending,maxBytes:WALLPAPER_MAX_BYTES};}
 async serial(fn){if(this.pending)throw Error('壁纸操作正在进行，请稍候。');const task=fn();this.pending=task;try{return await task;}finally{if(this.pending===task)this.pending=null;}}
 budget(extra){let total=0;for(const dir of ['media','backup']){const base=path.join(this.dir,dir);if(fs.existsSync(base))for(const n of fs.readdirSync(base)){const st=fs.statSync(path.join(base,n));if(st.isFile())total+=st.size;}}if(total+extra>512*1024*1024)throw Error('壁纸素材已达到 512 MB，请先移除不用的素材。');}
 import({name,data}){
  if(typeof name!=='string'||!name.trim()||name.length>120||/[\x00-\x1f<>]/.test(name)||typeof data!=='string'||data.length>Math.ceil(WALLPAPER_MAX_BYTES/3)*4||!data.length||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw Error('壁纸上传数据无效。');
  const bytes=Buffer.from(data,'base64'),type=wallpaperType(bytes),id=sha(bytes);
  if(this.data.assets.some(x=>x.id===id))return {ok:true,id,message:'该素材已在壁纸库中。'};
  if(this.data.assets.length>=20)throw Error('最多保留 20 个壁纸素材。');
  const asset={id,name:path.basename(name).replace(/[\\/]/g,'').trim(),...type,size:bytes.length},file=this.assetFile(asset);
  let created=false;
  try{
   if(fs.existsSync(file)){
    if(sha(fs.readFileSync(file))!==id)throw Error('壁纸文件校验失败，未应用。');
   }else{
    this.budget(bytes.length);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const fd=fs.openSync(file,'wx');
    created=true;
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   }
   this.commit({...this.data,assets:[...this.data.assets,asset]});
  }catch(error){
   if(created)try{fs.unlinkSync(file);}catch{}
   throw error;
  }
  return {ok:true,id,message:'壁纸素材已导入，点击应用后替换 M HUB 壁纸。'};
 }
 async backup(){
  const transferId=randomUUID();let saved,bytes,file=null;
  try{
   saved=await this.evaluate(wallpaperTransaction,{operation:'backup',transferId});
   if(saved.transferId){
    if(saved.transferId!==transferId||!Number.isInteger(saved.customSize)||saved.customSize<16||saved.customSize>WALLPAPER_MAX_BYTES)throw Error('原壁纸备份校验失败，未替换。');bytes=Buffer.alloc(saved.customSize);
    for(let offset=0;offset<bytes.length;offset+=TRANSFER_CHUNK){if(this.closed)throw Error('壁纸操作已中断，下次启动时恢复。');const part=await this.evaluate(wallpaperTransaction,{operation:'transfer-read',transferId,offset});if(part.offset!==offset||typeof part.data!=='string'||part.data.length>Math.ceil(TRANSFER_CHUNK/3)*4)throw Error('原壁纸备份校验失败，未替换。');const chunk=Buffer.from(part.data,'base64');if(chunk.length!==Math.min(TRANSFER_CHUNK,bytes.length-offset))throw Error('原壁纸备份校验失败，未替换。');chunk.copy(bytes,offset);}
   }else if(saved.customData)bytes=Buffer.from(saved.customData,'base64');
  }finally{if(saved?.transferId)await this.evaluate(wallpaperTransaction,{operation:'transfer-release',transferId}).catch(()=>{});}
  if(bytes){const type=wallpaperType(bytes);if(sha(bytes)!==saved.customHash)throw Error('原壁纸备份校验失败，未替换。');file=path.join(this.dir,'backup',saved.customHash+'.'+type.ext);if(!fs.existsSync(file)){this.budget(bytes.length);fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}delete saved.customData;delete saved.transferId;delete saved.customSize;
  if(saved.selection?.wallpaper?.src?.startsWith('blob:')&&saved.selection.wallpaper.mediaType==='video'){
   const active=this.data.active;if(active?.kind!=='video'||saved.selection.wallpaperId!=='dafeiyu-wallpaper-'+active.id||saved.marker?.id!==active.id)throw Error('当前视频壁纸无法可靠备份，请先在 M HUB 选择可保存的壁纸。');saved.managedAssetId=active.id;
  }
  const result={...saved,file};this.verifyBackup(result);return result;
 }
 matchesNative(active,snapshot){
  if(snapshot.selection?.wallpaperId!==NATIVE_WALLPAPER||!snapshot.customHash)return false;
  const expected=active.contentSha256??(active.id==='dafeiyu-blue'?sha(fs.readFileSync(this.preset)):active.id);
  return snapshot.customHash===expected;
 }
 nativeOwnership(active,snapshot){
  if(!snapshot.selection?.wallpaperId||nativeWallpaperPending(snapshot))return 'waiting';
  return this.matchesNative(active,snapshot)?'owned':'changed';
 }
 journal(operation,before,extra={}){
  const active=this.data.active;
  const owned=active&&(active.kind==='video'
   ?before.selection?.wallpaperId==='dafeiyu-wallpaper-'+active.id&&before.marker?.id===active.id
   :this.matchesNative(active,before));
  return {id:randomUUID(),operation,phase:'pending',attempts:0,nextRetryAt:0,startedAt:this.clock(),before,
   previous:{active:owned?clone(active):null,original:clone(this.data.original??null)},...extra};
 }
 async withVideo(bytes,run){
  this.requireWrite();
  if(bytes.length<=TRANSFER_CHUNK)return run({data:bytes.toString('base64')});const transferId=randomUUID();
  try{
   await this.evaluate(wallpaperTransaction,{operation:'transfer-begin',transferId,size:bytes.length});
   for(let offset=0;offset<bytes.length;offset+=TRANSFER_CHUNK){this.requireWrite();const chunk=bytes.subarray(offset,offset+TRANSFER_CHUNK),ack=await this.evaluate(wallpaperTransaction,{operation:'transfer-write',transferId,offset,data:chunk.toString('base64')});if(ack.received!==offset+chunk.length)throw Error('壁纸传输无效或已过期，请重试。');}
   this.requireWrite();return await run({transferId});
  }finally{await this.evaluate(wallpaperTransaction,{operation:'transfer-release',transferId}).catch(()=>{});}
 }
 async restoreSnapshot(saved,expected){
  this.requireWrite();
  this.verifyBackup(saved);
  if(saved.managedAssetId){const a=this.asset(saved.managedAssetId),bytes=fs.readFileSync(this.assetFile(a));if(a.kind!=='video'||sha(bytes)!==a.id)throw Error('壁纸文件校验失败，未应用。');return this.withVideo(bytes,transfer=>this.evaluate(wallpaperTransaction,{operation:'restore',saved:{...saved,video:{id:a.id,mime:a.mime,...transfer}},...(expected?{expected}:{})},22000));}
  return this.evaluate(wallpaperTransaction,{operation:'restore',saved,...(expected?{expected}:{})},22000);
 }
 async recoverJournal(){
  let j=this.data.recovery;if(!j)return {ok:true,message:'没有需要恢复的壁纸。'};
  this.requireWrite();
  if(j.attempts>=WALLPAPER_RECOVERY_LIMIT)return {ok:false,message:'壁纸恢复已停止，请手动重试。'};
  j={...j,attempts:j.attempts+1,phase:'recovering',nextRetryAt:0};this.commit({...this.data,recovery:j});this.recoveryBlocked=false;this.last={phase:'recovering',at:this.clock()};
  try{
   const current=await this.evaluate(wallpaperTransaction,{operation:'inspect',quiesce:true},14000);this.requireWrite();
   if(!wallpaperRecoveryOwns(current,j)){
    if(current.selection?.wallpaperId===NATIVE_WALLPAPER&&!current.customHash)throw Error('M HUB 未返回已保存的壁纸。');
    return this.yieldRecovery(j);
   }
   const saved=j.operation==='restore'?j.target:j.before;
   const receipt=await this.restoreSnapshot(saved,current);this.requireWrite();if(receipt?.restored!==true)throw Error('M HUB 未确认原壁纸设置恢复。');
   const active=j.operation==='restore'?null:j.previous.active;
   this.commit({...this.data,active:active?{...active,renderer:receipt.renderer??current.renderer}:null,original:j.operation==='restore'?null:j.previous.original,recovery:null,lastRecovery:{id:j.id,phase:'completed',at:this.clock()}});
   this.last={phase:'restored',at:this.clock()};return {ok:true,message:'已恢复之前的 M HUB 壁纸。',receipt};
  }catch(error){
   if(this.closed||!this.link())throw error;
   if(/M HUB 壁纸已改变/.test(error.message))return this.yieldRecovery(j);
   const exhausted=j.attempts>=WALLPAPER_RECOVERY_LIMIT;
   this.commit({...this.data,recovery:{...j,phase:exhausted?'failed':'retrying',error:error.message,nextRetryAt:exhausted?null:this.clock()+[5000,15000][j.attempts-1]}});
   this.last={phase:exhausted?'recovery-failed':'recovery-pending',error:error.message,at:this.clock()};throw error;
  }
 }
 yieldRecovery(j){this.commit({...this.data,active:null,original:this.data.original??j.before,recovery:null,lastRecovery:{id:j.id,phase:'user-changed',at:this.clock()}});this.last={phase:'user-changed',at:this.clock()};return {ok:true,message:'M HUB 壁纸已改变，已保留当前壁纸。'};}
 async apply(id){
  this.requireWrite();
  const a=this.asset(id),file=this.assetFile(a),bytes=fs.readFileSync(file),contentSha256=sha(bytes);if(a.id!=='dafeiyu-blue'&&contentSha256!==a.id)throw Error('壁纸文件校验失败，未应用。');wallpaperType(bytes);
  const before=await this.backup();
  this.requireWrite();
  this.commit({...this.data,recovery:this.journal('apply',before,{assetId:a.id,assetHash:contentSha256,kind:a.kind})});
  try{const apply=transfer=>{this.requireWrite();return this.evaluate(wallpaperTransaction,{operation:'apply',expected:before,asset:{...a,sha256:contentSha256},file,...transfer},22000);};const receipt=a.kind==='video'?await this.withVideo(bytes,apply):await apply({});
   this.requireWrite();if(receipt?.applied!==true)throw Error('壁纸已提交，但 M HUB 未确认画面解码。');
   this.commit({...this.data,original:this.data.original??before,active:{id:a.id,kind:a.kind,renderer:receipt.renderer,...(a.kind==='video'?{resumeBase:{config:clone(before.config),customHash:before.customHash}}:{contentSha256})},recovery:null});this.last={phase:'applied',at:this.clock(),receipt};return {ok:true,message:a.kind==='video'?'视频壁纸已应用；设备详情页或最小化时由 M HUB 暂停播放。':'M HUB 壁纸已应用并保存。',receipt};
  }catch(error){if(this.closed||!this.link())throw error;try{await this.recoverJournal();}catch{}if(this.data.recovery)throw Error(error.message+' 原壁纸尚未完全恢复，请点击恢复之前的壁纸。');throw error;}
 }
 async restore(){
  this.requireWrite();
  if(this.data.recovery){this.commit({...this.data,recovery:{...this.data.recovery,attempts:0,phase:'pending',nextRetryAt:0,error:null}});this.recoveryBlocked=false;return this.recoverJournal();}
  if(!this.data.original)return {ok:true,message:'没有需要恢复的壁纸。'};this.verifyBackup(this.data.original);const before=await this.backup();this.requireWrite();this.commit({...this.data,recovery:this.journal('restore',before,{target:this.data.original})});return this.recoverJournal();
 }
 async action(input){
  return this.serial(async()=>{
   if(this.configError)throw Error(this.configError);
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['operation','id','name','data'].includes(k)))throw Error('壁纸请求无效。');
   try{
    if(this.closed)throw Error('壁纸操作已中断，下次启动时恢复。');
    if(this.data.recovery&&['apply','remove'].includes(input.operation))throw Error('上次壁纸操作尚未恢复，请先恢复或停止恢复。');
    if(input.operation==='import')return this.import(input);
    if(input.operation==='apply')return await this.apply(input.id);
    if(input.operation==='restore')return await this.restore();
    if(input.operation==='inspect'){
     const current=await this.evaluate(wallpaperTransaction,{operation:'inspect'});delete current.customData;
     if(this.data.recovery)return {ok:true,message:'已读取 M HUB 壁纸状态。',snapshot:this.snapshot()};
     const active=this.data.active;let phase='checked';
     if(active&&(active.kind!=='video'||current.renderer===active.renderer)){
      const ownership=active.kind==='video'
       ?current.marker?.id===active.id&&current.selection?.wallpaperId==='dafeiyu-wallpaper-'+active.id?'owned':'changed'
       :this.nativeOwnership(active,current);
      if(ownership==='waiting')phase='waiting';
      if(ownership==='changed'){this.commit({...this.data,active:null});phase='user-changed';}
     }
     this.last={phase,at:this.clock(),current};return {ok:true,message:'已读取 M HUB 壁纸状态。',snapshot:this.snapshot()};
    }
    if(input.operation==='release'){const j=this.data.recovery;this.commit({...this.data,active:null,original:this.data.original??j?.before??null,recovery:null,...(j?{lastRecovery:{id:j.id,phase:'cancelled',at:this.clock()}}:{})});this.last={phase:'released',at:this.clock()};return {ok:true,message:'已停止壁纸接管，当前画面保留。'};}
    if(input.operation==='remove'){const a=this.asset(input.id);if(a.preset||this.data.active?.id===a.id)throw Error('请先停止使用该壁纸，再移除素材。');this.commit({...this.data,assets:this.data.assets.filter(x=>x.id!==a.id)});try{fs.unlinkSync(this.assetFile(a));}catch(error){if(error.code!=='ENOENT')throw error;}return {ok:true,message:'壁纸素材已移除。'};}
    throw Error('不支持的壁纸操作。');
   }catch(error){if(!this.data.recovery)this.last={phase:'failed',error:error.message,at:this.clock()};throw error;}
  });
 }
 media(id,range){
  const a=this.asset(id),file=this.assetFile(a),real=fs.realpathSync(file),base=fs.realpathSync(a.preset?path.dirname(this.preset):path.join(this.dir,'media'));
  if(path.dirname(real)!==base)throw Error('壁纸资源路径无效。');const size=fs.statSync(real).size;
  const headers={'content-type':a.mime,'cache-control':'private, max-age=300','x-content-type-options':'nosniff','accept-ranges':'bytes','content-security-policy':"default-src 'none'; sandbox"};let start=0,end=size-1,status=200;
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{...headers,'content-range':`bytes */${size}`}});if(match[1]){start=Number(match[1]);end=match[2]?Number(match[2]):end;}else start=Math.max(0,size-Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return new Response(null,{status:416,headers:{...headers,'content-range':`bytes */${size}`}});end=Math.min(end,size-1);status=206;headers['content-range']=`bytes ${start}-${end}/${size}`;}
  headers['content-length']=String(end-start+1);
  const body=size?Readable.toWeb(fs.createReadStream(real,{start,end}),{
   strategy:{highWaterMark:64*1024,size:chunk=>chunk.byteLength}
  }):null;
  return new Response(body,{status,headers});
 }
 async tick(){
  if(this.closed||this.configError||this.pending||!this.link())return;
  if(this.data.recovery){if(this.recoveryBlocked||this.data.recovery.phase==='failed'||this.clock()<(this.data.recovery.nextRetryAt??0))return;try{await this.serial(()=>this.recoverJournal());}catch{}return;}
  const active=this.data.active;if(!active||this.clock()<this.nextTick)return;
  // Static and GIF wallpapers live natively in M HUB: only re-check them until
  // the loaded record is verified once. Videos keep the 15s renderer watch.
  if(active.kind!=='video'&&!['unverified','waiting'].includes(this.last.phase))return;this.nextTick=this.clock()+15000;
  try{await this.serial(async()=>{
   const s=await this.evaluate(wallpaperTransaction,{operation:'inspect'}),active=this.data.active;
   if(this.closed||!this.link()||!active)return;
   if(active.kind!=='video'){
    const ownership=this.nativeOwnership(active,s);
    if(ownership==='owned')this.last={phase:'checked',at:this.clock()};
    if(ownership==='changed'){this.commit({...this.data,active:null});this.last={phase:'user-changed',at:this.clock()};}
    return;
   }
   const selected=s.selection?.wallpaperId==='dafeiyu-wallpaper-'+active.id;
   if(s.marker?.id===active.id&&selected){if(this.last.phase==='unverified')this.last={phase:'checked',at:this.clock()};if(!active.resumeBase)this.commit({...this.data,active:{...active,resumeBase:{config:clone(s.config),customHash:s.customHash}}});return;}
   const base=active.resumeBase??this.data.original;
   if(s.renderer===active.renderer||!equal(s.config,base?.config)||s.customHash!==base?.customHash){this.commit({...this.data,active:null});this.last={phase:'user-changed',at:this.clock()};return;}
   await this.apply(active.id);
  });}catch(error){this.nextTick=this.clock()+60000;if(!this.data.recovery)this.last={phase:'waiting',at:this.clock(),error:error.message};}
 }
 close(){this.closed=true;}
}
