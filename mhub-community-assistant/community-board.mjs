import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {evaluateInMhub} from '../mhub_runtime_access.mjs?v=mhub-renderer-prod';
import {normalizeDevice,normalizeShare} from './community.mjs';
import {requireDeviceLink,withDeviceWrite} from '../harness-mhub-sync/device-link-mode.mjs';

// Only explicit hardware identities may use the intercepted vendor import plan.
export async function boardOperation({operation,slot,source,title,transaction,deviceSpec={vendorId:14391,productId:12333,productKey:"GT 75$$$14391$$$12333"}}){
  if(deviceSpec.vendorId!==14391||![[12333,'GT 75$$$14391$$$12333'],[12348,'Ace 75$$$14391$$$12348']].some(([pid,key])=>deviceSpec.productId===pid&&deviceSpec.productKey===key))throw Error('未适配的板载型号。');
  const cz=window.ALL_CZ_STATE;
  const devices=[...cz.deviceStateMap.keys()].filter(d=>d.vendorId===deviceSpec.vendorId&&d.productId===deviceSpec.productId&&d.productKey===deviceSpec.productKey);
  if(devices.length!==1)throw Error('目标键盘未连接或连接不唯一。');
  const {sdk}=await cz.getDeviceState(devices[0]);
  const pairs={
    setUserKeys:a=>['getKeyInfos',[a[1],a[2]],0],
    setAllKeysColor:a=>['getKeyCustomLight',[a[0]],1],
    setCustomParam:a=>['getCustomParam',[a[0]],1],
    setLightValueStruct:a=>['getLightValueStruct',[a[0]],1],
    setSelectedLightEffect:a=>['getSelectedLightEffect',[a[0]],1],
    setSideSelectedLightEffect:a=>['getSideSelectedLightEffect',[a[0]],1],
    setSide2SelectedLightEffect:a=>['getSide2SelectedLightEffect',[a[0]],1],
    setRtMilliDigitStruct:a=>['getRtMilliDigitStruct',[a[0]],1],
    setRtSeparateStruct:a=>['getRtSeparateStruct',[a[0]],1],
    setTravelKeys:a=>['getKeyTrigger',[a[1]],0],
    setAdvancedKeys:a=>['getAdvancedKeys',[a[0]],1],
    setFuncConfigStruct:a=>['getFuncConfigStruct',[a[0]],1],
    setProfileNamesToAll:()=>['getProfileNames',[0],0],
    setBase:()=>['getBase',[],0],
  };
  const lightSelections=new Set(['setSelectedLightEffect','setSideSelectedLightEffect','setSide2SelectedLightEffect']);
  const read=async (method,args)=>{
    const [getter,params]=pairs[method](args);
    const result=await sdk[getter](...params);
    if(result===undefined||result===null)throw Error('无法备份板载字段：'+getter);
    return method==='setBase'?{activeIndex:result.profileIndex,order:result.profileOrder,length:result.profileLength}:result;
  };
  const simplify=(method,value)=>{
    if(method==='setUserKeys')return value.map(k=>k?[k.type,k.code1,k.code2]:null);
    if(method==='setFuncConfigStruct'){
      const {rf_battery,isCharging,...performanceInfo}=value.performanceInfo??{};
      return {...value,performanceInfo};
    }
    return value;
  };
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
  const same=(method,a,b)=>JSON.stringify(sorted(simplify(method,a)))===JSON.stringify(sorted(simplify(method,b)));
  function differences(method,actual,expected){
    const changes=[];
    function compare(a,b,key){
      if(changes.length>=8||JSON.stringify(a)===JSON.stringify(b))return;
      if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
        for(const name of new Set([...Object.keys(a),...Object.keys(b)]))compare(a[name],b[name],key+'.'+name);
      }else{
        const compact=value=>value&&typeof value==='object'
          ?(Array.isArray(value)?`array(${value.length})`:'object'):value??null;
        changes.push({field:key,actual:compact(a),expected:compact(b)});
      }
    }
    compare(sorted(simplify(method,actual)),sorted(simplify(method,expected)),'');
    return changes;
  }
  const base=await sdk.getBase();
  const order=base.profileOrder?.slice(0,base.profileLength);
  const index=order?.[slot-1];
  if(!Number.isInteger(index)||order.length!==base.profileLength||new Set(order).size!==order.length
    ||!order.includes(base.profileIndex)||index===base.profileIndex)throw Error('目标槽位无效或正在使用。');
  const info=await sdk.getInfo();
  const fingerprint={firmware:String(info.fw_ver),productKey:devices[0].productKey,activeIndex:base.profileIndex,index,order};
  if(operation==='prepare'){
    const steps=[],stop=Error('DAFEIYU_PLAN_ONLY');
    const allowed=new Set(['initDefaultKeys','getBase','getInfo','getProfileNames','getKeyInfos','getMacroProfileList',
      'getKeyTrigger','getAdvancedKeys','getFuncConfigStruct','getCustomParam','getLightValueStruct','getSelectedLightEffect',
      'getSideSelectedLightEffect','getSide2SelectedLightEffect','getRtMilliDigitStruct','getRtSeparateStruct',
      'getKeyCustomLight','getSideKeyColors','getSide2KeyColors','getDefaultKeyInfos','getKeyboardLayout','getFeatureSupport',
      'getMacroHeaders','getDksKeyInfo','getMtKeyInfo','getTglKeyInfo']);
    const readOnly=new Proxy(sdk,{get(target,key){
      const fn=Reflect.get(target,key,target);
      if(typeof fn!=='function'||key==='constructor')return fn;
      if(Object.hasOwn(pairs,key))return async(...args)=>{
        while(args.length&&args.at(-1)===undefined)args.pop();
        steps.push({method:key,args:structuredClone(args)});
        if(key==='setBase')throw stop;
      };
      if(!allowed.has(key))return ()=>{throw Error('驱动需要未验证的方法：'+String(key));};
      return fn.bind(target);
    }});
    const driver=await window.loadCZSharedData();
    const preservesColorIndex=typeof driver.DeviceSDK==='function'
      &&sdk.setFuncConfigStruct===driver.DeviceSDK.prototype.setFuncConfigStruct
      &&driver.toConsiderColorIndexConfig?.('glw')===null;
    const adapter=await driver.generateCloudMethods({deviceSDK:readOnly,profileIndex:index,configLocatedAt:'cloud',token:null,
      lang:{parentLang:'zh_CN'},notifyError(){},notifyProgress(){},allDevices:[]});
    let intercepted=false;
    try{await adapter.cloudApply(source);}
    catch(error){if(error!==stop)throw error;intercepted=true;}
    const methods=steps.map(s=>s.method);
    const targetBase=steps.at(-1)?.args[0];
    if(!intercepted||steps.length>20||targetBase?.activeIndex!==index
      ||targetBase.length!==base.profileLength||JSON.stringify(targetBase.order)!==JSON.stringify(base.profileOrder)
      ||methods.filter(m=>m==='setBase').length!==1||methods.filter(m=>m==='setProfileNamesToAll').length!==1
      ||!['setUserKeys','setTravelKeys','setFuncConfigStruct','setProfileNamesToAll'].every(m=>methods.includes(m)))throw Error('驱动导入计划不完整。');
    const layers=steps.filter(step=>step.method==='setUserKeys').map(step=>step.args[2]);
    if(layers.length!==4||![0,1,2,3].every(layer=>layers.includes(layer)))throw Error('驱动导入计划的键位层不完整。');
    for(const step of steps){
      const {method,args}=step;
      const target=method==='setUserKeys'||method==='setTravelKeys'?args[1]:args[0];
      if(!['setBase','setProfileNamesToAll'].includes(method)&&target!==index)throw Error('导入计划包含其他板载槽位。');
      if(lightSelections.has(method)){
        // GT75 writes empty selection fields as empty strings and reads them
        // back as ["still", ""]. Older shares may omit the tuple entirely.
        const selection=args[1];
        if(selection!=null&&(!Array.isArray(selection)||selection.length>2
          ||selection.some(value=>value!=null&&typeof value!=='string')))
          throw Error('分享的灯效选择格式无效。');
        args[1]=[selection?.[0]||'still',selection?.[1]||''];
      }
      step.original=await read(method,args);
      if(method==='setFuncConfigStruct'){
        // GT75 reads back calibration even when an older cloud share omits it.
        // Preserve the slot's value in the actual write as well as the check.
        const previousLight=step.original.lightConfig;
        const light=args[1].lightConfig;
        if(light&&light.calibrationRgb===undefined&&previousLight?.calibrationRgb!==undefined){
          light.calibrationRgb=structuredClone(previousLight.calibrationRgb);
        }
        // The GLW writer keeps the existing palette index byte and writes the
        // requested RGB color independently. Verify both values as written.
        if(light&&preservesColorIndex&&Number.isInteger(previousLight?.colorIndex)){
          light.colorIndex=previousLight.colorIndex;
        }
        if(args[2]?.updateReportRate===false){
          const expected=structuredClone(args[1]);
          for(const key of ['reporteRate','report_rate_2_4G'])expected.performanceInfo[key]=step.original.performanceInfo[key];
          step.expected=expected;
        }
      }
    }
    const names=steps.find(s=>s.method==='setProfileNamesToAll');
    if(!Array.isArray(names.original)||names.args[0].length!==names.original.length
      ||names.args[0].some((value,i)=>i!==index&&value!==names.original[i]))throw Error('导入计划会更改其他槽位名称。');
    // Cloud aliases require a catalog entry. Store a literal name in the
    // driver's 280-byte UTF-8 JSON field so it survives the catalog refresh.
    const cleanTitle=String(title??'').replace(/[<>\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/g,' ').trim();
    const label=cleanTitle.length>=2?cleanTitle:cleanTitle+'社区配置';
    const others=new Set(names.original.filter((_,i)=>i!==index));
    const updated=names.original.slice();
    const encoder=new TextEncoder(),fits=()=>encoder.encode(JSON.stringify(updated)).length<280;
    const letters=[...new Intl.Segmenter().segment(label)].map(({segment})=>segment);
    for(let n=1;;n++){
      const suffix=n===1?'':` (${n})`;
      let prefix='';
      for(const letter of letters){
        updated[index]=prefix+letter+suffix;
        if(updated[index].length>15||!fits())break;
        prefix+=letter;
      }
      if((prefix.trimEnd()+suffix).length<2)throw Error('键盘槽位名称存储空间不足。');
      updated[index]=prefix.trimEnd()+suffix;
      if(!others.has(updated[index]))break;
    }
    names.args[0]=updated;
    steps.splice(steps.indexOf(names),1);
    steps.push(names);
    return {fingerprint,steps,activeSlot:order.indexOf(base.profileIndex)+1,targetSlot:slot,profileName:updated[index]};
  }
  if(operation!=='apply')throw Error('未知的板载操作。');
  if(JSON.stringify(fingerprint)!==JSON.stringify(transaction?.fingerprint))return {applied:false,changed:true};
  if(window.__dafeiyuBoardWrite)return {applied:false,busy:true};
  const receipt={written:[]};
  let failure=null,switchFailure=null,displaySynced=true;
  window.__dafeiyuBoardWrite=true;
  const namesStep=transaction.steps.find(step=>step.method==='setProfileNamesToAll');
  const router=typeof document==='undefined'?null:window.$router;
  let previousRoute=null,driverRoute=null,previousSelection=null,completed=false,progressElement=null;
  const progress=(phase,done,total,field)=>{
    const labels={setUserKeys:'键位层',setTravelKeys:'触发行程',setFuncConfigStruct:'功能与灯光',setBase:'切换板载槽',setProfileNamesToAll:'保存配置名称'};
    const value={phase,done,total,field:labels[field]??field??'',slot,title:transaction.profileName,at:Date.now(),device:deviceSpec.productKey};
    window.__dafeiyuBoardProgress=value;
    if(typeof document==='undefined'||typeof document.createElement!=='function')return;
    if(!progressElement){
      progressElement=document.createElement('div');progressElement.id='dafeiyu-board-progress';progressElement.setAttribute('role','status');progressElement.setAttribute('aria-live','polite');
      progressElement.style.cssText='position:fixed;z-index:2147483647;bottom:28px;left:50%;transform:translateX(-50%);padding:16px 24px;border:1px solid #d2d8dd;border-radius:12px;background:#fff;color:#20262b;font:15px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 5px 24px #0002;pointer-events:none';
      document.body?.appendChild(progressElement);
    }
    progressElement.textContent=phase==='switch-failed'?("大肥鱼：已写入第 "+slot+" 槽并读回验证，自动切换失败"):phase==='completed'?`大肥鱼：已载入「${transaction.profileName}」· 第 ${slot} 槽 · 读回校验通过`
      :phase==='failed'?'大肥鱼：导入未完成，请查看 QQ 回执及原配置恢复结果'
      :`大肥鱼正在载入「${transaction.profileName}」· 第 ${slot} 槽 · ${done}/${total} · ${value.field}`;
  };
  const driverContext=()=>{
    if(typeof document==='undefined')return null;
    for(const frame of document.querySelectorAll('iframe[src*="/cizhou/"]')){
      try{
        const ctx=frame.contentWindow.activeDeviceContext;
        if(ctx?.vendorId===deviceSpec.vendorId&&ctx.productId===deviceSpec.productId&&!ctx.isDestroyed
          &&typeof ctx.getProfiles==='function'&&typeof ctx.editName==='function'&&typeof ctx.updateProfileConfig==='function')return ctx;
      }catch{}
    }
    return null;
  };
  const rename=async name=>{
    let ctx=driverContext();
    const active=(await sdk.getBase()).profileIndex;
    if(!ctx)throw Error('M HUB 键盘配置页未连接。');
    if(ctx.profile?.activeIndex!==active)await ctx.updateProfileConfig({activeIndex:active});
    ctx=driverContext();
    const profile=ctx?.getProfiles().find(p=>p.type==='keyboard'&&p.profileIndex===index);
    if(!profile||/^EQ<.+@\d+:\d+>QE$/.test(profile.name))throw Error('M HUB 槽位不可重命名。');
    if(profile.name!==name)await ctx.editName(profile.key,name);
    if(driverContext()?.getProfiles().find(p=>p.type==='keyboard'&&p.profileIndex===index)?.name!==name)
      throw Error('M HUB 槽位名称未同步。');
  };
  try{
    if(namesStep){
      const route=router?.currentRoute?.value;
      if(!driverContext()&&route&&router.hasRoute?.('Keyboard')){
        previousRoute=route.fullPath;
        const destination={name:'Keyboard',query:{deviceName:devices[0].productName,isGoUpgradePage:'false'}};
        driverRoute=router.resolve?.(destination)?.fullPath;
        const storage=window.localStorage;
        if(storage){
          const keys=['lastKBProductKey','deviceName','trackDeviceName'];
          previousSelection=keys.map(key=>[key,storage.getItem(key)]);
          // The keyboard page resolves the device from the same remembered
          // product key that the device picker sets before navigating.
          storage.setItem('lastKBProductKey',deviceSpec.productKey);
        }
        await router.push(destination);
        driverRoute??=router.currentRoute.value.fullPath;
        for(let tries=0;tries<40&&router.currentRoute.value.fullPath===driverRoute&&!driverContext();tries++)
          await new Promise(resolve=>setTimeout(resolve,150));
      }
      const profile=driverContext()?.getProfiles().find(p=>p.type==='keyboard'&&p.profileIndex===index);
      if(!profile||/^EQ<.+@\d+:\d+>QE$/.test(profile.name))
        return {applied:false,nameUnavailable:true};
      if(profile.name!==namesStep.original[index])return {applied:false,changed:true};
    }
    for(const step of transaction.steps)if(!same(step.method,await read(step.method,step.args),step.original))
      throw Error('目标槽内容已变化，请重新生成建议。');
    const verify=async({method,args,expected},nameBank=0)=>{
      failure={method,phase:'readback',...(method==='setUserKeys'?{layer:args[2]}:{})};
      const actual=method==='setProfileNamesToAll'&&nameBank?await sdk.getProfileNames(nameBank):await read(method,args);
      const wanted=expected??args[pairs[method](args)[2]];
      if(!same(method,actual,wanted)){
        failure.differences=differences(method,actual,wanted);
        throw Error('板载读回不一致：'+method);
      }
    };
    progress('writing',0,transaction.steps.length);
    for(const step of transaction.steps){
      progress('writing',receipt.written.length,transaction.steps.length,step.method);
      receipt.written.push(step);
      const {method,args}=step;
      failure={method,phase:'write',...(method==='setUserKeys'?{layer:args[2]}:{})};
      try{
        if(method==='setProfileNamesToAll')await rename(args[0][index]);
        else await sdk[step.method](...step.args);
        await verify(step);
      }catch(error){
        if(method!=='setBase')throw error;
        const actual=await read(method,args);
        if(same(method,actual,args[0]))continue;
        if(!same(method,actual,step.original))throw error;
        receipt.written.pop();
        switchFailure=failure;
      }
    }
    // Switching profiles can reload the firmware's active slot and driver cache.
    // Check the user-facing keyboard settings after that transition as well.
    for(const step of transaction.steps){
      if(step.method==='setBase'&&switchFailure){
        if(!same(step.method,await read(step.method,step.args),step.original))throw Error('活动槽状态已变化。');
      }else if(['setUserKeys','setTravelKeys','setFuncConfigStruct','setProfileNamesToAll','setBase'].includes(step.method))await verify(step,switchFailure?0:index);
    }
    const ctx=driverContext();
    if(!switchFailure&&ctx?.profile?.activeIndex!==index){
      try{await ctx?.updateProfileConfig({activeIndex:index});}catch{}
      displaySynced=driverContext()?.profile?.activeIndex===index;
    }
    completed=true;progress(switchFailure?'switch-failed':'completed',receipt.written.length,transaction.steps.length);
    return {applied:true,verified:true,slot,profileName:transaction.profileName,operations:receipt.written.length,...(switchFailure?{switched:false,switchFailure}:displaySynced?{}:{switched:true,displaySynced:false})};
  }catch(error){
    if(!receipt.written.length)return {applied:false,changed:true,error:String(error.message||error).slice(0,160)};
    const failed=[];
    for(const {method,args,original} of receipt.written.reverse()){
      try{
        if(method==='setProfileNamesToAll')await rename(original[index]);
        else{
          const params=args.slice();params[pairs[method](args)[2]]=original;await sdk[method](...params);
          if(method==='setBase'&&namesStep&&driverContext()?.profile?.activeIndex!==original.activeIndex)
            await driverContext()?.updateProfileConfig({activeIndex:original.activeIndex});
        }
      }
      catch{failed.push(method);}
    }
    for(const {method,args,original} of receipt.written){
      try{if(!same(method,await read(method,args),original))failed.push(method);}
      catch{failed.push(method);}
    }
    return {applied:false,verified:false,restored:failed.length===0,failed,failure,error:String(error.message||error).slice(0,160)};
  }finally{
    if(!completed&&progressElement)progress('failed',receipt.written.length,transaction.steps.length);
    if(progressElement){const node=progressElement;setTimeout(()=>node.remove(),completed?12000:20000);}
    try{
      const currentRoute=router?.currentRoute?.value?.fullPath;
      if(!completed&&previousRoute&&(currentRoute===driverRoute||currentRoute===previousRoute)){
        const storage=window.localStorage;
        if(previousSelection&&storage?.getItem('lastKBProductKey')===deviceSpec.productKey)
          for(const [key,value] of previousSelection){
            if(value===null)storage.removeItem(key);else storage.setItem(key,value);
          }
        if(currentRoute!==previousRoute)await router.replace(previousRoute).catch(()=>{});
      }
    }finally{delete window.__dafeiyuBoardWrite;}
  }
}

export async function prepareCommunityBoard(assistant,item,device,slot,{evaluate=evaluateInMhub}={}){
  requireDeviceLink();
  const model=normalizeDevice(device).replace(/8k$/,'');
  const deviceSpec=model==='gt75'?{vendorId:14391,productId:12333,productKey:'GT 75$$$14391$$$12333'}:model==='ace75'?{vendorId:14391,productId:12348,productKey:'Ace 75$$$14391$$$12348'}:null;
  if(item.category!==1001||!deviceSpec||normalizeDevice(item.device).replace(/8k$/,'')!==model)
    throw Error('当前可确认写入的范围是 GT75 / Ace 75 的整套键盘配置。');
  if(!Number.isInteger(slot)||slot<1||slot>4)throw Error('请选择实际板载槽位。');
  const response=await assistant.client.search({category1:1,category2:1001,shareCode:item.shareCode,deviceName:[],tag:'',sort:2,page:1,size:8});
  let title;
  const raw=response.items.find(row=>{
    const share=normalizeShare(row,{queriedCategory:1001,fetchedAt:new Date().toISOString()});
    if(share?.shareCode!==item.shareCode||share.contentHash!==item.contentHash||normalizeDevice(share.device).replace(/8k$/,'')!==model)return false;
    title=share.title;
    return true;
  });
  if(!raw)throw Error('这条分享已变化或下架，请重新查询。');
  const identity=raw.content.extra?.identity;
  if(Number(identity?.vendorId)!==deviceSpec.vendorId||Number(identity?.productId)!==deviceSpec.productId)throw Error('分享内的硬件型号与目标键盘不一致。');
  requireDeviceLink();
  return evaluate(boardOperation,{operation:'prepare',deviceSpec,slot,title,source:{id:raw.id,type:'cloud',content:raw.content}},22000);
}

export function communityBoardSummary(transaction){
  const steps=transaction?.steps??[],lines=[];
  const travel=steps.find(s=>s.method==='setTravelKeys')?.args?.[0];
  const values=Array.isArray(travel)?travel.map(k=>k?.keyActuation).filter(n=>Number.isInteger(n)&&n>=0&&n<=500):[];
  if(values.length){const low=Math.min(...values)/100,high=Math.max(...values)/100;lines.push(low===high?`分享里的按键触发行程为 ${low} 毫米`:`分享里的按键触发行程在 ${low} 到 ${high} 毫米之间`);}
  const layers=steps.filter(s=>s.method==='setUserKeys');
  if(layers.length)lines.push(`会载入 ${layers.length} 层键位，包含普通层和组合层`);
  const light=steps.find(s=>s.method==='setFuncConfigStruct')?.args?.[1]?.lightConfig;
  if(light)lines.push('也会载入分享里的键盘灯效和氛围灯参数；启用的余额条会在导入结束后重新显示');
  return lines.length?lines.join('。')+'。':null;
}

export async function applyCommunityBoard(assistant,plan,{evaluate=evaluateInMhub}={}){
  requireDeviceLink();
  const folder=path.join(assistant.store.directory,'board-backups');
  await fs.mkdir(folder,{recursive:true});
  const file=path.join(folder,randomUUID()+'.json');
  const record={at:new Date().toISOString(),shareCode:plan.best.shareCode,device:plan.target,slot:plan.slot.targetSlot,transaction:plan.transaction};
  await fs.writeFile(file,JSON.stringify(record,null,2),{flag:'wx',mode:0o600,flush:true});
  const backup=path.basename(file);
  let result;
  try{
    result=await withDeviceWrite(()=>evaluate(boardOperation,{operation:'apply',deviceSpec:record.transaction.fingerprint.productKey==='Ace 75$$$14391$$$12348'?{vendorId:14391,productId:12348,productKey:record.transaction.fingerprint.productKey}:undefined,slot:record.slot,transaction:record.transaction},85000));
  }catch(error){result={applied:false,unknown:true,error:String(error?.message||error).split(/\r?\n/,1)[0].slice(0,160)};}
  const receipt={...result,backup};
  try{
    const receipts=path.join(assistant.store.directory,'board-receipts');
    await fs.mkdir(receipts,{recursive:true});
    await fs.writeFile(path.join(receipts,backup),JSON.stringify({at:new Date().toISOString(),...receipt},null,2),
      {flag:'wx',mode:0o600,flush:true});
  }catch{return {...receipt,receiptSaved:false};}
  return receipt;
}
