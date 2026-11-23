import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {writeJson} from './resilience.mjs';
import {AmbientStrip} from './ambient-strip.mjs';
import {balanceFailure,balanceRetryDelay} from '../mhub-community-assistant/balance-source.mjs';
import {BALANCE_KEYBOARDS,balanceLayout} from './balance-keyboards.mjs';
const root=new URL('balance-bar/',import.meta.url),settingsFile=new URL('settings.json',root);
const SURFACE='dafeiyu-balance-surface';
export function accountBalance(snapshot,currency='CNY',now=Date.now()){
  const row=snapshot?.balances?.find(x=>x.currency===currency);
  const amount=typeof row?.total==='string'&&/^\d+(\.\d+)?$/.test(row.total)?Number(row.total):NaN;
  if(snapshot?.status!=='ready'||!Number.isFinite(snapshot.checkedAt)||snapshot.checkedAt>now+60000||now-snapshot.checkedAt>180000&&!(snapshot.stale===true&&snapshot.retained===true)||!Number.isFinite(amount))return null;
  return {amount,currency:row.currency,checkedAt:snapshot.checkedAt,stale:snapshot.stale===true};
}
export function balanceView(snapshot,settings,now=Date.now()){
  const balance=accountBalance(snapshot,settings.currency,now);if(!balance)return null;
  const {amount,currency,checkedAt}=balance;
  const ratio=Math.max(0,Math.min(1,amount/settings.fullAmount)),level=amount===0?8:Math.max(1,Math.round(ratio*28*8));
  return {amount,currency,ratio,level,zeroAlert:amount===0,stale:balance.stale,litSegments:Math.ceil(level/8),color:ratio>.5?'#00FF00':ratio>.2?'#FFB400':'#FF0000',checkedAt};
}
export function barPng(view){
  const c=view.color.slice(1).match(/../g).map(x=>parseInt(x,16));
  const raw=Buffer.alloc(1+28*3);
  for(let i=0;i<28;i++)for(let k=0;k<3;k++)raw[1+i*3+k]=Math.round(c[k]*Math.max(0,Math.min(1,view.level/8-i)));
  function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,crc]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(28,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
async function renderer({expected,visible,base64,assetId,brightness,remove=false}){
  const m=await loadMhubModule(),s=m.c3(),scene=s.activeScene;
  const signature=()=>JSON.stringify({master:s.masterEnabled,id:s.activeSceneId,lights:s.activeScene?.surfaces.map(x=>({id:x.id,enabled:x.enabled,light:x.light})),devices:s.activeScene?.devices.map(x=>({id:x.id,selected:x.selected}))});
  if(signature()!==expected)return {changed:false,signature:signature(),reason:'manual-change'};
  if(scene?.desktopCompanionVersion!==1)return {changed:false,signature:signature(),reason:'not-companion'};
  let surface=scene.surfaces.find(x=>x.desktopBalanceVersion===1);
  const oldAssets=(surface?.assetRefs||[]).map(x=>x.assetId).filter(x=>x?.startsWith('dafeiyu-balance-'));
  if(surface?.light.customAssetId?.startsWith('dafeiyu-balance-'))oldAssets.push(surface.light.customAssetId);
  if(remove){
    if(!surface)return {changed:false,signature:signature()};
    if(surface){scene.surfaces=scene.surfaces.filter(x=>x.id!==surface.id);if(scene.activeSurfaceId===surface.id)scene.activeSurfaceId=scene.surfaces[0]?.id;}
  }else if(!visible){
    if(!surface||surface.enabled===false)return {changed:false,signature:signature()};
    surface.enabled=false;return {changed:true,signature:signature(),visible:false};
  }else{
    const keyboard=scene.devices.find(d=>/Ace\s*75/i.test(d.id));
    if(!keyboard||!s.connectedDeviceIds?.includes(keyboard.id))return {changed:false,signature:signature(),reason:'device-disconnected'};
    const layout=await m.c2(keyboard),strip=layout?.keys.filter(k=>k.isSideLight&&!k.isSideLight2);
    if(strip?.length!==28)throw Error('Expected the 28-segment Ace75 ambient strip');
    const left=Math.min(...strip.map(k=>k.x)),right=Math.max(...strip.map(k=>k.x+k.width)),top=Math.min(...strip.map(k=>k.y)),bottom=Math.max(...strip.map(k=>k.y+k.height));
    const oldActive=scene.activeSurfaceId,oldSelected=s.selectedObjectId;
    if(!surface){
      const id=s.createSurface('大肥鱼余额灯带');if(!id)throw Error('M HUB surface limit reached');
      surface=scene.surfaces.find(x=>x.id===id);surface.desktopBalanceVersion=1;
    }
    try{
      if(base64){
        const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));await m.b1(assetId,new File([bytes],'DeepSeek余额条.png',{type:'image/png'}));
        if(!s.addCustomAsset(surface.id,{id:assetId,kind:'image',name:'DeepSeek余额条',mime:'image/png',size:bytes.length,width:28,height:1,createdAt:Date.now()}))throw Error('M HUB rejected balance asset');
        surface.assetRefs=surface.assetRefs.filter(x=>x.assetId===assetId||!x.assetId?.startsWith('dafeiyu-balance-'));
      }
      const t=keyboard.transform,angle=(t.rotation||0)*Math.PI/180,scale=t.scale||1;
      const dx=((left+right)/2-.5)*t.width,dy=((top+bottom)/2-.5)*t.height;
      s.updateSurface(surface.id,{enabled:true,visible:true,viewportFit:false,zIndex:Math.max(...scene.surfaces.filter(x=>x!==surface).map(x=>x.zIndex||0),0)+1,
        transform:{x:t.x+(dx*Math.cos(angle)-dy*Math.sin(angle))*scale,y:t.y+(dx*Math.sin(angle)+dy*Math.cos(angle))*scale,width:t.width*(right-left),height:t.height*(bottom-top),rotation:t.rotation||0,scale},
        light:{...surface.light,source:'custom',sourcePanel:'custom',customAssetId:assetId||surface.light.customAssetId,customBrightness:brightness,customSaturation:100}});
      surface.interactive.enabled=false;
    }finally{scene.activeSurfaceId=oldActive;s.selectedObjectId=oldSelected;}
  }
  for(const id of new Set(oldAssets)){
    if(id===assetId&&!remove)continue;
    const referenced=s.scenes.some(sc=>sc.surfaces.some(x=>x.light?.customAssetId===id||x.assetRefs?.some(ref=>ref.assetId===id)));
    if(!referenced){s.removeCustomAsset(id);await m.b2(id);}
  }
  return {changed:true,signature:signature(),visible:!remove,segments:28,assetId:surface?.light.customAssetId};
}
export class BalanceBar {
  constructor({folder=root,evaluate=evaluateInMhub,fetchImpl=fetch,writeStatus=writeJson}={}){this.folder=folder;this.evaluate=evaluate;this.fetch=fetchImpl;this.writeStatus=writeStatus;this.ambient=new AmbientStrip({evaluate,backup:new URL('native-backup.json',folder)});this.settings={enabled:true,fullAmount:10,currency:'CNY',brightness:35};this.snapshot=null;this.lastAttempt=0;this.pending=null;this.lastKey=null;this.lastWrite=0;this.closed=false;this.lastSettings=0;this.controlVersion=null;}
  async init(){
    await this.reload();
  }
  async reload(){
    const file=new URL('settings.json',this.folder);
    try{const v=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));if(typeof v.enabled!=='boolean'||!Number.isFinite(v.fullAmount)||v.fullAmount<=0||!['CNY','USD'].includes(v.currency)||!Number.isInteger(v.brightness)||v.brightness<1||v.brightness>100||v.gt75Layout!==undefined&&!['continuous','mirrored'].includes(v.gt75Layout))throw Error('Invalid balance strip settings');
      const changed=JSON.stringify(v)!==JSON.stringify(this.settings);this.settings=v;this.controlVersion=v.controlVersion??null;if(changed)this.lastKey=null;this.settingsError=null;
    }catch(e){if(e.code!=='ENOENT'){this.settingsError=e.message;throw e;}await fs.mkdir(this.folder,{recursive:true});await fs.writeFile(file,JSON.stringify(this.settings,null,2));}
  }
  async poll(origin,{screenBalance=false}={}){
    if(Date.now()-this.lastSettings>400){this.lastSettings=Date.now();await this.reload().catch(()=>{});}
    const interval=this.failures?balanceRetryDelay(this.failures):accountBalance(this.snapshot,this.settings.currency)?60000:balanceRetryDelay(1);
    if(this.closed||(!this.settings.enabled&&!screenBalance)||this.pending||this.lastAttempt&&Date.now()-this.lastAttempt<interval)return;
    const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Balance source must be local Harness');
    const revision=this.refreshRevision;this.lastAttempt=Date.now();this.pending=(async()=>{
      try{const r=await this.fetch(new URL('/api/mhub-community/companion/balance',url),{redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('余额暂不可读取');const text=await r.text();if(text.length>32768)throw Error('余额数据无效');const snapshot=JSON.parse(text);if(this.closed||revision!==this.refreshRevision)return;this.snapshot=snapshot;
      if(snapshot.status==='ready'&&!snapshot.stale){this.failures=0;this.failureReason=null;this.error=null;}
      else{
       this.failures=(this.failures??0)+1;
       const fallback=balanceFailure(snapshot);
       this.failureReason=snapshot.reason??fallback.reason;this.error=snapshot.message??fallback.message;
      }}
      catch(e){if(!this.closed&&revision===this.refreshRevision){this.failures=(this.failures??0)+1;const failure=balanceFailure(e);this.failureReason=failure.reason;this.error=failure.message;const retained={...this.snapshot,stale:true,retained:true};if(accountBalance(retained,this.settings.currency))this.snapshot=retained;}}finally{this.pending=null;}
    })();
  }
  refresh({clearSource=false}={}){if(clearSource){this.snapshot=null;this.error=null;}this.refreshRevision=(this.refreshRevision??0)+1;this.failures=0;this.failureReason=null;this.lastAttempt=0;this.lastKey=null;}
  requestStandalone(){this.standaloneRequestedAt=Date.now();this.standaloneRequestId=randomUUID();this.standaloneRetryAt=0;}
  async ensureStandalone(allowed=true){
    if(!this.standaloneRequestedAt)return false;
    if(!this.settings.enabled||Date.now()-this.standaloneRequestedAt>30000){this.standaloneRequestedAt=null;return false;}
    if(!allowed||this.settingsError||!balanceView(this.snapshot,this.settings))return false;
    if(Date.now()<(this.standaloneRetryAt??0))return false;
    // Only an explicit balance enable may release M HUB's current scene.
    // A later manual master switch belongs to the driver.
    const requestId=this.standaloneRequestId;let result;
    try{result=await this.evaluate(async({models})=>{
      const m=await loadMhubModule(),s=m.c3();if(!s.masterEnabled)return {changed:false};
      const connected=new Set(s.connectedDeviceIds??[]),keys=[...window.ALL_CZ_STATE.deviceStateMap.keys()];
      const active=models.filter(spec=>connected.has(spec.id)&&keys.some(d=>d.vendorId===spec.vendorId&&d.productId===spec.productId));
      if(active.length!==1||!s.activeScene?.devices?.some(d=>d.id===active[0].id&&d.selected))return {changed:false};
      s.setMasterEnabled(false);return {changed:true};
    },{models:BALANCE_KEYBOARDS},3000);}catch(error){if(this.standaloneRequestId===requestId)this.standaloneRetryAt=Date.now()+1000;throw error;}
    if(this.standaloneRequestId===requestId)this.standaloneRequestedAt=null;
    if(result.changed){this.ambient.reassert();this.lastKey=null;this.syncClosedAt=Date.now();}
    return result.changed;
  }
  async syncAmbient(show=true,options={}){
    let view=balanceView(this.snapshot,this.settings);const actual=await this.ambient.sync(view,this.settings,show,options);
    const keyboard=actual?.available?{available:true,model:actual.model,segments:actual.segments}:{available:false,reason:actual?.reason??'connection-unavailable'};
    const spec=BALANCE_KEYBOARDS.find(s=>s.id===keyboard.model),layout=spec?balanceLayout(spec,this.settings.gt75Layout):null;
    if(view&&layout){const level=view.zeroAlert?8:Math.max(view.amount>0?1:0,Math.round(view.ratio*layout.segments*8));view={...view,level,litSegments:Math.ceil(level/8),segments:layout.segments};}
    else if(view){view={...view};delete view.level;delete view.litSegments;}
    if(actual?.manualChanged&&this.settings.enabled){
      const file=new URL('settings.json',this.folder),lock=new URL('settings.json.panel.lock',this.folder);let handle;
      try{
        handle=await fs.open(lock,'wx');const latest=JSON.parse(await fs.readFile(file,'utf8'));
        if(latest.enabled&&latest.controlVersion===this.controlVersion){const next={...latest,enabled:false,controlVersion:randomUUID()};await writeJson(file,next);this.settings=next;this.controlVersion=next.controlVersion;this.lastKey=null;}
      }catch(error){if(error.code!=='EEXIST')throw error;}
      finally{if(handle){await handle.close();await fs.rm(lock,{force:true});}}
    }
    const overridden=!!actual?.syncActive;
    const reason=overridden?'sync-takeover':actual?.manualChanged?'manual-change':!this.settings.enabled?'disabled':!show?'game-active':!view?'balance-unavailable':actual?.reason??null;
    const status={keyboard,layout,enabled:this.settings.enabled,visible:!!view&&show&&!!actual?.active&&this.settings.enabled&&!overridden&&actual.paletteReadback!=='repair-pending',fullAmount:this.settings.fullAmount,brightness:this.settings.brightness,currency:this.settings.currency,view,reason,error:this.settingsError||this.error||null,failureReason:this.failureReason??null,cacheWarning:this.snapshot?.cacheWarning??null,controlVersion:this.controlVersion,source:'independent-ambient',diagnostics:{paletteReadback:actual?.paletteReadback??null,emptyReads:actual?.emptyReads??0,nativeSideLease:!!options.nativeSideLease},constantSyncClosedAt:this.syncClosedAt??null,updatedAt:Date.now()};
    const statusKey=JSON.stringify({...status,updatedAt:undefined}),now=Date.now();
    if(statusKey!==this.lastAmbientStatusKey||now-(this.lastAmbientStatusWrite??0)>=1000){
      await this.writeStatus(new URL('status.json',this.folder),status);
      this.lastAmbientStatusKey=statusKey;this.lastAmbientStatusWrite=now;
    }
    return status;
  }
  async removeOverlay(expected,beforeWrite){if(Date.now()-(this.lastOverlayRemove??0)<1000)return {changed:false,throttled:true};this.lastOverlayRemove=Date.now();await beforeWrite?.();return this.evaluate(renderer,{expected,remove:true});}
  async sync(expected,show,{writeStatus=true,beforeWrite}={}){
    const view=balanceView(this.snapshot,this.settings),visible=this.settings.enabled&&show&&!!view;
    const key=(visible?`${view.level}:${view.color}:${this.settings.brightness}`:'hidden')+':'+this.controlVersion;
    if(key===this.lastKey&&expected===this.lastExpected&&Date.now()-this.lastWrite<30000)return null;
    const assetId=visible?'dafeiyu-balance-'+randomUUID():undefined;
    await beforeWrite?.();
    const result=await this.evaluate(renderer,{expected,visible,assetId,base64:visible?barPng(view).toString('base64'):undefined,brightness:this.settings.brightness});
    if(!result.reason){this.lastKey=key;this.lastExpected=result.signature;this.lastWrite=Date.now();}
    const reason=result.reason||(!this.settings.enabled?'disabled':!show?'game-active':!view?'balance-unavailable':null);
    const status={enabled:this.settings.enabled,visible:visible&&!result.reason,fullAmount:this.settings.fullAmount,brightness:this.settings.brightness,currency:this.settings.currency,view,reason,error:this.settingsError||this.error||null,failureReason:this.failureReason??null,cacheWarning:this.snapshot?.cacheWarning??null,controlVersion:this.controlVersion,updatedAt:Date.now()};
    // Hardware has already changed. A locked status file must never hide the
    // returned signature and make our own successful write look like a user edit.
    try{if(writeStatus)await this.writeStatus(new URL('status.json',this.folder),status);this.statusError=null;}
    catch(error){this.statusError=error.message;this.lastKey=null;}
    return result;
  }
  async close(expected){this.closed=true;return this.evaluate(renderer,{expected,remove:true});}
}
