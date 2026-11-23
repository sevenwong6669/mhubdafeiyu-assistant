// Screen ownership stays in voice-screen.json; this only chooses the idle line.
export function callPresence({status,updatedAt=0,phone,now=Date.now()}={}){
 const fresh=!!status&&now-updatedAt>=0&&now-updatedAt<10000;
 const call=fresh&&status.call===true;
 const watching=fresh&&status.watch===true;
 const localCall=phone?.phase==='connected';
 if(!call&&!watching&&!localCall)return null;
 let text;
 if(watching){
  const capture=status.watchStatus?.capture;
  const ready=capture?.phase==='running'&&now-Number(capture.lastFrameAt||0)<15000;
  const watchText=ready?'陪看开启中':capture?.phase==='failed'?'陪看暂不可用':capture?.phase==='retrying'?'陪看重试中':'陪看准备中';
  text=call||localCall?'通话中·'+watchText:watchText;
 }else text=status?.nativeCall?.phase==='connecting'?'正在接通电话':'通话中·听你说';
 return {active:true,kind:'presence',text,key:'presence-'+text,playbackTimed:true};
}

export function canShowPresence({speech=false,queueBusy=false,request=false,nativeTurn=false,playing=false,producing=false,ttsOperation=false}={}){
 return !speech&&!queueBusy&&!request&&!nativeTurn&&!playing&&!producing&&!ttsOperation;
}
