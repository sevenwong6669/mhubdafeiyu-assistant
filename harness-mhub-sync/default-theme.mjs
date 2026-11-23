// One controller transaction for every caller. Never reset user preferences,
// delete generated assets or let another process write to the speaker.
export async function restoreDefaultTheme({busy,clip,alreadyInstalled=false,prepare,stopRgb,stopTask,block,install,display,verify,commit,unblock}){
 if(busy)throw Error('正在通话、语音或游戏，请结束后再恢复大肥鱼主题。');
 if(!clip||clip.id!=='idle'||clip.frames!==12)throw Error('默认大肥鱼动画不可用，未更改设备。');
 await prepare(clip);
 const lights=await stopRgb();await stopTask();
 await block();
 try{
  const upload=alreadyInstalled?null:await install(clip);
  await display();const screen=await verify(clip);
  if(!screen?.verified)throw Error('大肥鱼主题设备读回未通过，未保存为恢复成功。');
  await commit(clip);
  return {restored:true,theme:'dafeiyu',resident:clip.id,screenVerified:true,uploaded:!!upload,lights,screen,assetsPreserved:true};
 }finally{await unblock();}
}
