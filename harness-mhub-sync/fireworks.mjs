import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
const root=new URL('fireworks/',import.meta.url),journal=new URL('active.json',root);

// A single native M HUB media clock drives every selected device.
async function renderer({action,expected,token,assetId,base64}){
  const m=await loadMhubModule(),s=m.c3(),clone=x=>JSON.parse(JSON.stringify(x));
  const signature=()=>JSON.stringify({master:s.masterEnabled,id:s.activeSceneId,
    lights:s.activeScene?.surfaces.map(x=>({id:x.id,enabled:x.enabled,light:x.light})),
    devices:s.activeScene?.devices.map(x=>({id:x.id,selected:x.selected}))});
  if(action==='prepare'){
    if(signature()!==expected)throw Error('Fireworks ownership changed');
    if(s.activeScene?.desktopCompanionVersion!==1)throw Error('Fireworks require the companion scene');
    const devices=s.activeScene.devices.filter(d=>/(K20\s*GT|Ace\s*75|GT\s*75|MagDock)/i.test([d.id,d.deviceName,d.productName].join(' ')));
    if(devices.length<3)throw Error('The three desktop devices are not available');
    return {before:{scene:clone(s.activeScene),master:s.masterEnabled},assetId,expected};
  }
  if(action==='start'){
    if(signature()!==expected)throw Error('Fireworks ownership changed');
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    await m.b1(assetId,new File([bytes],'大肥鱼通关烟花.gif',{type:'image/gif'}));
    if(signature()!==expected){await m.b2(assetId);throw Error('Fireworks ownership changed');}
    const scene=s.activeScene,surface=s.activeSurface;
    const devices=scene.devices.filter(d=>/(K20\s*GT|Ace\s*75|GT\s*75|MagDock)/i.test([d.id,d.deviceName,d.productName].join(' ')));
    const corners=[];
    for(const d of devices){
      const t=d.transform,a=(t.rotation||0)*Math.PI/180,k=t.scale||1;
      for(const x of [-t.width/2,t.width/2])for(const y of [-t.height/2,t.height/2])
        corners.push([t.x+k*(x*Math.cos(a)-y*Math.sin(a)),t.y+k*(x*Math.sin(a)+y*Math.cos(a))]);
    }
    const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
    const left=Math.min(...xs)-12,right=Math.max(...xs)+12,top=Math.min(...ys)-12,bottom=Math.max(...ys)+12;
    for(const d of scene.devices)s.setDeviceSelected(d.id,devices.includes(d));
    s.addCustomAsset(surface.id,{id:assetId,kind:'gif',name:'大肥鱼通关烟花',mime:'image/gif',size:bytes.length,width:288,height:152,createdAt:Date.now()});
    for(const layer of scene.surfaces)layer.enabled=layer.id===surface.id;
    s.updateSurface(surface.id,{enabled:true,visible:true,viewportFit:false,
      transform:{x:(left+right)/2,y:(top+bottom)/2,width:right-left,height:bottom-top,rotation:0,scale:1},
      light:{...surface.light,source:'custom',sourcePanel:'custom',customAssetId:assetId,customBrightness:115,customSaturation:115}});
    surface.interactive.enabled=false;s.setMasterEnabled(true);
    const deadline=Date.now()+2000;
    while(!m.cb().customMediaPreviews?.[surface.id]&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    return {signature:signature(),assetId,durationMs:10000,devices:devices.map(d=>({id:d.id,name:d.deviceName||d.productName})),mediaReady:!!m.cb().customMediaPreviews?.[surface.id]};
  }
  if(action==='stop'){
    let restored=false;
    if(signature()===expected){
      const index=s.scenes.findIndex(x=>x.id===token.before.scene.id);
      if(index>=0){s.scenes[index]=clone(token.before.scene);s.selectScene(token.before.scene.id);s.setMasterEnabled(token.before.master);restored=true;}
    }
    const referenced=s.scenes.some(scene=>scene.surfaces.some(x=>x.light?.customAssetId===token.assetId||x.assetRefs?.includes(token.assetId)));
    if(!referenced){
      // removeCustomAsset only touches its catalog after confirming no scene references it.
      s.removeCustomAsset(token.assetId);await m.b2(token.assetId);
    }
    return {restored,signature:signature(),referenced};
  }
  throw Error('Unknown fireworks operation');
}
export class Fireworks {
  constructor(){this.token=null;}
  get active(){return this.token!==null;}
  async recover(){
    let token;try{token=JSON.parse(await fs.readFile(journal,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!token.assetId?.startsWith('dafeiyu-fireworks-')||token.before?.scene?.desktopCompanionVersion!==1)throw Error('Invalid fireworks recovery record');
    this.token=token;return this.stop(token.runningSignature||token.expected);
  }
  async start(expected){
    if(this.active)throw Error('Fireworks already active');
    const assetId='dafeiyu-fireworks-'+randomUUID();
    this.token=await evaluateInMhub(renderer,{action:'prepare',expected,assetId});
    await fs.writeFile(journal,JSON.stringify(this.token));
    try{
      const base64=(await fs.readFile(new URL('victory-fireworks.gif',root))).toString('base64');
      const result=await evaluateInMhub(renderer,{action:'start',expected,assetId,base64},15000);
      this.token.runningSignature=result.signature;await fs.writeFile(journal,JSON.stringify(this.token));
      if(!result.mediaReady)throw Error('M HUB could not decode fireworks media');
      return result;
    }catch(error){await this.stop(this.token.runningSignature||expected).catch(()=>{});throw error;}
  }
  async stop(expected){
    if(!this.token)return null;
    const result=await evaluateInMhub(renderer,{action:'stop',expected,token:this.token});
    this.token=null;await fs.rm(journal,{force:true});return result;
  }
}
