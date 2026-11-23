import {connectMhubDebug} from './mhub_light_sync_api.mjs?v=mhub-renderer-prod';

async function loadMhubModule(){
  const bootstrap=Array.from(document.scripts).find(s=>s.type==='module'&&s.src.startsWith('mchose-renderer:'))?.src;
  if(!bootstrap)throw Error('M HUB bootstrap not found');
  const text=await(await fetch(bootstrap)).text();
  const match=text.match(/import\("(\.\/main-[^"\s]+\.js)"\)/);
  if(!match)throw Error('Current shared module not found');
  const module=await import(new URL(match[1],bootstrap).href);
  // Export short names change in M HUB updates. Resolve known services by
  // their stable identity, then expose the adapter's established aliases.
  const values=Object.values(module);
  const unique=(matches,label)=>{if(matches.length!==1)throw Error('M HUB '+label+' interface is ambiguous');return matches[0];};
  const byName=name=>unique(values.filter(v=>typeof v==='function'&&v.name===name),name);
  const getStore=unique(values.filter(v=>typeof v==='function'&&v.$id==='lightSync2'),'lightSync2');
  const initialized=getStore();
  const pinia=document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
  if(!pinia)throw Error('M HUB 界面正在初始化，请稍候');
  const store=pinia._s.get('lightSync2');
  if(initialized!==store)throw Error('M HUB module/store mismatch');
  const deviceSystem=unique(values.filter(v=>v&&typeof v==='object'&&v.deviceStore&&v.catalog&&v.devices),'devices');
  return {...module,c3:getStore,c2:byName('resolveKeyboardLayout'),cb:byName('useLightSync2MediaRuntime'),
    b1:byName('saveCustomMedia'),b2:byName('deleteCustomMedia'),b7:byName('getLightSync2RuntimeFrames'),
    de:unique(values.filter(v=>v&&typeof v==='object'&&typeof v.getK20GtScreenState==='function'),'K20 GT'),
    aH:deviceSystem};
}

export async function evaluateInMhub(fn,arg={},timeout=25000,{signal}={}){
  const client=await connectMhubDebug({signal});
  try{
    const expression=`(async()=>{const loadMhubModule=${loadMhubModule.toString()};return JSON.stringify(await (${fn.toString()})(${JSON.stringify(arg)}));})()`;
    const result=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return JSON.parse(result.result.value);
  }finally{client.close();}
}
