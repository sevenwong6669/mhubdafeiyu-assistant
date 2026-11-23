import { evaluateInMhub } from '../mhub_runtime_access.mjs?v=mhub-renderer-prod';
import { isCommunityGame, normalizeDevice } from './community.mjs?v=community-search-116';

// Apply observed ASR homophones only to community-device searches. Preserve
// normal conversation, titles, user-written text and explicit hardware names.
export function normalizeCommunitySpeech(text){
  if(typeof text!=='string'||text.length>600||!/社区|配置|预设|参数/.test(text))return text;
  return text.replace(/(?:达瓦|大瓦)(?=的|配置|键盘|鼠标|参数|[，。,.\s]|$)/g,'打瓦');
}

export function communityPttIntent(text) {
  return typeof text==='string'&&text.length<=100&&/社区/.test(text)
    &&/(找|搜|查|推荐|挑|整理)/.test(text)&&/(配置|预设|设置|灯效|动画|宏|均衡器|\bEQ\b)/i.test(text)
    &&!/^(?:大肥鱼[，,\s]*)?(?:别|不要|不用|先别)/.test(text.trim());
}

export function communitySearchHint(text,{allowShorthand=false}={}){
  if(typeof text!=='string'||text.length>180||/^(?:大肥鱼[，,\s]*)?(?:别|不要|不用|先别)/.test(text.trim()))return false;
  return communityPttIntent(text)
    || (isCommunityGame(text)&&(/配一套|整一套|调一套|来一套|配置|设置|预设|参数|键盘|鼠标|耳机/.test(text)
      ||allowShorthand&&/(找|搜|查|推荐)/.test(text)));
}

export async function suggestBoardSlot(inventory,model,{evaluate=evaluateInMhub}={}) {
  const targets=inventory.stale?[]:inventory.devices.filter(d=>d.family==='keyboard'
    &&d.status==='listed-by-mhub'&&normalizeDevice(d.model)===normalizeDevice(model)
    &&Number.isInteger(d.vendorId)&&Number.isInteger(d.productId));
  if(targets.length!==1)return null;
  const {vendorId,productId}=targets[0];
  try{
    return await evaluate(async ids=>{
      const cz=window.ALL_CZ_STATE;
      const devices=[...cz.deviceStateMap.keys()].filter(d=>d.vendorId===ids.vendorId&&d.productId===ids.productId);
      if(devices.length!==1)return null;
      const {sdk}=await cz.getDeviceState(devices[0]),base=await sdk.getBase();
      if(!Number.isInteger(base.profileIndex)||!Number.isInteger(base.profileLength)||base.profileLength<2||base.profileLength>4)return null;
      const slots=base.supportOrderProfile?base.profileOrder?.slice(0,base.profileLength):Array.from({length:base.profileLength},(_,i)=>i);
      if(!Array.isArray(slots)||slots.length!==base.profileLength||new Set(slots).size!==slots.length
        ||!slots.every(slot=>Number.isInteger(slot)&&slot>=0&&slot<=3)||!slots.includes(base.profileIndex))return null;
      const activeSlot=slots.indexOf(base.profileIndex)+1;
      const targetSlot=slots.findIndex(slot=>slot!==base.profileIndex)+1;
      return {activeSlot,targetSlot};
    },{vendorId,productId},2600);
  }catch{return null;}
}

export function shareExplanation(item) {
  const profile=item.facts?.keyboardProfile;
  if(profile){
    const pieces=[];
    if(Number.isFinite(profile.defaultActuationMm))pieces.push(`大部分按键按下 ${profile.defaultActuationMm} 毫米就会触发`);
    if(profile.overrideKeys>0){
      const range=profile.overrideActuationMm;
      pieces.push(range?`另外有 ${profile.overrideKeys} 个键设成了 ${range[0]===range[1]?range[0]:range.join(' 到 ')} 毫米`:`另外有 ${profile.overrideKeys} 个键单独调了触发行程`);
    }
    if(profile.containsKeyMappings||profile.containsLighting)
      pieces.push('导入也会带上分享里的'+[profile.containsKeyMappings?'键位':'',profile.containsLighting?'灯效':''].filter(Boolean).join('和'));
    if(pieces.length)return pieces.join('。')+'。';
  }
  const facts=item.facts??{};
  if(facts.dpi?.length)return `分享包含 ${facts.dpi.length} 档 DPI（${facts.dpi.join('、')}），整套导入也可能覆盖鼠标按键。`;
  if(Number.isInteger(facts.macroSteps))return `分享包含 ${facts.macroSteps} 步宏动作，动作内容需在驱动内逐项核对。`;
  return '读到了分享信息，具体参数需要在驱动里核对。';
}

const plain=(value,max)=>String(value??'').replace(/[<>\[\]\r\n\x00-\x1f\x7f]/g,' ').trim().slice(0,max);
export function communityVoiceMessage(result,{slot=null}={}) {
  if(!result.candidates.length)return {text:'',spoken:result.mode.startsWith('needs-')
    ? result.note+(result.availableDevices?.length?` ${result.availableDevices.join('、')}。`:'')
    : `我用${result.searchedKeywords?.join('、')||result.topic}查了${result.targetDevice}，这次没有找到匹配的分享。`};
  const [best,...others]=result.candidates.slice(0,3);
  const card=(item,index)=>`${index+1}. ${plain(item.title,60)} · ${plain(item.device,45)}\n分享码 ${plain(item.shareCode,120)}\n作者 ${plain(item.author,40)||'未标注'} · 标签 ${plain(item.tags,85)||'未标注'}`;
  const source=result.mode==='cache-fallback'?'社区暂时连不上，下面是历史资料。':`为 ${plain(result.targetDevice,45)} 找到的迈从社区分享`;
  const slotNote=slot?`板载建议选第 ${slot.targetSlot} 槽，避开当前正在用的第 ${slot.activeSlot} 槽。第 ${slot.targetSlot} 槽是否空闲还需要你确认并先备份。`
    :best.category===1001?'还没有核实板载槽位，请先在 M HUB 查看。':'';
  return {text:[source,card(best,0),shareExplanation(best),others.length?'另外可对比\n'+others.map((item,i)=>card(item,i+1)).join('\n\n'):'',slotNote].filter(Boolean).join('\n\n'),
    spoken:`我为${plain(result.targetDevice,30)}挑了${1+others.length}条分享。主要推荐这条，${shareExplanation(best)}${slot?`建议先看板载第${slot.targetSlot}槽。`:''}`};
}
