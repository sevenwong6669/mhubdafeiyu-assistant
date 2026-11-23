import {captureIntent,checkIntent,cancelLocalIntent} from './device-intent.mjs?v=device-link-1';
import {queueDefaultTheme} from './device-asset-import.mjs?v=device-link-1';

export const DEFAULT_THEME_RULE='用户说恢复默认大肥鱼主题、恢复大肥鱼动画、切回大肥鱼时，QQ使用qq_restore_dafeiyu_theme，客户端使用mhub_restore_dafeiyu_theme。它恢复的是设备上的大肥鱼动画与灯效，不是网页外观。不要重新生图，不要用停止RGB动画工具代替音箱恢复，不要重置用户配置或删除素材。只按工具回执说明恢复结果；如正在通话/语音/游戏，提示结束后重试。';
export function defaultThemeTool(api,{local=false,where,restore=queueDefaultTheme}={}){
 return {...api.defineTool({name:local?'mhub_restore_dafeiyu_theme':'qq_restore_dafeiyu_theme',description:'恢复设备默认大肥鱼主题：停止生成的键盘/神光同步动画，恢复接管前灯效，让K20 GT回到原版大肥鱼待命动画与快捷页。保留独立余额条、素材与用户参数，不收费、不重置网页外观。通话/语音/游戏时不抢占。',properties:{},required:[],render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}],execute:async args=>{
  try{
   if(!local&&(where?.chat?.kind!=='private'||!api.isOwner(String(where.chat.userId))||!api.core.hub.turnSendersAllOwner(where.sessionId)))throw Error('仅限主人私聊操作。');
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw Error('恢复主题不接受额外参数。');
   cancelLocalIntent();const result=await restore();return {ok:true,...result,paidCalls:0,message:'已恢复默认大肥鱼动画与设备灯效，余额灯条和生成素材已保留。'};
  }catch(error){return {ok:false,restored:false,message:error.message};}
 }}),timeoutMs:155000};
}
