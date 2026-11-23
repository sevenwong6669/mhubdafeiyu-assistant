// Restricted subset of M HUB's Nordic mouse protocol, verified against its bundled source.
// Only configuration/key reads, two selected macro records, side keys and profile name.
export async function mouseWire({action,profile=2,macros=[],backup=null}){
  const prior=window.__dafeiyuMouseWireQueue||Promise.resolve();let unlock;
  window.__dafeiyuMouseWireQueue=new Promise(resolve=>{unlock=resolve;});
  await prior.catch(()=>{});
  try{
  // Resolve the authorized configuration interface independently of the device
  // page M HUB is displaying. The receiver also exposes mouse and keyboard HID.
  const receivers=(await navigator.hid.getDevices()).filter(device=>
    device.productName==='MCHOSE A7 V3 Ultra+'&&device.vendorId===14391&&[4116,4120].includes(device.productId)&&
    device.collections.some(collection=>collection.usagePage===0xff01&&collection.usage===1&&
      collection.inputReports.some(report=>report.reportId===77)&&collection.outputReports.some(report=>report.reportId===77)));
  if(receivers.length!==1)throw Error(receivers.length?'检测到多个 A7 V3 Ultra+ 配置接口，无法安全选择':'等待 A7 V3 Ultra+ 鼠标配置接口连接');
  const [d]=receivers;
  if(!d.opened)await d.open();
  const allowed=new Set([0x0001,0x0002,0x0003,0x0905,0x090c,0x090b,0x0101,0x0910]);
  async function request(command,data=[],length=64){
    if(!allowed.has(command)||data.length>length-9)throw Error('Unsupported protocol request');
    const packet=new Uint8Array(length);packet.set([77,1,1,data.length,command&255,command>>8,0,0]);packet.set(data,8);
    let xor=0;for(let i=2;i<=7+data.length;i++)xor^=packet[i];packet[8+data.length]=xor;
    let handler,timer;
    const response=new Promise((resolve,reject)=>{
      handler=event=>{if(event.reportId!==77)return;const a=Array.from(new Uint8Array(event.data.buffer,event.data.byteOffset,event.data.byteLength));if((a[3]|a[4]<<8)!==command)return;resolve(a.slice(7));};
      d.addEventListener('inputreport',handler);timer=setTimeout(()=>reject(Error('Mouse command timeout: '+command.toString(16))),2500);
    });
    try{const [result]=await Promise.all([response,d.sendReport(77,packet.slice(1))]);return result;}
    finally{clearTimeout(timer);d.removeEventListener('inputreport',handler);}
  }
  async function keys(index){const a=await request(0x0001,[index,0,6]);if(a[0]===255)throw Error('Mouse asleep or configuration unavailable');let offset=0;const result=[];
    for(let i=0;i<6;i++){const type=a[offset];if(type===255){result.push({type,bytes:[]});continue;}const size=[1,34].includes(type)?4:[35,36].includes(type)?8:3;result.push({type,bytes:a.slice(offset,offset+size)});offset+=size;}return result;}
  async function name(index){let a=[];for(let at=0;at<60;at+=23){const count=Math.min(23,60-at);a.push(...(await request(0x0905,[index,at,count],32)).slice(0,count));}return {raw:a,text:new TextDecoder().decode(new Uint8Array(a)).replace(/\0+$/,'')};}
  async function macroBytes(id,size){let a=[];for(let at=0;at<size;at+=22){const count=Math.min(22,size-at),r=await request(0x090c,[id,at&255,at>>8,count],32);a.push(...r.slice(1,1+count));}return a;}
  async function readMacro(id){const header=await macroBytes(id,64),eventBytes=header[0]|header[1]<<8;const valid=eventBytes<=4032&&eventBytes%4===0&&header[4]<=3;const size=valid?Math.max(108,64+eventBytes):108;return {id,valid,size,bytes:await macroBytes(id,size)};}
  async function writeMacro(id,bytes){if(![7,8,9].includes(id)||bytes.length>4096)throw Error('Unexpected macro record');for(let at=0;at<bytes.length;at+=19){const chunk=bytes.slice(at,at+19),flag=at===0?1:at+19>=bytes.length?2:0;await request(0x090b,[id,at&255,at>>8,(chunk.length<<2)|flag,...chunk],32);}}
  async function writeName(index,bytes){for(let at=0;at<bytes.length;at+=20){const part=bytes.slice(at,at+20),control=(part.length<<2)|(at===0?1:0)|(at+part.length===bytes.length?2:0);await request(0x0910,[index,at,control,...part]);}}
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const dedicatedName='大肥鱼专属板载';
  if(profile!==2)throw Error('Only the explicitly selected editing slot is supported');
  if(action==='probe')return {device:d.productName,keys:await keys(profile),performance:await request(0x0002)};
  if(action==='probe-profile')return {device:d.productName,keys:await keys(profile),performance:await request(0x0002),name:(await name(profile)).text};
  if(['snapshot-dedicated','install-dedicated','restore-dedicated'].includes(action)){
    // Current M HUB uses Number() on the displayed hexadecimal macro ID.
    // Keep writes to digit-only IDs so the native key labels resolve.
    const dedicatedIds=[8,9,7];
    const dedicatedKeys=[[33,7,0],[33,8,0],[33,9,0]];
    if(!same(macros.map(m=>m.id),dedicatedIds)||!macros.every(m=>Array.isArray(m.bytes)&&m.bytes.length>=68&&m.bytes.length<=512))throw Error('Invalid dedicated macro payloads');
    async function snapshot(){
      const configurations=[];
      for(let i=0;i<3;i++)configurations.push({index:i,keys:await keys(i),name:await name(i)});
      const records=[];
      for(const {id,bytes} of macros){const record=await readMacro(id);records.push({id,valid:record.valid,bytes:await macroBytes(id,Math.max(record.size,bytes.length))});}
      return {device:d.productName,configurations,records,performance:await request(0x0002),dpi:await request(0x0003,[profile,0])};
    }
    const before=await snapshot();
    if(action==='snapshot-dedicated')return before;
    const validBackup=backup?.device===d.productName&&same(backup.records?.map(m=>m.id),dedicatedIds)&&backup.configurations?.[profile]?.index===profile;
    if(!validBackup)throw Error('A complete matching backup is required');
    const original=backup.configurations[profile];
    const restore=async()=>{
      await request(0x0101,[profile,2,(3<<3)|3,...original.keys.slice(2,5).flatMap(k=>k.bytes)]);
      await writeName(profile,original.name.raw);
      for(const m of backup.records)await writeMacro(m.id,m.bytes);
    };
    if(action==='restore-dedicated'){
      if(before.configurations[profile].name.text!==dedicatedName)throw Error('Dedicated profile is no longer installed');
      await restore();
      const after=await snapshot();
      if(!same(after.configurations,backup.configurations)||!same(after.records,backup.records))throw Error('Mouse restore readback failed');
      return after;
    }
    if(!same(before,backup)||original.keys.slice(2,5).some(k=>k.bytes.length!==3))throw Error('Mouse state changed since backup');
    if(before.records.some(r=>r.valid)||before.configurations.some(c=>c.keys.some(k=>k.type===33&&dedicatedIds.includes(k.bytes[1]))))throw Error('A dedicated macro slot is already occupied');
    try{
      for(const m of macros){await writeMacro(m.id,m.bytes);if(!same(await macroBytes(m.id,m.bytes.length),m.bytes))throw Error('Macro write readback failed: '+m.id);}
      await request(0x0101,[profile,2,(3<<3)|3,...dedicatedKeys.flat()]);
      const label=Array.from(new TextEncoder().encode(dedicatedName));
      await writeName(profile,[...label,...Array(60-label.length).fill(0)]);
      const after=await snapshot();
      const expectedKeys=original.keys.map((key,i)=>i>=2&&i<=4?{type:33,bytes:dedicatedKeys[i-2]}:key);
      if(after.configurations[profile].name.text!==dedicatedName||!same(after.configurations[profile].keys,expectedKeys)||
        !same(after.configurations.slice(0,2),backup.configurations.slice(0,2))||!same(after.dpi,backup.dpi)||!same(after.performance,backup.performance))throw Error('Dedicated profile readback failed');
      return after;
    }catch(error){
      try{await restore();}catch(rollback){throw Error(error.message+'; hardware rollback failed: '+rollback.message);}
      throw error;
    }
  }
  if(action==='repair-dedicated-ptt'){
    // Explicit user-requested repair only. The automatic binding check must
    // continue to preserve arbitrary user edits, including other shortcuts.
    if((await name(profile)).text!==dedicatedName)throw Error('鼠标板载已变化，未覆盖');
    const configurations=[];for(let i=0;i<3;i++)configurations.push({index:i,keys:await keys(i),name:await name(i)});
    const performance=await request(0x0002),dpi=await request(0x0003,[profile,0]);
    const current=configurations[profile].keys,rear=current[4].bytes;
    if(performance[0]!==profile||backup?.device!==d.productName||!same(backup.configurations,configurations)
      ||!same(backup.performance,performance)||!same(backup.dpi,dpi))throw Error('鼠标状态已变化，请重新检查');
    if(!same(rear,[19,7,30]))throw Error('后侧键不是已确认的语音组合键，未覆盖');
    try{
      await request(0x0101,[profile,4,(1<<3)|3,0,8,0]);
      const after=await keys(profile);
      if(!same(after[4].bytes,[0,8,0])||!same(after.filter((_,i)=>i!==4),current.filter((_,i)=>i!==4)))throw Error('后侧键修复读回失败');
      for(const i of [0,1])if(!same(await keys(i),configurations[i].keys))throw Error('其他板载发生变化');
      if(!same(await request(0x0002),performance)||!same(await request(0x0003,[profile,0]),dpi))throw Error('鼠标性能或 DPI 发生变化');
      return {repaired:true,rear:[0,8,0],otherKeysUnchanged:true,otherProfilesUnchanged:true,performanceUnchanged:true,dpiUnchanged:true};
    }catch(error){
      await request(0x0101,[profile,4,(1<<3)|3,...rear]);
      if(!same((await keys(profile))[4].bytes,rear))throw Error(error.message+'；后侧键回滚未确认');
      throw error;
    }
  }
  if(action==='inspect'||action==='snapshot-keys'){
    const configurations=[];for(let i=0;i<3;i++)configurations.push({index:i,keys:await keys(i),name:await name(i)});
    const performance=await request(0x0002),dpi=await request(0x0003,[profile,0]);
    return {device:d.productName,configurations,performance,dpi,macros:action==='inspect'?[await readMacro(8),await readMacro(9)]:[]};
  }
  if(['dedicated-ptt-snapshot','dedicated-ptt-install','dedicated-ptt-restore'].includes(action)){
    if((await name(profile)).text!==dedicatedName)throw Error('鼠标已切换为其他板载，未覆盖');
    const configurations=[];for(let i=0;i<3;i++)configurations.push({index:i,keys:await keys(i)});
    const performance=await request(0x0002),dpi=await request(0x0003,[profile,0]);
    const current=configurations[profile].keys,ordinary=[0,8,0],macro=[33,9,0],broken=[33,0,0];
    if(action==='dedicated-ptt-snapshot'){
      if(performance[0]!==profile)throw Error('请先切换到大肥鱼专属板载');
      if(![ordinary,macro,broken].some(k=>same(current[4].bytes,k)))throw Error('后侧键已手动更改，未覆盖');
      const record=await readMacro(9),label=new TextDecoder().decode(new Uint8Array(record.bytes.slice(8,64))).replace(/\0.*$/s,'');
      const repair=same(current[4].bytes,broken)&&record.valid&&label.startsWith('大肥鱼')&&label.includes('摸头');
      return {device:d.productName,configurations,performance,dpi,dedicated:true,restoreRear:repair?macro:current[4].bytes,repairInvalidMacro:repair};
    }
    if(!backup?.dedicated||backup.device!==d.productName||backup.configurations?.[profile]?.index!==profile)throw Error('缺少专属板载按键备份');
    const restore=backup.restoreRear;
    if(!Array.isArray(restore)||restore.length!==3||![ordinary,macro,broken].some(k=>same(restore,k)))throw Error('后侧键恢复资料无效');
    if(![ordinary,macro,broken,restore].some(k=>same(current[4].bytes,k)))throw Error('后侧键已手动更改，未覆盖');
    if(action==='dedicated-ptt-install'&&performance[0]!==profile)throw Error('请先切换到大肥鱼专属板载');
    const wanted=action==='dedicated-ptt-install'?ordinary:restore;
    const changed=!same(current[4].bytes,wanted);
    if(changed)await request(0x0101,[profile,4,(1<<3)|3,...wanted]);
    const after=await keys(profile);
    if(!same(after[4].bytes,wanted)||!same(after.filter((_,i)=>i!==4),current.filter((_,i)=>i!==4)))throw Error('后侧键写入校验失败');
    for(const i of [0,1])if(!same(await keys(i),configurations[i].keys))throw Error('其他板载被意外修改');
    if(!same(await request(0x0002),performance)||!same(await request(0x0003,[profile,0]),dpi))throw Error('鼠标性能参数被意外修改');
    return {action,changed,keys:after,dedicated:true,restoredRear:wanted,performanceUnchanged:true,dpiUnchanged:true,otherProfilesUnchanged:true};
  }
  if(!backup||backup.device!==d.productName||backup.configurations[2].index!==2)throw Error('A complete matching backup is required');
  const current=await keys(profile),original=backup.configurations[2].keys;
  if(['ptt-install','ptt-ime','ptt-restore'].includes(action)){
    // M HUB mouseKeyToArr encodes modifier+HID key type 0x13 in this order.
    // Alt (modifier bit 4) + F13 (HID usage 104) is a held physical chord.
    const wanted=action==='ptt-install'?[0,8,0]:action==='ptt-ime'?[19,4,104]:original[4].bytes;
    if(!same(current.filter((_,i)=>i!==4),original.filter((_,i)=>i!==4)))throw Error('Other mouse keys changed; refusing to overwrite');
    if(![original[4].bytes,[0,8,0],[19,4,104]].some(value=>same(current[4].bytes,value)))throw Error('Rear button changed outside voice control');
    if(!same(current[4].bytes,wanted))await request(0x0101,[profile,4,(1<<3)|3,...wanted]);
    const after=await keys(profile);
    if(!same(after[4].bytes,wanted))throw Error('PTT rear button readback differs');
    if(!same(await request(0x0002),backup.performance)||!same(await request(0x0003,[profile,0]),backup.dpi))throw Error('Mouse performance changed');
    for(const i of [0,1])if(!same(await keys(i),backup.configurations[i].keys))throw Error('Other mouse profile changed');
    return {action,keys:after,performanceUnchanged:true,dpiUnchanged:true,otherProfilesUnchanged:true};
  }
  if(action==='install'){
    if(!same(current,original))throw Error('Mouse keys changed since backup');
    if(macros.length!==2||!macros.every(m=>[8,9].includes(m.id)&&Array.isArray(m.bytes)&&m.bytes.length===108))throw Error('Unexpected macro payload');
    for(const m of macros){await writeMacro(m.id,m.bytes);if(!same(await macroBytes(m.id,m.bytes.length),m.bytes))throw Error('Macro write verification failed');}
    // Change only forward/back; leave left/right/middle/DPI and all performance data intact.
    await request(0x0101,[profile,3,(2<<3)|3,0x21,8,0,0x21,9,0]);
    const label=Array.from(new TextEncoder().encode('大肥鱼桌面陪伴'));await writeName(profile,label);
    const after=await keys(profile),title=await name(profile),perf=await request(0x0002),dpi=await request(0x0003,[profile,0]);
    for(const i of [0,1,2,5])if(!same(after[i],original[i]))throw Error('Unexpected non-side-key change');
    if(!same(after[3].bytes,[0x21,8,0])||!same(after[4].bytes,[0x21,9,0])||title.text!=='大肥鱼桌面陪伴')throw Error('Side-key/name verification failed');
    if(!same(perf,backup.performance)||!same(dpi,backup.dpi))throw Error('Performance/DPI changed unexpectedly');
    for(const i of [0,1])if(!same(await keys(i),backup.configurations[i].keys))throw Error('Another profile changed');
    return {installed:true,keys:after,name:title,performanceUnchanged:true,dpiUnchanged:true,otherProfilesUnchanged:true,macroIds:[8,9]};
  }
  if(action==='restore'){
    const side=[...original[3].bytes,...original[4].bytes];if(side.length!==6)throw Error('Unexpected original side keys');
    await request(0x0101,[profile,3,(2<<3)|3,...side]);
    await writeName(profile,backup.configurations[2].name.raw);
    for(const m of backup.macros)if(m.valid)await writeMacro(m.id,m.bytes);
    if(!same(await keys(profile),original)||(await name(profile)).text!==backup.configurations[2].name.text)throw Error('Restore verification failed');
    return {restored:true,keysAndNameRestored:true,unusedCompanionMacrosRetained:backup.macros.filter(m=>!m.valid).map(m=>m.id)};
  }
  throw Error('Unknown mouse operation');
  }finally{unlock();}
}
