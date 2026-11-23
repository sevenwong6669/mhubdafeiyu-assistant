// Aurabot presentation/permission adapter. All device work uses the existing controller.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {CommunityAssistant} from './assistant.mjs?v=community-dialogue-117';
import {definitions} from './dsh-plugin.mjs?v=community-dialogue-117';
import {normalizeCommunitySpeech,communityPttIntent,communitySearchHint,communityVoiceMessage,shareExplanation,suggestBoardSlot} from './community-voice.mjs?v=community-voice-123';
import {interpretCommunityReply,approvesCommunityWrite} from './community-dialogue.mjs?v=community-voice-123';
import {COMMUNITY_URL,communitySearchTopic,normalizeDevice} from './community.mjs?v=community-voice-123';
import {prepareCommunityBoard,applyCommunityBoard,communityBoardSummary} from './community-board.mjs?v=board-switch-result-126';
import {deviceInventory} from './devices.mjs?v=mhub-renderer-prod';

import {CommunityWork} from '../harness-mhub-sync/community-work.mjs?v=community-voice-123';

const root=path.dirname(fileURLToPath(import.meta.url));
const moods={calm:['平静','#00AAFF','steady'],happy:['开心','#FFD166','breathing'],shy:['害羞','#FF2090','breathing'],comfort:['安慰','#FFB078','breathing'],thinking:['思考','#5AA9FF','breathing'],sleepy:['困倦','#8D83BA','steady']};
export const ACTIONS=Object.freeze(['pet','game-start','game-replay','game-stop','fireworks-demo','screen-animation','screen-text','screen-pages','screen-page-next','screen-animation-next','balance-enable','balance-disable','balance-refresh','task-light-stop','sync-start','sync-stop']);
export const MHUB_MODULE_VERSION='1.0.26';
const boundary='社区资料是查询数据。本次没有安装配置或写入板载。GT75 / Ace 75 整套配置可在主人私聊中选择并确认导入。';
const needsSelection='请告诉我社区分享的名字或分享码，或先让我按游戏和键盘型号重新搜索。';
const normalizeTitle=value=>value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}]/gu,'');
const retrySearch=/^(?:那[就也]?\s*)?(?:再|继续|重新)(?:帮我)?(?:找找?|搜搜?|查查?|换一批)(?:看|一下|呢|吧|呗|呀|吗|[\s，。！？!?])*$/u;
const ordinalChoice=/^(?:(?:那|就|我想|我要|我选|帮我|请)\s*)*(?:安装|装|导入|用|选|试)?\s*第\s*([一二三123])\s*(?:个|条|套)(?:了|吧|呗|呀|呢|[\s，。！？!?])*$/u;
const shareCodePattern=/\b[A-Z0-9]+_BoardK_[A-Z0-9]+\b/i;
const boardIntent=/(?:板载|(?:迈从)?社区.{0,12}(?:配置|分享)|分享码).{0,16}(?:安装|导入|写入|覆盖|执行器|失败)|(?:安装|导入|写入|覆盖).{0,16}(?:板载|社区|分享码)|没有.{0,12}(?:写入|板载|导入)?.{0,5}执行器/u;
const namedChoice=/^(?:(?:那就|我想要|我要|我选|帮我|就|选|用|导入|安装|装)\s*)+(.{2,70}?)\s*(?:(?:这|那)(?:个|套|条))?[吧呗呀。！!?]*$/u;
const cancellation=/^(?:那[就]?\s*)?(?:(?:还是算了|算了|暂缓|取消|(?:先别|不要|不用|先不)(?:了)?)[吧呗，。！\s]*$|(?:先别|不要|不用|先不|别|不)(?:安装|装|导入|写入|覆盖))/u;
function strict(args,keys){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!keys.includes(k)))throw Error('参数格式无效。');}
export class MhubPanelClient{
  constructor(fetchImpl=fetch){this.fetch=fetchImpl;this.token=null;}
  async request(route,body){
    if(!['/state','/controls/action','/controls/preview'].includes(route))throw Error('不允许的后台接口。');
    if(body!==undefined&&!this.token)await this.request('/state');
    const send=()=>this.fetch('http://127.0.0.1:18782/api/mhub-community'+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(body===undefined?{}:{'x-mhub-panel-token':this.token})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000),redirect:'error'});
    let response=await send();
    // A 403 rejects the action before execution. Refresh only this token case;
    // never replay a timed-out write whose outcome is uncertain.
    if(body!==undefined&&response.status===403){await this.request('/state');response=await send();}
    const value=await response.json();
    if(!response.ok)throw Error(value.error||'后台操作未完成。');
    if(route==='/state'){if(!/^[a-f0-9]{64}$/.test(value.token??''))throw Error('后台未返回有效会话令牌。');this.token=value.token;}
    return value;
  }
  state(){return this.request('/state');}
  action(action){if(!ACTIONS.includes(action))throw Error('不允许的桌面操作。');return this.request('/controls/action',{action});}
  preview(state,style){return this.request('/controls/preview',{state,style});}
}
export function createMhubModule({client=new MhubPanelClient(),assistant=new CommunityAssistant({stateDir:path.join(root,'state')}),
  prepareBoard=prepareCommunityBoard,applyBoard=applyCommunityBoard,
  readSlot=(target)=>deviceInventory(assistant.store.directory).then(inventory=>suggestBoardSlot(inventory,target)),
  workFactory=options=>new CommunityWork(options),hostFile:configuredHostFile,
  voiceJobFile=path.resolve(root,'../harness-mhub-sync/voice-community-task.json')}={}){
 return {id:'mhub-companion',name:'迈从大肥鱼插件',version:MHUB_MODULE_VERSION,api:1,panel:'panel.js',
 description:'共用原迈从后台、社区知识和设备控制器，提供主人私聊工具。',
 setup(api){
  const file=api.dataDir('preferences.json');
  let preferences={favorite_color:'#00AAFF',brightness:30,night_brightness:20};
  if(fs.existsSync(file))preferences={...preferences,...JSON.parse(fs.readFileSync(file,'utf8'))};
  const ownerChat=chat=>chat?.kind==='private'&&api.isOwner(String(chat.userId))&&chat.chatId==='private:'+chat.userId;
  const hostFile=configuredHostFile??path.resolve(path.dirname(file),'../pet/host.json');
  const contextFile=api.dataDir('community-search-context.json');
  const workRunner=workFactory({file:voiceJobFile}),voiceRequests=new WeakMap(),workRequests=new WeakMap();
  const sendMessage=async(msg,text)=>{
    const work=workRequests.get(msg);if(work)await work.requireCurrent();
    const receipt=await api.sendText(msg.chatId,text);
    const voice=voiceRequests.get(msg);if(voice){voice.replies.push(text);voice.sent ||= delivered(receipt);}
    return receipt;
  };
  const recent=new Map(),approvals=new Map(),usedJobs=new Map(),latestTurn=new Map();
  const lifetime=10*60*1000;
  const session=msg=>msg.chatId+(msg.raw?.simulated?':simulated':'');
  const delivered=receipt=>receipt?.message_id!==undefined;
  const ask=api.ask?.bind(api);
  const errorLine=error=>String(error?.message||'请求失败。').split(/\r?\n/,1)[0].slice(0,160);
  const choosePrompt='你看中哪套？说它的名字、特点，或者告诉我你想要哪一套。';
  const renderSearch=async result=>{
    const slot=result.candidates[0]?.category===1001&&result.deviceInventory
      ?await suggestBoardSlot(result.deviceInventory,result.targetDevice):null;
    const message=communityVoiceMessage(result,{slot});
    return {result,spoken:message.spoken,message:result.candidates.length
      ?message.text+'\n\n'+(result.candidates.length===1?'想了解或试用这套的话，跟我说一声就行。':choosePrompt)
      :message.spoken};
  };
  const prune=()=>{
    for(const map of [usedJobs,recent,approvals])for(const [key,value] of map)if(value.until<=Date.now())map.delete(key);
  };
  const findCommunity=async(args,exec)=>renderSearch(await assistant.search({...args,fresh:true},exec));
  const persist=(key,context)=>{
    if(!/^private:\d+$/.test(key)||!api.isOwner(key.slice(8)))return;
    const temp=contextFile+'.tmp';
    try{
      fs.writeFileSync(temp,JSON.stringify({key,...context}),{mode:0o600});
      fs.renameSync(temp,contextFile);
    }catch{ /* A failed persistence attempt still leaves the active conversation usable. */ }
  };
  try{
    if(fs.statSync(contextFile).size<=65536){
      const {key,...context}=JSON.parse(fs.readFileSync(contextFile,'utf8'));
      if(/^private:\d+$/.test(key)&&api.isOwner(key.slice(8))&&Number.isFinite(context.until)&&context.until>Date.now()
        &&typeof context.result?.mode==='string'&&Array.isArray(context.result.candidates)
        &&context.result.candidates.length<=3&&context.result.candidates.every(item=>typeof item.title==='string'&&typeof item.shareCode==='string'))recent.set(key,context);
    }
  }catch{ /* A missing or invalid snapshot cannot supply an import target. */ }
  const remember=(key,result,receipt)=>{
    approvals.delete(key);
    const {mode,topic,category,targetDevice,availableDevices,note}=result;
    const candidates=result.candidates.slice(0,3).map(({category,title,author,shareCode,contentHash,device,facts,tags})=>
      ({category,title,author,shareCode,contentHash,device,facts,tags}));
    const shownAt=Date.now();
    const context={result:{mode,topic,category,targetDevice,availableDevices,note,candidates},shownAt,until:shownAt+lifetime,
      messageId:delivered(receipt)?String(receipt.message_id):undefined};
    recent.set(key,context);
    if(context.messageId)persist(key,context);
    return context;
  };
  function findKnownShare(reference,code){
    const name=normalizeTitle(reference??'');
    if(!code&&name.length<2)return undefined;
    const observations=Object.values(assistant.store?.read().observations??{});
    const matches=observations.filter(item=>item.category===1001&&['gt75','ace75'].includes(normalizeDevice(item.device).replace(/8k$/,''))
      &&item.source?.endpoint===COMMUNITY_URL&&(code?item.shareCode.toLowerCase()===code.toLowerCase():normalizeTitle(item.title).includes(name)));
    const exact=matches.filter(item=>normalizeTitle(item.title)===name);
    return exact.length===1?exact[0]:matches.length===1?matches[0]:undefined;
  }
  const proposalText=({best,target,slot,transaction})=>`「${best.title}」是这套，分享码 ${best.shareCode}。\n${communityBoardSummary(transaction)??shareExplanation(best)}\n${target} 现在用的是第 ${slot.activeSlot} 槽。建议存到第 ${slot.targetSlot} 槽，保留你正在用的配置。${transaction.profileName?`新槽名会显示为「${transaction.profileName}」。`:''}可以先备份第 ${slot.targetSlot} 槽，再覆盖并切换过去吗？`;
  const visiblePlan=(msg,plan)=>plan&&(!msg.replyId||String(msg.replyId)===plan.messageId)
    &&(msg.raw?.simulated||(api.core?.hub?.lastBotToOwner?.at??0)<=plan.shownAt);
  async function sendProposal(msg,plan,turn){
    const key=session(msg);
    approvals.delete(key);
    const receipt=await sendMessage(msg,proposalText(plan));
    if(delivered(receipt)&&latestTurn.get(key)===turn){
      approvals.set(key,{...plan,messageId:String(receipt.message_id),shownAt:Date.now()});
    }
  }
  async function select(msg,number,context,turn,requestedSlot){
    const {result}=context;
    const best=result.candidates.slice(0,3)[number-1],key=session(msg);
    if(!best)return '我还没对上你说的是哪套。你看中的是哪条，或者你记得它有什么特点？';
    approvals.delete(key);
    const target=result.targetDevice;
    const detail=`你选的是「${best.title}」，分享码 ${best.shareCode}。\n${shareExplanation(best)}`;
    if(result.mode!=='read-only')return detail+'\n这条来自历史记录。等社区恢复后重新搜索，就能核对线上分享。';
    if(best.category!==1001)return detail+'\n这类分享可以用分享码在 M HUB 查看，QQ 板载导入目前支持 GT75 / Ace 75 整套配置。';
    try{
      const current=await readSlot(target);
      if(!current)return detail+'\n暂时读不到目标键盘的板载槽位。请连接键盘并打开 M HUB，再重新选择这条。';
      const slot=requestedSlot===undefined?current:{...current,targetSlot:requestedSlot};
      const transaction=await prepareBoard(assistant,best,target,slot.targetSlot);
      if(latestTurn.get(key)!==turn||recent.get(key)!==context||context.until<=Date.now()||transaction.activeSlot!==slot.activeSlot)
        return '搜索结果或板载槽位已变化，请重新选择。';
      const plan={number,best,slot,target,transaction,until:Date.now()+lifetime};
      await sendProposal(msg,plan,turn);
      context.until=plan.until;
    }catch(error){
      return detail+'\n暂时不能生成板载导入确认。'+errorLine(error);
    }
  }
  async function confirm(msg,plan,turn){
    if(!ownerChat(msg))return '请在主人私聊确认社区配置。';
    if(msg.raw?.simulated)return '模拟消息不能写入板载配置。';
    if(api.config().dryRun||!api.config().enabled)return 'AuraBot 当前未启用实际操作，请检查运行状态。';
    const key=session(msg);
    const current=()=>latestTurn.get(key)===turn&&approvals.get(key)===plan&&plan.until>Date.now()&&visiblePlan(msg,plan);
    if(!current())return '这次导入建议已变化或过期，请重新选择分享。';
    if(plan.applying)return '这条配置正在检查或写入。';
    plan.applying=true;
    try{
      const {runtime,voice,game,live2d}=(await client.state()).controls??{};
      const phonePhase=voice?.phone?.phase;
      const ownWork=workRequests.get(msg),ownLighting=ownWork&&runtime?.communityTask?.id===ownWork.id;
      if(!runtime||(!ownLighting&&runtime.displayState!=='IDLE')||(ownLighting&&!['IDLE','SUCCESS'].includes(runtime.harnessTaskState))||runtime.preview||runtime.taskLighting?.active&&!ownLighting
        ||runtime.deviceAnimation?.active||runtime.manual||phonePhase&&!['idle','ended'].includes(phonePhase)
        ||live2d?.call||game?.active)
        return '桌面正在执行联动，请等它结束后再发这条确认指令。';
      if(ownWork)await ownWork.prepareWrite(plan.transaction.fingerprint?.productKey?.includes('12348')?'Ace 75 8K':'GT 75');
      const fresh=await prepareBoard(assistant,plan.best,plan.target,plan.slot.targetSlot);
      if(!current())return '配置确认已变化或过期，请重新选择。';
      if(JSON.stringify(fresh.fingerprint)!==JSON.stringify(plan.transaction.fingerprint)||fresh.profileName!==plan.transaction.profileName) {
        approvals.delete(key);
        return '键盘槽位或要写入的名称已变化，请重新选择分享。';
      }
      if(ownWork)await ownWork.requireCurrent();
      approvals.delete(key);
      const receipt=await applyBoard(assistant,plan);
      if(receipt.applied&&receipt.verified&&receipt.switched===false)return '已备份并写入板载第 '+plan.slot.targetSlot+' 槽，读回验证通过。自动切换失败，请在 M HUB 手动切换。';
      if(receipt.applied&&receipt.verified&&receipt.displaySynced===false)return '已写入并切换到板载第 '+plan.slot.targetSlot+' 槽，读回验证通过。M HUB 界面状态暂未刷新。';
      if(receipt.applied&&receipt.verified)return `已备份并写入板载第 ${plan.slot.targetSlot} 槽${receipt.profileName?`「${receipt.profileName}」`:''}，已切换过去并读回验证。`;
      if(receipt.changed)return '目标槽内容刚发生变化，请重新选择分享。';
      if(receipt.nameUnavailable)return 'M HUB 暂时无法保存目标槽的名称。请打开目标键盘页确认槽位状态，再重新选择分享。';
      if(receipt.busy)return '已有一项板载导入在执行，请完成后重新选择分享。';
      if(receipt.restored){
        const fields={setUserKeys:'键位',setTravelKeys:'触发行程',setFuncConfigStruct:'键盘功能和灯光参数',
          setAllKeysColor:'键灯颜色',setSelectedLightEffect:'键灯预设',setSideSelectedLightEffect:'第一侧灯预设',
          setSide2SelectedLightEffect:'第二侧灯预设',setAdvancedKeys:'高级键',setProfileNamesToAll:'槽位名称',setBase:'槽位切换'};
        const field=fields[receipt.failure?.method]||'板载配置';
        const issue=receipt.failure?.phase==='write'?'写入失败':'读回校验失败';
        return `第 ${plan.slot.targetSlot} 槽的${field}${issue}，已回滚并核对原配置。`;
      }
      if(receipt.unknown)return '驱动未返回写入结果。请在 M HUB 核对板载槽位，备份已保存。';
      return '写入失败，未能确认原配置已完全恢复。请在 M HUB 核对，备份已保存。';
    }catch(error){
      return '暂时无法完成导入。'+errorLine(error);
    }finally{plan.applying=false;}
  }
  async function handleCommunityMessage(msg){
    if(!ownerChat(msg))return false;
    const text=String(msg.text??'').trim(),key=session(msg);
    prune();
    let context=recent.get(key);
    const pending=approvals.get(key),turn={text,at:Date.now()};
    const plan=visiblePlan(msg,pending)?pending:undefined;
    if(pending&&!plan)approvals.delete(key);
    latestTurn.set(key,turn);
    if(!text||text.length>600){approvals.delete(key);return false;}
    const say=async reply=>{if(reply&&latestTurn.get(key)===turn)await sendMessage(msg,reply);};
    const searchHint=communitySearchHint(text,{allowShorthand:true});
    const retry=retrySearch.test(text),ordinal=ordinalChoice.exec(text)?.[1];
    const code=shareCodePattern.exec(text)?.[0];
    const reference=namedChoice.exec(text)?.[1];
    const strong=boardIntent.test(text)||code||Boolean(ordinal&&/(?:安装|装|导入)/.test(text));
    const quotedOtherList=()=>msg.replyId&&String(msg.replyId)!==context?.messageId;
    const newerUntrackedList=()=>{
      const last=api.core?.hub?.lastBotToOwner;
      const code=String(last?.text??'').match(shareCodePattern)?.[0];
      return !msg.raw?.simulated&&!msg.replyId&&last?.at>context?.shownAt&&code
        &&!context.result.candidates.some(item=>item.shareCode===code);
    };
    let intent,resolvedExplicitly=false;
    try{
      const explicit=context?.result.candidates.findIndex(item=>code?item.shareCode.toLowerCase()===code.toLowerCase():
        reference&&normalizeTitle(item.title)===normalizeTitle(reference));
      const known=!searchHint&&!cancellation.test(text)&&!(explicit>=0)&&!ordinal&&(code||reference)
        ?findKnownShare(reference,code):undefined;
      if(!context&&!searchHint&&!strong&&!retry&&!known)return false;
      if(context&&cancellation.test(text))intent={action:'cancel'};
      else if(retry&&!searchHint){
        if(!context?.result.topic){await say('你想让我再找哪个游戏或哪台设备的社区配置？');return true;}
        const {topic,category,targetDevice:device}=context.result;
        intent={action:'search',topic,category,device};
      }else if(!searchHint&&ordinal&&(context||strong)){
        if(!context?.messageId||quotedOtherList()||newerUntrackedList()){
          approvals.delete(key);
          await say('我没有能对应这个序号的候选列表。'+needsSelection);return true;
        }
        intent={action:'choose',index:Number(ordinal)||'一二三'.indexOf(ordinal)+1};
      }else if(!searchHint&&!cancellation.test(text)&&explicit>=0){
        resolvedExplicitly=true;
        intent={action:'choose',index:explicit+1};
      }else if(known){
        context=remember(key,{mode:'read-only',category:'keyboard-profile',targetDevice:known.device,candidates:[known]});
        resolvedExplicitly=true;
        intent={action:'choose',index:1};
      }else if(!context&&strong&&!searchHint){
        await say(needsSelection);return true;
      }else{
        intent=communityPttIntent(text)?{action:'search',topic:text}
          :await interpretCommunityReply(ask,{text,result:context?.result,plan});
      }
    }catch{
      if(!context&&!strong&&!searchHint)return false;
      await say(strong?needsSelection:'我刚才没能理解这句。你是想换一套，还是继续聊刚才的方案？');
      return true;
    }
    if(latestTurn.get(key)!==turn)return true;
    switch(intent.action){
      case 'search':{
        approvals.delete(key);
        try{
          const found=await findCommunity({topic:retry?intent.topic:communitySearchTopic(text,intent.topic),device:intent.device,category:intent.category});
          if(latestTurn.get(key)!==turn)break;
          const receipt=await sendMessage(msg,found.message);
          if(delivered(receipt)&&latestTurn.get(key)===turn)remember(key,found.result,receipt);
        }catch(error){await say('这次没查到社区结果。'+errorLine(error));}
        break;
      }
      case 'choose':
        if(context&&Number.isInteger(intent.index)&&intent.index>=1&&intent.index<=3&&(!quotedOtherList()||resolvedExplicitly))
          await say(await select(msg,intent.index,context,turn));
        else await say('我还没对上是哪套，你记得它的名字或特点吗？');
        break;
      case 'change-slot':
        if(context&&plan&&Number.isInteger(intent.slot)&&intent.slot>=1&&intent.slot<=4)
          await say(await select(msg,plan.number,context,turn,intent.slot));
        else await say('你想放哪个板载槽？我可以先核对。');
        break;
      case 'approve':{
        if(!plan){await say('先选一套，我核对好板载槽位再跟你确认。');break;}
        let approved=false;
        try{approved=await approvesCommunityWrite(ask,text,plan);}catch{}
        if(latestTurn.get(key)!==turn)return true;
        if(approved)await say(await confirm(msg,plan,turn));
        else await sendProposal(msg,plan,turn);
        break;
      }
      case 'cancel':
        approvals.delete(key);
        await say('好，先放着。想换一套或继续看，随时跟我说。');
        break;
      case 'clarify':
        if(plan)await sendProposal(msg,plan,turn);
        else await say(intent.clarification||(context?.result.mode.startsWith('needs-')?context.result.note
          :'你想了解哪套，或者更在意触发行程、键位还是灯效？'));
        break;
      default:
        approvals.delete(key);
        if(strong){await say(needsSelection);break;}
        return false;
    }
    return true;
  }
  async function runCommunityMessage(msg,id){
    prune();
    if(!ownerChat(msg))return false;
    const hasContext=recent.has(session(msg))||approvals.has(session(msg));
    if(!hasContext&&!communitySearchHint(msg.text,{allowShorthand:true})&&!boardIntent.test(msg.text??''))return handleCommunityMessage(msg);
    if(!workRunner)return handleCommunityMessage(msg);
    return workRunner.run(id??randomUUID(),async work=>{workRequests.set(msg,work);try{return await handleCommunityMessage(msg);}finally{workRequests.delete(msg);}});
  }
  api.on?.('message',async msg=>{try{return await runCommunityMessage(msg);}catch(error){if(ownerChat(msg)){await api.sendText(msg.chatId,errorLine(error));return true;}return false;}});
  api.on?.('reply',(reply,{chatId,userText}={})=>{
    if(typeof chatId!=='string'||!/^private:\d+$/.test(chatId)||!api.isOwner(chatId.slice(8)))return;
    const turn=latestTurn.get(chatId);
    if(turn?.searchDelivered&&turn.text===String(userText??'').trim()&&Date.now()-turn.at<120000)return null;
    if(/(?:没有|缺少|没接|未接).{0,24}执行器|只有只读|只能查不能写/u.test(reply)
      &&/(?:GT\s*75|M\s*HUB|社区|板载|分享码)/iu.test(reply+' '+userText))
      return 'GT75 / Ace 75 的整套社区配置支持在这里确认导入。'+needsSelection;
  });
  const currentJob=id=>{
    try{const job=JSON.parse(fs.readFileSync(voiceJobFile,'utf8'));return job.id===id&&job.active===true&&job.until>Date.now();}
    catch{return false;}
  };
  const voiceAuthorized=req=>{
    try{
      const token=JSON.parse(fs.readFileSync(hostFile,'utf8')).token,provided=req.headers?.['x-pet-token'];
      return !req.headers?.origin&&typeof token==='string'&&/^[a-f0-9]{32,80}$/.test(token)
        &&typeof provided==='string'&&provided.length===token.length
        &&timingSafeEqual(Buffer.from(token),Buffer.from(provided));
    }catch{return false;}
  };
  api.route('/voice-community-context',async req=>{
    if(!voiceAuthorized(req))return {ok:false,message:'本机语音请求未授权。'};
    prune();const key='private:'+String(api.config().ownerQQ??'');
    return {ok:true,active:recent.has(key)||approvals.has(key),until:Math.max(recent.get(key)?.until??0,approvals.get(key)?.until??0)};
  });
  api.route('/voice-community',async req=>{
    if(!voiceAuthorized(req))return {ok:false,message:'本机语音请求未授权。'};
    try{
      const input=await api.core.http.body(req);strict(input,['text','id','draft']);
      const {id,draft=false}=input;
      const text=normalizeCommunitySpeech(input.text);
      if(typeof text!=='string'||!text.trim()||text.length>600||typeof draft!=='boolean'||typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('请说说你想给哪个外设找什么样的配置。');
      prune();
      if(draft){
        if(!communitySearchHint(text))throw Error('预览只支持社区搜索，不会确认写入。');
        const intent=communityPttIntent(text)?{action:'search',topic:text}:await interpretCommunityReply(ask,{text});
        if(intent.action!=='search')return {ok:false,message:'我还没听清你想找哪种外设配置。'};
        const found=await findCommunity({topic:communitySearchTopic(text,intent.topic),device:intent.device,category:intent.category});
        return {ok:true,sent:false,spoken:found.spoken,draft:found.message};
      }
      if(!currentJob(id))throw Error('这次语音查询已取消。');
      if(usedJobs.has(id)||usedJobs.size>=50)throw Error('这次查询已处理或发送暂忙。');
      usedJobs.set(id,{until:Date.now()+180000});
      const owner=String(api.config().ownerQQ??'');
      if(!/^\d{5,14}$/.test(owner)||!api.isOwner(owner))throw Error('还没设置可接收结果的主人 QQ。');
      const msg={kind:'private',chatId:'private:'+owner,userId:owner,text:text.trim()};
      const output={replies:[],sent:false};voiceRequests.set(msg,output);
      let handled;
      try{handled=await runCommunityMessage(msg,id);}finally{voiceRequests.delete(msg);}
      return {ok:true,handled,sent:output.sent,spoken:output.replies.join('\n')||'',contextActive:recent.has(msg.chatId)||approvals.has(msg.chatId)};
    }catch(error){return {ok:false,message:String(error?.message||'社区查询失败。').slice(0,200)};}
  });
  const status=async()=>{
    const s=await client.state(),c=s.controls??{};
    return {ok:true,message:'迈从后台状态已读取。',panel:'http://127.0.0.1:18782/api/mhub-community/panel',sync:c.sync,screen:c.runtime?{page:c.runtime.shortcutPage,mode:c.runtime.screenMode,displayError:c.runtime.displayError}:null,balance:c.balance?{visible:c.balance.visible,live:c.balance.live,reason:c.balance.reason,view:c.balance.view}:null,devices:(c.syncInventory?.devices??[]).map(d=>({name:d.name,type:d.type,connected:d.connected,selected:d.selected})),preferences};
  };
  api.tool(({chat,sessionId})=>{
    if(!ownerChat(chat))return [];
    const tool=(name,description,properties,required,execute)=>api.defineTool({name,description,properties,required,render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}],execute:async(args,exec)=>{if(!ownerChat(chat))return {ok:false,message:'仅主人私聊可用。'};return execute(args,exec);}});
    const community=definitions(assistant).filter(t=>t.name!=='mhub_community_preview')
      .map(t=>tool(t.name,t.description,t.parameters.properties,t.parameters.required,async(args,exec)=>{
        const key=chat.chatId,turn=latestTurn.get(key);
        const data=await t.execute(t.name==='mhub_community_search'?{...args,fresh:true}:args,exec);
        if(t.name==='mhub_community_search'){
          data.candidates=data.candidates.slice(0,3);
          if(sessionId&&sessionId!=='sim'&&turn&&Date.now()-turn.at<120000&&latestTurn.get(key)===turn
            &&api.core?.hub?.turnHasOwner?.(sessionId)&&!turn.searchDelivery){
            turn.searchDelivery=true;
            const found=await renderSearch(data);
            if(latestTurn.get(key)===turn){
              const receipt=await api.sendText(key,found.message);
              if(delivered(receipt)&&latestTurn.get(key)===turn){
                turn.searchDelivered=true;
                remember(key,data,receipt);
              }
            }
          }
        }
        return {ok:true,boundary,data};
      }));
    return [...community,
      tool('desktop_status','读取大肥鱼迈从后台的真实连接、屏幕、余额灯带及设备状态。只读。',{},[],async args=>{strict(args,[]);return status();}),
      tool('mhub_desktop_action','主人明确要求时执行桌面动作：摸摸、颜色游戏、烟花、切屏、余额条、启动/停止联动。复用现有控制器；返回“请求已发送”只代表已提交，不得声称实物已完成。禁止自主循环触发。',{action:{type:'string',enum:ACTIONS}},['action'],async args=>{strict(args,['action']);return {ok:true,submitted:true,...await client.action(args.action)};}),
      tool('mhub_task_light_preview','主人要求试用时，播放已保存的三种任务灯光之一，8 秒后自动恢复原灯效。不会保存或修改任务参数。',{state:{type:'string',enum:['IDLE','BUSY','ATTENTION']}},['state'],async args=>{strict(args,['state']);if(!['IDLE','BUSY','ATTENTION'].includes(args.state))throw Error('未知状态。');const s=await client.state(),style=s.controls?.groups?.taskLights?.values?.[args.state];if(!style)throw Error('读不到已保存的状态灯光参数。');return {ok:true,seconds:8,...await client.preview(args.state,style)};}),
      tool('desktop_emotion','主人要求时用迈从灯光表达一次情绪，复用原生八秒试用，结束自动恢复。calm 平静、happy 开心、shy 害羞、comfort 安慰、thinking 思考、sleepy 困倦。不会重新启动旧 AstrBot 灯光进程。',{mood:{type:'string',enum:Object.keys(moods)}},['mood'],async args=>{
        strict(args,['mood']);const mood=moods[args.mood];if(!mood)throw Error('未知情绪。');
        const s=await client.state();if(s.controls?.runtime?.manual)return {ok:false,message:'你手动接管了 M HUB 灯光；请明确要求重新试用后使用 mhub_task_light_preview，不自动覆盖。'};
        const hour=new Date().getHours(),brightness=Math.min(preferences.brightness,hour>=23||hour<8?preferences.night_brightness:50);
        const style={label:mood[0],color:['calm','thinking'].includes(args.mood)?preferences.favorite_color:mood[1],effect:mood[2],brightness,speed:1};
        return {ok:true,seconds:8,...await client.preview('IDLE',style)};
      }),
      tool('desktop_preferences','查看或保存主人的情绪灯光偏好；仅主人明确要求修改时填写。此项不修改任务灯光或设备当前状态。亮度及夜间亮度 1~50。',{color:{type:'string'},brightness:{type:'integer',minimum:1,maximum:50},night_brightness:{type:'integer',minimum:1,maximum:50}},[],async args=>{
        strict(args,['color','brightness','night_brightness']);const next={...preferences};
        if(args.color!==undefined){if(!/^#[0-9a-f]{6}$/i.test(args.color))throw Error('颜色需为 #RRGGBB。');next.favorite_color=args.color.toUpperCase();}
        for(const key of ['brightness','night_brightness'])if(args[key]!==undefined){if(!Number.isInteger(args[key])||args[key]<1||args[key]>50)throw Error('亮度范围 1~50。');next[key]=args[key];}
        if(Object.keys(args).length){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(next,null,2));fs.renameSync(temp,file);preferences=next;}
        return {ok:true,preferences,message:'情绪灯光偏好已读取或保存；当前设备场景未改变。'};
      })];
  });
  api.context(({chat})=>ownerChat(chat)?[
    '听到找、整理或推荐外设配置的自然问法时，即使没提“社区”，也先调用 mhub_community_search。把需求归纳成明确的游戏或用途；型号已明确时传 device，不要把点名的设备换成另一台。只在工具提示型号或类别不明确时追问。',
    '按工具返回的候选顺序编号，列出真实型号、分享码、作者、标签和筛选理由。未读到的参数不要猜；缓存和在线结果分别说明。用户可以用名称、特点或随口指代来选。',
    'GT75 / Ace 75 板载导入由私聊流程根据上下文确认。选中某条分享只是选择；用户要先知道槽位和覆盖动作。不要要求固定口令、替主人同意或把预检说成已写入。',
    '主人明确要求桌面动作时可用 desktop_emotion 或 mhub_desktop_action；先查 desktop_status，按真实返回说明。任务灯光、余额、音箱动画、鼠标宏、语音与电话复用本机后台。不得把已提交说成实物完成，不得自主修改偏好。',
  ].join('\n'):'' );
  api.command({name:'桌面状态',desc:'查看迈从联动状态',run:async(_arg,msg)=>ownerChat(msg)?JSON.stringify(await status()):'请在主人私聊中查询桌面状态。'});
  api.route('/status',async()=>({ok:true,provider:'aurabot',sharedBackend:true,moduleVersion:MHUB_MODULE_VERSION,dryRun:api.config().dryRun,enabled:api.config().enabled}));
  return {status:()=>({provider:'aurabot',sharedBackend:true})};
 }};
}
export default createMhubModule();
