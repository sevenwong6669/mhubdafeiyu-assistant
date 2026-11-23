import fs from 'node:fs/promises';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {displayResident,displayText,displayClock} from './screen.mjs';
import {AFFINITY_START,affinityText} from './affinity.mjs';
import {accountBalance} from './balance-bar.mjs';
export const DEFAULT_SCREEN_CYCLE=Object.fromEntries(Array.from({length:9},(_,i)=>['theme'+i,true]));
export const DEFAULT_SCREEN_PAGES={fish:true,status:true,balance:true,clock:true,affinity:true};
export function validateScreenPages(values){if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(x=>!Object.hasOwn(DEFAULT_SCREEN_PAGES,x)||typeof values[x]!=='boolean'))throw Error('快捷页面清单无效。');const result={...DEFAULT_SCREEN_PAGES,...values};if(Object.values(result).filter(Boolean).length<2)throw Error('至少保留两个快捷页面。');return result;}
export class ScreenButtonDebounce{
  accept(event){const key=JSON.stringify([event.enabled,event.mode,event.theme,event.index]);if(key===this.key&&event.at-this.at<250)return false;this.key=key;this.at=event.at;return true;}
}
export function systemClock(now=Date.now()){
  const date=new Date(now),two=n=>String(n).padStart(2,'0');
  const day=`${date.getFullYear()}/${two(date.getMonth()+1)}/${two(date.getDate())}`,weekday=new Intl.DateTimeFormat('zh-CN',{weekday:'short'}).format(date),time=`${two(date.getHours())}:${two(date.getMinutes())}`;
  return {date:day,weekday,text:time,screenText:`${day}  ${weekday}  ${time}`,at:now};
}
export function screenPagePayloads(style,balance,now=Date.now(),affinity=AFFINITY_START,weather=null){
  const color=style.color.slice(1).match(/../g).map(x=>parseInt(x,16));
  const account=accountBalance(balance,'CNY',now);
  const balanceText=account?'余额 '+account.amount.toFixed(2)+' 元':'余额暂不可用';
  const clockParts=systemClock(now),clock=clockParts.screenText;
  const clockLayout={date:clockParts.date,weekday:clockParts.weekday,time:clockParts.text,
    weather:weather?.enabled?weather.text??'':'',location:weather?.enabled?weather.location??'':''};
  const texts={fish:null,status:style.label,balance:balanceText,clock:weather?.enabled&&weather.text?clock+'  '+weather.text:clock,affinity:affinityText(affinity)};
  return Object.fromEntries(Object.entries(texts).map(([page,text])=>{
    const pageColor=page==='affinity'?[255,0,0]:color;
    const layout=page==='clock'?clockLayout:null;
    return [page,{text,color:pageColor,fontSize:page==='clock'?0:1,layout,key:JSON.stringify({page,text,color:pageColor,layout})}];
  }));
}
export function validateScreenCycle(values){
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(x=>!Object.hasOwn(DEFAULT_SCREEN_CYCLE,x)||typeof values[x]!=='boolean'))throw Error('屏幕循环清单无效。');
  const result={...DEFAULT_SCREEN_CYCLE,...values};if(Object.values(result).filter(Boolean).length<2||!result.theme8)throw Error('至少保留两组主题，并保留大肥鱼自定义动画。');return result;
}
export class HardwareScreen{
  constructor({evaluatePageButtons=evaluateInMhub}={}){this.evaluatePageButtons=evaluatePageButtons;this.version=null;this.last=0;this.lastCapture=0;this.held=null;this.error=null;this.pagesVersion=null;this.pages={...DEFAULT_SCREEN_PAGES};this.page='fish';this.pageKey=null;this.listening=false;this.screenOff=false;this.buttons=new ScreenButtonDebounce();this.buttonCount=0;this.cacheKey=null;this.blocked=null;}
  async poll(){
    if(Date.now()-this.last<500)return;this.last=Date.now();
    try{const {controlVersion,...values}=JSON.parse(await fs.readFile(new URL('screen-pages.json',import.meta.url),'utf8'));if(controlVersion!==this.pagesVersion){this.pages=validateScreenPages(values);this.pagesVersion=controlVersion;this.pageKey=null;if(!this.pages[this.page])this.page=Object.keys(this.pages).find(k=>this.pages[k]);}}
    catch(e){if(e.code!=='ENOENT')this.error=e.message;}
    try{const raw=JSON.parse(await fs.readFile(new URL('screen-cycle.json',import.meta.url),'utf8'));if(raw.controlVersion===this.version)return;const {controlVersion,...values}=raw,switches=Object.values(validateScreenCycle(values));
      await evaluateInMhub(async({switches})=>{const m=await loadMhubModule(),d=m.aH.devices.value.find(x=>x.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT 未连接');await m.de.setK20GtThemeSwitches(d.logicalDeviceId,switches);const actual=(await m.de.getK20GtScreenState(d.logicalDeviceId)).screenState.themeStates.map(x=>x.enabled);if(JSON.stringify(actual)!==JSON.stringify(switches))throw Error('实体键循环清单读回不一致');return {ok:true};},{switches});
      this.version=controlVersion;this.error=null;
    }catch(e){if(e.code!=='ENOENT')this.error=e.message;}
  }
  async capture(force=false){
    if(!force&&Date.now()-this.lastCapture<800)return;this.lastCapture=Date.now();
    this.held=await evaluateInMhub(async()=>{const m=await loadMhubModule(),d=m.aH.devices.value.find(x=>x.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT 未连接');const s=(await m.de.getK20GtScreenState(d.logicalDeviceId)).screenState;return {enabled:s.enabled,color:s.color,mode:s.mode,theme:s.theme,index:s.themeStates?.[s.theme]?.index??0,...(s.mode===1?{text:(await m.de.getK20GtScreenText(d.logicalDeviceId)).text}:{})};});
  }
  async restore(){if(!this.held)return;await evaluateInMhub(async({state})=>{const m=await loadMhubModule(),d=m.aH.devices.value.find(x=>x.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT 未连接');const {text,...screen}=state;if(text)await m.de.setK20GtScreenText(d.logicalDeviceId,text);window.__dafeiyuScreenExpected={...screen,at:Date.now()};await m.de.setK20GtScreenState(d.logicalDeviceId,screen);return {ok:true};},{state:this.held});}
  async pageButtons(enabled){
    if(enabled&&!this.listening){
      await this.evaluatePageButtons(async()=>{
        window.__dafeiyuPageButtons?.close?.();const m=await loadMhubModule(),d=m.aH.devices.value.find(x=>x.modelKey==='MCHOSE K20 GT');if(!d)throw Error('K20 GT 未连接');
        const store={events:[],blocked:false};const off=m.de.subscribeK20GtScreen(d.logicalDeviceId,event=>{
          if(event.type!=='screenState')return;const data=event.data,own=window.__dafeiyuScreenExpected;
          if(Date.now()<(window.__dafeiyuScreenWriteUntil||0))return;
          const wake=store.wasOff&&data.enabled===true;if(data.enabled===false)store.wasOff=true;else if(wake)store.wasOff=false;
          if(!wake&&own&&Date.now()-own.at<5000&&['enabled','mode','theme','index'].every(k=>data[k]===undefined||data[k]===own[k]))return;
          const at=Date.now(),signature=JSON.stringify([data.enabled,data.mode,data.theme,data.index]);if(store.lastSignature===signature&&at-store.lastAt<250)return;store.lastSignature=signature;store.lastAt=at;
          const entry={at,enabled:data.enabled,mode:data.mode,theme:data.theme,index:data.index};
          const push=()=>{store.events.push(entry);if(store.events.length>10)store.events.shift();};
          if(data.enabled===false||wake||!store.cache||!store.order?.length){push();return;}
          const page=store.order[(store.order.indexOf(store.page)+1)%store.order.length],spec=store.cache[page];store.page=page;entry.page=page;
          if(store.blocked){push();return;}
          if(spec.layout||store.bitmapClock&&spec.text===null){push();return;}
          window.__dafeiyuScreenWriteUntil=Date.now()+300;
          store.pending=(async()=>{
            try{
              const state={enabled:true,color:spec.color,mode:spec.text===null?0:1,theme:8,index:1};window.__dafeiyuScreenExpected={...state,at:Date.now()};
              // Restore the custom theme first, then change its text. This hides
              // the firmware's built-in clock before the normal controller poll.
              await m.de.setK20GtScreenState(d.logicalDeviceId,state);
              if(spec.text!==null)await m.de.setK20GtScreenText(d.logicalDeviceId,{type:0,font:0,fontSize:spec.fontSize??1,align:1,direction:0,animation:0,text:spec.text});
              entry.key=spec.key;entry.fastApplyMs=Date.now()-at;
            }catch(error){entry.error=error.message;}
            push();
          })();
        });store.close=off;window.__dafeiyuPageButtons=store;return {ready:true};
      });this.listening=true;this.pageKey=null;this.cacheKey=null;this.blocked=null;
    }
    if(!enabled&&this.listening){
      await this.evaluatePageButtons(async()=>{
        const store=window.__dafeiyuPageButtons;
        if(store){store.blocked=true;await store.close();await store.pending;delete window.__dafeiyuPageButtons;}
        return {stopped:true};
      });
      this.listening=false;return;
    }
    if(!enabled)return;
    const events=await this.evaluatePageButtons(async()=>window.__dafeiyuPageButtons?.events.splice(0)??[]);
    for(const event of events){if(Date.now()-event.at>5000||!this.buttons.accept(event))continue;if(event.enabled===false){this.screenOff=true;continue;}if(this.screenOff){this.screenOff=false;this.pageKey=null;continue;}
      const pages=Object.keys(this.pages).filter(k=>this.pages[k]);this.page=pages.includes(event.page)?event.page:pages[(pages.indexOf(this.page)+1)%pages.length];this.pageKey=event.key??null;this.lastFastApplyMs=event.fastApplyMs??null;if(event.error)this.error=event.error;
      this.buttonCount++;this.lastButtonAt=event.at;
    }
  }
  async blockPages(blocked){if(!this.listening||blocked===this.blocked)return;await evaluateInMhub(async({blocked})=>{if(window.__dafeiyuPageButtons)window.__dafeiyuPageButtons.blocked=blocked;return {ok:true};},{blocked});this.blocked=blocked;}
  async nextPage(){const order=Object.keys(this.pages).filter(k=>this.pages[k]);this.page=order[(order.indexOf(this.page)+1)%order.length];this.pageKey=null;if(this.listening)await evaluateInMhub(async({page})=>{if(window.__dafeiyuPageButtons)window.__dafeiyuPageButtons.page=page;return {ok:true};},{page:this.page});}
  async renderPage(style,balance,affinity,weather){
    if(this.screenOff)return;const cache=screenPagePayloads(style,balance,Date.now(),affinity,weather),order=Object.keys(this.pages).filter(k=>this.pages[k]),cacheKey=JSON.stringify({cache,order});
    if(cacheKey!==this.cacheKey){await evaluateInMhub(async({cache,order,page})=>{const store=window.__dafeiyuPageButtons;if(store){if(!store.cache||!order.includes(store.page))store.page=page;store.cache=cache;store.order=order;}return {ok:true};},{cache,order,page:this.page});this.cacheKey=cacheKey;}
    const {text,color,key,fontSize,layout}=cache[this.page];if(key===this.pageKey)return;
    if(layout){
      await evaluateInMhub(()=>{if(window.__dafeiyuPageButtons)window.__dafeiyuPageButtons.bitmapClock=true;return true;});
      await displayClock(layout,color);
    }else if(text===null){
      await displayResident(color);
      await evaluateInMhub(()=>{if(window.__dafeiyuPageButtons)window.__dafeiyuPageButtons.bitmapClock=false;return true;});
    }else await displayText(text,color,{fontSize});
    this.pageKey=key;
  }
}
