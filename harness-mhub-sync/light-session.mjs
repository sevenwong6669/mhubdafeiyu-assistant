import fs from 'node:fs/promises';
import {mhub} from '../dafeiyu-mhub-bridge/mhub.mjs';
import {deviceLighting,magdockState} from './native-light-state.mjs';
import {writeJson} from './resilience.mjs';
const file=new URL('lighting-session.json',import.meta.url),dock='MCHOSE MagDock$$$14391$$$4114';
export const taskNeedsLighting=raw=>['THINKING','WORKING','BUSY','WAITING','ERROR','DISCONNECTED','ATTENTION'].includes(raw);
export class LightSession{
 constructor({capture=()=>mhub('capture'),restore=p=>mhub('restore',p),devices=deviceLighting,magdock=magdockState,persist=v=>writeJson(file,v),load=async()=>JSON.parse(await fs.readFile(file,'utf8'))}={}){this.capture=capture;this.restore=restore;this.devices=devices;this.magdock=magdock;this.persist=persist;this.load=load;this.active=false;this.saved=null;this.lastResult=null;}
 async begin(deviceIds){
  if(this.active){
   const added=(deviceIds??[]).filter(id=>!this.saved.ids.includes(id));if(!added.length)return;
   const native=await this.devices('capture',{ids:added});
   const magdock=added.includes(dock)?await this.magdock('capture'):this.saved.magdock;
    this.requireBackup(added,native,magdock);
   const next={...this.saved,ids:[...this.saved.ids,...added],native:{...this.saved.native,...native},magdock};
   await this.persist({active:true,saved:next});this.saved=next;return;
  }
  const scene=await this.capture(),ids=deviceIds??scene.snapshot.scene.devices.filter(x=>x.selected).map(x=>x.id);
  const native=await this.devices('capture',{ids}),magdock=ids.includes(dock)?await this.magdock('capture'):null;
   this.requireBackup(ids,native,magdock);
   this.saved={scene:scene.snapshot,ids,native,magdock,baselineSignature:scene.signature,lastApplied:scene.signature,at:Date.now()};
  await this.persist({active:true,saved:this.saved});this.active=true;
 }
 requireBackup(ids,native,magdock){
  const missing=ids.filter(id=>!(id===dock?magdock:native[id==='Ace 75 8K'?'keyboard':id]));
  if(missing.length)throw Error('未接管：无法备份原灯效 '+missing.join('、'));
 }
 async markApplied(signature){
  if(!this.active)return;
  const next={...this.saved,lastApplied:signature,sceneRestored:false,sceneRestorePending:false,writePending:false,deviceRestores:{}};
  this.saved=next;
  await this.persist({active:true,saved:next});
 }
 async beforeWrite(){
  if(!this.active)return;
  if(this.saved.writePending&&(await this.capture()).signature!==this.saved.lastApplied){
   throw Error('上一次灯效写入结果未确认，已保留恢复记录');
  }
  const next={...this.saved,writePending:true};
  await this.persist({active:true,saved:next});
  this.saved=next;
 }
 async cancelWrite(){
  if(!this.active||!this.saved.writePending)return;
  const next={...this.saved,writePending:false};
  await this.persist({active:true,saved:next});
  this.saved=next;
 }
 async end({preserve=[],restoreScene=true}={}){
  if(!this.active)return null;
  const saved=this.saved,current=await this.capture();
   const alreadyRestored=saved.sceneRestorePending&&current.signature===saved.baselineSignature;
   if(restoreScene&&saved.writePending&&current.signature!==saved.lastApplied){
    throw Error('灯效写入结果未确认，已保留恢复记录');
   }
   if(restoreScene&&!alreadyRestored&&current.signature!==saved.lastApplied){
    restoreScene=false;
    preserve=[...new Set([...preserve,...saved.ids])];
   }
   if(restoreScene&&!saved.sceneRestored){
    if(!alreadyRestored){
     saved.sceneRestorePending=true;
     await this.persist({active:true,saved});
    }
    const result=alreadyRestored?{restored:true,signature:current.signature}:await this.restore({expected:saved.lastApplied,snapshot:saved.scene});
    if(!result.restored)throw Error('原灯效场景未恢复，稍后自动重试');
    saved.lastApplied=result.signature??(await this.capture()).signature;
    saved.sceneRestored=true;
    saved.sceneRestorePending=false;
    await this.persist({active:true,saved});
   }
  const restored={...saved.deviceRestores},errors=[];
  for(const id of saved.ids){
   const key=id===dock?'magdock':id==='Ace 75 8K'?'keyboard':id;
   if(Object.hasOwn(restored,key))continue;
   try{
    await this.devices('release',{ids:[id],preserve});
    if(preserve.includes(id))continue;
    const result=id===dock?await this.magdock('restore',saved.magdock):
      (await this.devices('restore',{ids:[id],saved:{[key]:saved.native[key]},preserve}))[key];
    if(!result||id!==dock&&result.restored!==true)throw Error('设备灯效恢复尚未确认：'+id);
    restored[key]=result;if(result.preserved&&!preserve.includes(id))preserve.push(id);
    saved.deviceRestores={...restored};
    await this.persist({active:true,saved});
   }catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors,errors.map(error=>error.message).join('；'));
  const after=await this.capture();this.lastResult={at:Date.now(),restored,preserved:preserve,signature:after.signature};
  await this.persist({active:false,saved,lastResult:this.lastResult});this.active=false;return this.lastResult;
 }
 async recover(){try{const old=await this.load();if(old.active&&old.saved){this.saved=old.saved;this.active=true;return await this.end();}}catch(error){if(error.code!=='ENOENT')throw error;}}
}
