import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const tiers={int8:'SenseVoice Small · INT8（228 MB）',fp32:'SenseVoice Small · FP32（894 MB）',paraformer:'Paraformer · INT8（78 MB）'};
// Read only the model projection. Never return messages, prompts or credentials.
export function voiceInfo({home=os.homedir(),localAppData=process.env.LOCALAPPDATA,voiceRoot,config={}}={}){
  let conversation={available:false};
  try{
    const id=read(path.join(home,'.dsh/fish-buddy-config.json')).会话;
    if(!/^session-[a-f\d-]{36}$/.test(id))throw Error('Invalid session');
    const rows=read(path.join(home,'.dsh/storages/session_projcache/sessions',id+'.json')).record.rows;
    const selection=rows.modelSelection?.val,pending=selection?.pending,last=selection?.lastUsed,chosen=pending??last;
    conversation={available:true,id,title:rows.title?.val??'鱼搭子陪伴会话',model:chosen?.model??null,provider:chosen?.provider??null,reasoningEffort:chosen?.reasoningEffort??null,source:pending?'下次使用':'最近一轮',checkedAt:Date.now()};
  }catch{}
  const widgetRoot=path.join(localAppData??path.join(home,'AppData/Local'),'鱼搭子');
  const modelRoot=config.fishBuddyModelRoot?path.resolve(voiceRoot??'.',config.fishBuddyModelRoot):path.join(widgetRoot,'models');
  const installedTiers=Object.keys(tiers).filter(tier=>{const folder=path.join(modelRoot,tier==='fp32'?'':tier);return ['model.onnx','tokens.txt'].every(file=>fs.existsSync(path.join(folder,file)));});
  let widgetTier=null;for(const file of new Set([path.join(path.dirname(modelRoot),'config.json'),path.join(widgetRoot,'config.json')])){try{widgetTier=read(file).语音模型;break;}catch{}}
  const effectiveTier=config.fishBuddyFollowSelection!==false&&tiers[widgetTier]?widgetTier:config.fishBuddyModel??'fp32';
  return {conversation,recognition:{effectiveTier,effectiveName:tiers[effectiveTier],selectedInstalled:installedTiers.includes(effectiveTier),installedTiers,language:config.asrLanguage??'zh',providers:[{id:'fish-buddy',name:'鱼搭子 · 本地 SenseVoice / Paraformer',installed:installedTiers.length>0},{id:'qwen3-asr',name:'本地 Qwen3-ASR · 1.7B',installed:!!voiceRoot&&fs.existsSync(path.join(voiceRoot,'models/Qwen3-ASR-1.7B-hf/config.json'))},{id:'doubao-ime',name:'豆包输入法',installed:!!voiceRoot&&fs.existsSync(path.join(voiceRoot,'ImeBridge.exe'))}]},tts:{localName:'IndexTTS2 · 大肥鱼迷糊版本地音色',cloudName:config.breeze?.voiceName??'BreezeBlue',cloudStreaming:config.breeze?.streaming!==false}};
}
