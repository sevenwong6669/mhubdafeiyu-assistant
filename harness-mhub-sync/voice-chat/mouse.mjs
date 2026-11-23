import fs from 'node:fs/promises';
import {evaluateInMhub} from '../../mhub_runtime_access.mjs';
import {mouseWire} from '../mouse-macros/nordic-protocol.mjs';
import {withMouseBindingLock,processAlive} from './mouse-binding-lock.mjs';
const root=new URL('./',import.meta.url),backupFile=new URL('mouse-before-ptt.json',root);
const dedicatedBackupFile=new URL('mouse-before-dedicated-ptt.json',root);
export function mouseMode(enabled,inputMode='native',options={}){
  return withMouseBindingLock(new URL('mouse-binding.lock',root),async()=>{
    if(options.ifVoiceInactive){
      if(enabled)throw Error('Invalid mouse recovery mode');
      for(const file of ['server.pid','mouse-mode.json']){
        let value;try{value=JSON.parse(await fs.readFile(new URL(file,root),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(processAlive(file==='server.pid'?value:value?.ownerPid))return {changed:false,reason:'voice-running'};
      }
      try{const response=await fetch('http://127.0.0.1:18780/status',{signal:AbortSignal.timeout(800)});if(response.ok)return {changed:false,reason:'voice-running'};}catch{}
    }
    return changeMouseMode(enabled,inputMode);
  });
}
async function changeMouseMode(enabled,inputMode){
  let backup;try{backup=JSON.parse(await fs.readFile(backupFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let dedicated;try{dedicated=JSON.parse(await fs.readFile(dedicatedBackupFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!enabled&&!backup&&!dedicated)return {changed:false};
  // Board readback is authoritative; M HUB's cached profile can be stale while asleep.
  const probe=await evaluateInMhub(mouseWire,{action:'probe-profile',profile:2});
  if(probe.keys.every(x=>x.type===255)||probe.performance[0]===255)throw Error('等待 A7 V3 Ultra+ 鼠标唤醒并返回配置');
  // A one-shot F-key macro has no physical release edge. The dedicated board
  // therefore uses XBUTTON1 while voice is running; short taps still reach pet.
  if(probe.name==='大肥鱼专属板载'){
    if(!enabled&&!dedicated)return {changed:false};
    if(enabled&&inputMode!=='native')throw Error('专属板载的长按语音需要本地按键监听');
    if(!dedicated){
      dedicated=await evaluateInMhub(mouseWire,{action:'dedicated-ptt-snapshot',profile:2},25000);
      await fs.writeFile(dedicatedBackupFile,JSON.stringify(dedicated,null,2),{flag:'wx'});
    }
    const result=await evaluateInMhub(mouseWire,{action:enabled?'dedicated-ptt-install':'dedicated-ptt-restore',profile:2,backup:dedicated},25000);
    const bytes=result.restoredRear;
    await evaluateInMhub(async({bytes})=>{
      const data=JSON.parse(localStorage.getItem('mouse')||'{}'),p=data['MCHOSE A7 V3 Ultra+']?.templateList?.[2];
      if(p){p.retreatKeyType=bytes[0].toString(16).padStart(2,'0');p.retreatKeyVal=(bytes[1]|bytes[2]<<8).toString(16).padStart(4,'0');localStorage.setItem('mouse',JSON.stringify(data));}
      return {updated:!!p};
    },{bytes});
    await fs.writeFile(new URL('mouse-mode.json',root),JSON.stringify({...result,enabled,ownerPid:enabled?process.pid:null,inputMode:enabled?'native':'macro',at:Date.now()},null,2));
    return result;
  }
  if(probe.performance[0]!==2)throw Error('请切换鼠标到第三个“大肥鱼桌面陪伴”配置');
  if(enabled&&!backup){
    backup=await evaluateInMhub(mouseWire,{action:'snapshot-keys',profile:2},55000);
    if(JSON.stringify(backup.configurations[2].keys[4].bytes)!==JSON.stringify([33,9,0]))throw Error('后侧键已不是原来的摸摸宏，未覆盖');
    await fs.writeFile(backupFile,JSON.stringify(backup,null,2),{flag:'wx'});
  }
  if(!backup)return {changed:false};
  const ime=enabled&&inputMode==='doubao-ime';
  const result=await evaluateInMhub(mouseWire,{action:enabled?(ime?'ptt-ime':'ptt-install'):'ptt-restore',profile:2,backup},25000);
  await evaluateInMhub(async({enabled,ime})=>{
    const key='MCHOSE A7 V3 Ultra+',s=JSON.parse(localStorage.getItem('mouse')||'{}');
    if(s[key]?.templateList?.[2]){s[key].templateList[2].retreatKeyType=enabled?(ime?'13':'00'):'21';s[key].templateList[2].retreatKeyVal=enabled?(ime?'0468':'0008'):'0009';localStorage.setItem('mouse',JSON.stringify(s));}
    return {enabled};
  },{enabled,ime});
  await fs.writeFile(new URL('mouse-mode.json',root),JSON.stringify({...result,enabled,ownerPid:enabled?process.pid:null,inputMode:enabled?inputMode:'macro',at:Date.now()},null,2));return result;
}
if(process.argv[1]&&new URL('file:///'+process.argv[1].replaceAll('\\','/')).href===import.meta.url)console.log(JSON.stringify(await mouseMode(process.argv[2]!=='restore')));
