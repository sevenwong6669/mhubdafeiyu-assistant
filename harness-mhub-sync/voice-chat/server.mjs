import {runtime} from '../../runtime-paths.mjs';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Sentences,pages,spokenReply,spokenUtterances} from './text.mjs';
import {mouseMode} from './mouse.mjs';
import {nativeReadiness} from './native-readiness.mjs';
import {nativeInputState,inputRetryAt,nativeRecoveryPlan} from './native-input-state.mjs';
import {inspectSpeechOutput} from '../live2d-speech-output.mjs';
import {SpeechAttempts} from './attempts.mjs';
import {captionOptions,captionPageOptions} from '../subtitles.mjs';
import {writeJson} from '../resilience.mjs';
import {PhoneService} from '../phone/service.mjs';
import {SpeechCaptionQueue,captionReadMs} from './caption-queue.mjs';
import {callPresence,canShowPresence} from './call-presence.mjs';
import {stopVoiceChild as stopChild} from './process-tree.mjs';
import {TtsRuntime} from './tts-runtime.mjs';
import {SpeechJobs,idleForShutdown} from './speech-jobs.mjs';
import {ExternalSpeech,validatePlaybackEvent} from './external-speech.mjs';
import {PttSpeech,prepareVoiceWorkers,waitForPlaybackPrepared,discardAudioFiles} from './ptt-speech.mjs';
import {onceOwnedStop,PlaybackDeadline,PlaybackDeviceTracker,StreamPackets,playRecoverableStream} from './stream-playback.mjs';
import {VoiceDeviceCommands,parseDeviceCommand} from './device-commands.mjs';
import {configureVoiceNetwork,probeImageNetwork} from './network.mjs';
import {live2dChannel} from '../live2d-channel.mjs';
import {communitySearchHint} from '../../mhub-community-assistant/community-voice.mjs';
import {readDeviceLink,requireDeviceLink} from '../device-link-mode.mjs';
import {runtimeVersion} from '../runtime-version.mjs';
requireDeviceLink();
const voiceNetwork=configureVoiceNetwork();
const root=fileURLToPath(new URL('./',import.meta.url)),parent=new URL('../',import.meta.url);
const cfg=JSON.parse(await fs.readFile(new URL('config.json',import.meta.url),'utf8'));
const captionPages=text=>pages(text,captionPageOptions(cfg));
const useLive2d=cfg.voiceChannel==='live2d';
const live2d=useLive2d?live2dChannel():null;
const communityChannel=live2d??live2dChannel();
const communityTaskFile=new URL('voice-community-task.json',parent);
const useIme=!useLive2d&&cfg.asrProvider==='doubao-ime';
const nativeStatusFile=useIme?'ime-status.json':'native-status.json';
let useStream=false;
const ttsPython=runtime.ttsPython,asrPython=runtime.asrPython;
await fs.mkdir(root+'/cache',{recursive:true});
const state={version:runtimeVersion(),startedAt:Date.now(),network:voiceNetwork,phase:'加载语音模型',ready:false,nativeReady:false,request:null,input:'',reply:'',error:null,ttsProvider:cfg.ttsProvider||'indextts2'};
let native=null,nativeTurn=null,nativePhase=null,nativeSince=0,nativeSeq=0,nativeMouseRetry=null,nativeTextTurn=null;
const speechSegments=()=>new Sentences({minimum:useStream?8:0});
let generation=0,player=null,sentences=speechSegments(),pending=[],audio=[],producing=false,playing=false,ended=false,characters=0,streamReady=false,closing=false,screenTail=Promise.resolve(),screenCurrentKey=null;
let turnTiming=null,phone=null;
let communityTurn=null,communityStatusTail=Promise.resolve();
function communityStatus(value){
  const update=communityStatusTail.then(()=>writeJson(communityTaskFile,value));
  communityStatusTail=update.catch(()=>{});
  return update;
}
let live2dTurn=null,live2dTimer=null,leaseId=null,refreshingLive2d=false,live2dFailures=0;
const live2dSpeechJobs=new SpeechJobs();
let nextAsrPreparation=0;
let live2dSnapshot=null,live2dUpdatedAt=0,externalPlaying=false,externalPlaybackUntil=0;
const speechRate=()=>{const n=Number(cfg.live2dSpeechRate??1);return Number.isFinite(n)&&n>=.75&&n<=1.5?n:1;};
state.live2dSpeechRate=speechRate();
function idlePresence(){return closing?null:callPresence({status:live2dSnapshot,updatedAt:live2dUpdatedAt,phone:phone?.snapshot()});}
function presenceAvailable(){if(externalPlaying&&Date.now()>externalPlaybackUntil)externalPlaying=false;return canShowPresence({speech:externalPlaying,queueBusy:!!spokenCaptions.runner||!!spokenCaptions.queue.length,request:state.request,nativeTurn,playing,producing,ttsOperation:state.ttsOperation});}
async function syncPresence(){
 if(closing||!presenceAvailable())return;
 const hint=idlePresence();
 if(hint&&(!screenCurrentKey||screenCurrentKey.startsWith('presence-')))await screen({...hint,g:generation});
 else if(!hint&&screenCurrentKey?.startsWith('presence-'))await screen({active:false});
}
state.channel=useLive2d?'live2d':'legacy';
async function refreshLive2d(){
  if(closing||refreshingLive2d)return;
  refreshingLive2d=true;
  try{
    const status=await live2d.status();
    live2dSnapshot=status;live2dUpdatedAt=Date.now();
    streamReady=status.asr===true;state.deviceCommand=status.deviceCommand;for(const note of status.deviceNotices??[]){state.seenDeviceNotes??=[];if(!state.seenDeviceNotes.includes(note.id)&&Date.now()-note.at<120000){state.seenDeviceNotes.push(note.id);deviceNotices.push(note);}state.seenDeviceNotes=state.seenDeviceNotes.slice(-16);}
    state.asrProvider=status.provider;
    state.asrDevice='迈从大肥鱼 · 本地识别';
    state.channelError=streamReady?null:status.asrError||'内部伙伴正在准备本地语音识别。';
    if(!streamReady&&['sensevoice-local','internal'].includes(status.provider)&&['unprepared','failed','stopped'].includes(status.asrPhase)&&Date.now()>=nextAsrPreparation){
      nextAsrPreparation=Date.now()+60000;
      await live2d.prepareRecognition();
    }
    const id=leaseId;
    if(id&&leaseId===id&&phone?.active){
      const c=status.nativeCall;
      if(!status.online||!c||c.id!==id||c.phase==='ended'||c.phase==='failed'){
        if(c?.phase==='failed')await phone.fail(id,Error(c.error||'Live2D 麦克风未就绪'));
        else await phone.end('live2d-ended');
        return;
      }
      await live2d.nativeCall(id,'renew');
      if(leaseId!==id)return;
      state.input=c.input;state.reply=c.reply;state.phoneVoiceError=state.playbackError?.message||c.speechError||null;
    }
    live2dFailures=0;
  }catch(error){
    streamReady=false;state.channelError=error.message;
    if(++live2dFailures>=3&&leaseId&&phone?.active)await phone.end('live2d-disconnected').catch(()=>{});
  }finally{refreshingLive2d=false;void syncPresence().catch(error=>{state.captionError=error.message;});}
}
async function connectNativeCall({id,video,silenceMs,current}){
  let status=await live2d.status();
  if(!current())return;
  if(!status.online){
    await live2d.launch();
    const deadline=Date.now()+20000;
    while(current()&&!status.online&&Date.now()<deadline){
      await sleep(400);
      status=await live2d.status();
    }
  }
  if(!current())return;
  if(!status.online)throw Error('Live2D 桌宠未能上线，请检查桌宠状态。');
  state.input='';state.reply='';state.phoneVoiceError=null;live2dFailures=0;
  try{
    await live2d.nativeCall(id,'start',{video,silenceMs});
    if(!current()){await live2d.nativeCall(id,'stop');return;}
    leaseId=id;
    const deadline=Date.now()+12000;
    while(current()&&Date.now()<deadline){
      const {nativeCall:c}=await live2d.status();
      if(c?.id!==id||c.phase==='ended')throw Error('Live2D 电话已挂断。');
      if(c.phase==='connected'){state.phase='通话中，听你说';return;}
      if(c.phase==='failed')throw Error('Live2D 麦克风打不开：'+c.error);
      await sleep(300);
    }
    if(current())throw Error('Live2D 麦克风未在限时内就绪。');
  }catch(error){
    if(leaseId===id)leaseId=null;
    await live2d.nativeCall(id,'stop').catch(()=>{});
    throw error;
  }
}
async function recognizeAudio(file,bytes){
  if(!useLive2d)return asr.run({file});
  const value=await live2d.recognize(bytes??await fs.readFile(file));
  return {text:value.heard,asrProvider:'sensevoice-local',asrDevice:'迈从大肥鱼 · 本地识别'};
}
const deviceNotices=[];
const deviceCommands=useLive2d?{snapshot:()=>null,close(){}}:new VoiceDeviceCommands({waitForDisplay:waitForDeviceDisplay,onUpdate:value=>{state.deviceCommand=value;},onNotice:text=>{if(!closing)deviceNotices.push({text,at:Date.now()});}});
state.deviceCommand=deviceCommands.snapshot();
async function waitForDeviceDisplay({restoreDefault=false}={}){
 const until=Date.now()+30000;let idleSince=null;
 while(!closing&&Date.now()<until){
  if(phone?.active)throw Error(restoreDefault?'请结束通话后再说“恢复默认大肥鱼主题”。':'动画已保存，请结束通话后说“应用刚才的动画”。');
  let caption,control;try{caption=JSON.parse(await fs.readFile(new URL('voice-screen.json',parent),'utf8'));control=JSON.parse(await fs.readFile(new URL('control-status.json',parent),'utf8'));}catch{}
  if(!state.request&&!nativeTurn&&!playing&&!producing&&!caption?.active&&control?.screenFeedback?.phase!=='voice'){idleSince??=Date.now();if(Date.now()-idleSince>=500)return;}else idleSince=null;
  await sleep(250);
 }
 throw Error(restoreDefault?'请等当前语音结束后再说“恢复默认大肥鱼主题”。':'素材已保存，请等当前语音结束后说“应用刚才的动画”。');
}
function localDeviceReply(text){state.request=randomUUID();state.reply=text;state.phase='设备指令';sentences=speechSegments();characters=0;ended=true;enqueue(sentences.push(text,true));void finish();}
const deviceNoticeTimer=setInterval(()=>{
 if(closing||!state.ready||state.request||nativeTurn||playing||producing||phone?.active||!deviceNotices.length)return;
 const note=deviceNotices.shift();if(Date.now()-note.at>300000)return;localDeviceReply(note.text);
},500);
function timing(event,extra={}){console.log(JSON.stringify({event,g:generation,at:Date.now(),...extra}));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let playbackWorkerRevision=0;
function worker(python,mode,configFile=null,{fatal=true}={}){
  const revision=mode==='stream-player'?++playbackWorkerRevision:0;
  const outputState=value=>{if(revision&&revision===playbackWorkerRevision)state.playbackOutput={workerPid:child.pid,at:Date.now(),...value};};
  let disposed=false;
  const child=spawn(python,['-X','utf8',root+'/worker.py',mode,...(configFile?['--config',configFile]:[])],{windowsHide:true,stdio:['pipe','pipe','inherit']});
  const stopWorker=onceOwnedStop(child,stopChild);
  let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});const jobs=new Map();
  let failure,stage='启动进程',startupTimer,healthTimer,outputReady=false,lastHealthAt=0;
  const armHealth=()=>{clearTimeout(healthTimer);healthTimer=setTimeout(()=>expire('播放输出没有有效回调'),6000);};
  state.workerStages??={};
  function setStage(value){
    stage=value;state.workerStages[mode]={stage,at:Date.now()};
    clearTimeout(startupTimer);
    startupTimer=setTimeout(()=>expire('加载超时'),mode==='stream-player'?20000:180000);
  }
  function failed(error){
    if(failure)return;
    failure=error;clearTimeout(startupTimer);clearTimeout(healthTimer);outputReady=false;outputState({phase:'failed',ready:false,error:error.message});readyReject(error);
    for(const job of jobs.values()){clearTimeout(job.timer);job.deadline?.close();job.reject(error);}
    jobs.clear();
    if(!closing&&!disposed&&fatal){state.ready=false;state.error=error.message;state.phase='语音服务停止';}
  }
  function expire(reason){failed(Error(mode+' '+stage+'：'+reason));void stopWorker().catch(error=>{state.cleanupError=error.message;});}
  setStage(stage);
  createInterface({input:child.stdout}).on('line',line=>{
    if(failure)return;
    let row;try{row=JSON.parse(line);}catch{return;}
    if(row.event==='startup-error'){state.workerStages[mode]={stage:'加载失败',at:Date.now()};failed(Error(row.error||mode+' 模型初始化失败'));return;}
    if(row.event==='stage'){setStage(row.stage);return;}
    if(mode==='stream-player'&&row.event==='output-health'){
      if(row.ready!==true||!Number.isFinite(row.callbackFrames)||row.callbackFrames<=0){expire(row.error||'播放输出已失效');return;}
      outputReady=true;lastHealthAt=Date.now();outputState({phase:'ready',ready:true,callbackAgeMs:row.callbackAgeMs,callbackFrames:row.callbackFrames,error:null});armHealth();return;
    }
    if(row.event==='ready'){
      setStage('就绪');clearTimeout(startupTimer);
      if(mode==='stream-player'){outputReady=true;lastHealthAt=Date.now();outputState({phase:'ready',ready:true,error:null});armHealth();}
      if(mode==='tts'&&fatal){state.ttsProvider=row.provider;state.ttsVoice=row.voice||'大肥鱼迷糊版本地音色';}
      if(mode==='asr'){state.asrProvider=row.provider;state.asrDevice=row.device;state.asrModelTier=row.asrModelTier;}
      readyResolve();return;
    }
    const job=jobs.get(row.id);if(!job)return;
    if(row.event){try{job.deadline?.progress(row);job.progress?.(row);}catch(error){jobs.delete(row.id);clearTimeout(job.timer);job.deadline?.close();job.reject(error);}return;}
    jobs.delete(row.id);clearTimeout(job.timer);job.deadline?.close();
    row.error?job.reject(Object.assign(Error(row.error),{audio:row.audio})):job.resolve(row);
  });
  child.stdin.on('error',failed);
  child.on('error',failed);child.on('exit',code=>failed(Error(mode+' worker exited: '+code)));
  return {child,ready,isAlive:()=>!failure&&!disposed,outputReady:()=>outputReady&&!failure&&!disposed&&Date.now()-lastHealthAt<6000,dispose(){disposed=true;failed(Error('合成工作进程已结束'));return stopWorker();},write(data){if(!failure)child.stdin.write(JSON.stringify(data)+'\n');},async run(data,progress){
    await ready;if(failure)throw failure;
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=mode==='stream-player'?null:setTimeout(()=>expire('处理任务超时'),120000);
      const deadline=mode==='stream-player'?new PlaybackDeadline(error=>expire(error.message)):null;
      jobs.set(id,{resolve,reject,progress,timer,deadline});
      child.stdin.write(JSON.stringify({...data,id})+'\n');
    });
  }};
}
const createTts=()=>new TtsRuntime({root,config:cfg,worker:(file,mode='tts')=>worker(ttsPython,mode,file,{fatal:false}),onState:value=>{state.tts=value;state.ttsProvider=value.provider;state.ttsVoice=value.voice;useStream=value.streaming;}});
let tts=createTts();
useStream=tts.streaming;
let asr=useIme||useLive2d?null:worker(asrPython,'asr');
if(useIme){state.asrProvider='doubao-ime';state.asrDevice='豆包输入法客户端';}
let streamPlayer=worker(ttsPython,'stream-player',null,{fatal:false});
let playerResetTask=null;const playbackDevice=new PlaybackDeviceTracker();
async function refreshPlaybackDevice(){
 try{
  const health=JSON.parse(await fs.readFile(new URL('controller-health.json',parent),'utf8'));
  if(playbackDevice.observe(health,cfg.outputName==='__default__'||/MCHOSE K20 GT/i.test(cfg.outputName??'')))runtimeRetryAt=0;
 }catch{}
}
async function resetStreamPlayer(expected=streamPlayer){
 if(playerResetTask)return playerResetTask;
 if(expected&&expected!==streamPlayer)return streamPlayer;
 const revision=playbackDevice.revision;
 const task=(async()=>{
  await streamPlayer?.dispose();if(closing)throw Error('语音服务已停止');
  const next=worker(ttsPython,'stream-player',null,{fatal:false});streamPlayer=next;
  await next.ready;if(closing)throw Error('语音服务已停止');playbackDevice.applied(revision);return next;
 })();playerResetTask=task;
 try{return await task;}finally{if(playerResetTask===task)playerResetTask=null;}
}
async function playbackPlayer(){
 for(let attempt=0;attempt<2;attempt++){
  await refreshPlaybackDevice();
  if(playerResetTask)await playerResetTask;
  if(playbackDevice.needsReset||!streamPlayer?.isAlive()||!streamPlayer.outputReady())await resetStreamPlayer();
  if(!playbackDevice.needsReset)return streamPlayer;
 }
 throw Error('播放设备仍在连接，请稍后重试。');
}
async function prepareWorkers(){
  const prepared=await prepareVoiceWorkers({
    closing:()=>closing,prepare:()=>Promise.all([tts.ready(),asr?.ready,streamPlayer?.ready]),
    failed:error=>{state.error=error.message;},reset:async()=>{
      await Promise.all([tts.close(),stopChild(asr?.child),streamPlayer?.dispose()]);
      if(closing)return;
      state.phase='正在重试加载语音模型';
      tts=createTts();useStream=tts.streaming;
      asr=useIme||useLive2d?null:worker(asrPython,'asr');
      streamPlayer=worker(ttsPython,'stream-player',null,{fatal:false});
    },
  });
  if(!prepared||closing)return;
  state.ready=true;state.error=null;state.phase='按住后侧键说话';
  await startNative();
}
let initialPreparationDone=false,runtimeRepairing=false,runtimeRepairFailures=0,runtimeRetryAt=0;
void prepareWorkers().catch(error=>{state.error=error.message;}).finally(()=>{initialPreparationDone=true;});
async function repairRuntime(){
  if(closing||!initialPreparationDone||runtimeRepairing)return;
  // The hook can remain alive while capture_loop retries a missing device.
  // Observe its current generation rather than retaining the startup snapshot.
  const child=native;let input=nativeInputState({child,status:nativeCaptureStatus,parent:process.pid,useIme});
  try{
    const status=JSON.parse(await fs.readFile(root+'/'+nativeStatusFile,'utf8'));
    const observed=nativeInputState({child,status,parent:process.pid,useIme});
    if(native===child&&observed.matches){
      const recovered=!input.captureReady&&observed.captureReady,previousError=nativeCaptureStatus?.error??state.nativeError;
      nativeCaptureStatus=status;input=observed;inputBinding();
      if(recovered){
        runtimeRetryAt=0;runtimeRepairFailures=0;state.inputRecovery=null;
        if(state.error===previousError)state.error=null;
        if(!phone?.active&&!nativeTurn)try{await mouseMode(true,useIme?'doubao-ime':'native');inputBinding();}catch(error){inputBinding(error);}
      }
    }
  }catch{/* Missing or half-written status is not another process's readiness. */}
  await refreshPlaybackDevice();
  const asrFailed=!useIme&&!useLive2d&&!asr?.isAlive(),playerFailed=playbackDevice.needsReset||!streamPlayer?.isAlive(),ttsFailed=!state.ready;
  const inputFailed=!input.captureReady;
  if(!asrFailed&&!playerFailed&&!inputFailed&&!ttsFailed)return;
  if(playerFailed&&!asrFailed&&!ttsFailed){
    // Active playback owns its one retry; idle repair never cancels a call.
    if(playing||playerResetTask||Date.now()<runtimeRetryAt)return;
    runtimeRepairing=true;state.playbackRecovery={phase:'recovering',at:Date.now()};
    try{await resetStreamPlayer();runtimeRepairFailures=0;runtimeRetryAt=0;state.playbackRecovery=null;if(!state.request&&!phone?.active)state.phase='按住后侧键说话';}
    catch(error){runtimeRepairFailures++;runtimeRetryAt=inputRetryAt(runtimeRepairFailures,Date.now());state.playbackRecovery={phase:'waiting',error:error.message,nextRetryAt:runtimeRetryAt};}
    finally{runtimeRepairing=false;}return;
  }
  // Live2D owns its call microphone independently. A missing PTT input must not
  // hang up that call or restart otherwise healthy synthesis/recognition.
  const inputOnly=!asrFailed&&!playerFailed&&!ttsFailed;
  const plan=nativeRecoveryPlan({captureReady:input.captureReady,inputOnly,phoneActive:phone?.active,turnActive:!!nativeTurn,now:Date.now(),retryAt:runtimeRetryAt});
  if(plan==='wait-idle'){state.inputRecovery={phase:'waiting-idle',error:input.error||'按住说话的麦克风尚未就绪。'};return;}
  if(plan==='backoff')return;
  if(inputOnly){
    runtimeRepairing=true;
    try{
      clearTimeout(nativeMouseRetry);await stopChild(native);native=null;nativeCaptureStatus=null;inputBinding();
      if(closing)return;
      if(phone?.active||nativeTurn){state.inputRecovery={phase:'waiting-idle'};return;}
      await startNative();runtimeRepairFailures=0;runtimeRetryAt=0;state.inputRecovery=null;
      if(!phone?.active&&!state.request){state.error=null;state.phase='按住后侧键说话';}
    }catch(error){
      runtimeRepairFailures++;runtimeRetryAt=inputRetryAt(runtimeRepairFailures,Date.now());
      state.inputRecovery={phase:'waiting',error:error.message,nextRetryAt:runtimeRetryAt,failures:runtimeRepairFailures};
      if(!phone?.active)state.error=error.message;
    }finally{runtimeRepairing=false;}
    return;
  }
  runtimeRepairing=true;state.ready=false;state.phase='正在修复语音组件';
  try{
    // Cancel the old turn; a restarted recognizer must only hear fresh audio.
    if(phone?.active)await phone.end('engine-recovery');else await interrupt();
    if(asrFailed){await asr?.dispose();asr=worker(asrPython,'asr');}
    if(playerFailed)await resetStreamPlayer();
    await Promise.all([tts.ready(),asr?.ready,streamPlayer?.ready]);
    if(closing)return;
    if(inputFailed){clearTimeout(nativeMouseRetry);await stopChild(native);await startNative();}
    state.ready=true;state.error=null;state.phase='按住后侧键说话';runtimeRepairFailures=0;state.recovery=null;
  }catch(error){
    runtimeRepairFailures++;runtimeRetryAt=Date.now()+Math.min(60000,2000*2**Math.min(runtimeRepairFailures,5));
    state.error=error.message;state.recovery={phase:'waiting',nextRetryAt:runtimeRetryAt,failures:runtimeRepairFailures};
  }finally{runtimeRepairing=false;}
}
let mouseCheckAt=0,mouseChecking=false,nativeCaptureStatus=null,nativeStartTask=null;
function inputBinding(error=null){Object.assign(state,nativeReadiness(nativeCaptureStatus,error??(!nativeCaptureStatus?.captureReady?nativeCaptureStatus?.error:null)));}
async function repairMouseBinding(){
  if(closing||!initialPreparationDone||!state.ready||!nativeCaptureStatus?.captureReady||mouseChecking||nativeTurn||phone?.active||Date.now()<mouseCheckAt)return;
  mouseChecking=true;mouseCheckAt=Date.now()+15000;
  try{await mouseMode(true,useIme?'doubao-ime':'native');inputBinding();}
  catch(error){inputBinding(error);mouseCheckAt=Date.now()+3000;}
  finally{mouseChecking=false;}
}
const runtimeRepairTimer=setInterval(()=>{void repairRuntime();void repairMouseBinding();},2000);
async function startNative(){
  if(nativeStartTask)return nativeStartTask;
  const task=startNativeOnce();nativeStartTask=task;
  try{return await task;}finally{if(nativeStartTask===task)nativeStartTask=null;}
}
async function startNativeOnce(){
  const launchToken=randomUUID();
  const child=useIme
    ?spawn(root+'/ImeBridge.exe',['--parent',String(process.pid),'--hold',String(cfg.holdMilliseconds||250)],{windowsHide:false,stdio:['ignore','ignore','inherit']})
    :spawn(ttsPython,['-X','utf8',root+'/native_ptt.py','--parent',String(process.pid),'--launch-token',launchToken],{windowsHide:true,stdio:['ignore','ignore','inherit']});
  child.dafeiyuLaunchToken=launchToken;native=child;
  let failure=null;
  child.on('error',e=>{failure=e;if(native===child&&!phone?.active)state.error=e.message;});
  child.on('exit',()=>{if(native!==child)return;nativeCaptureStatus=null;inputBinding();state.nativeReady=false;if(!closing&&!phone?.active)state.error='鼠标语音监听已停止，正在等待自动恢复。';});
  try{
  const deadline=Date.now()+20000;let status;
  while(Date.now()<deadline){
    if(closing||native!==child)throw Error('麦克风监听启动已取消。');
    if(failure)throw failure;
    try{status=JSON.parse(await fs.readFile(root+'/'+nativeStatusFile,'utf8'));const observed=nativeInputState({child,status,parent:process.pid,useIme});if(observed.captureReady)break;if(observed.matches&&status.error)throw Object.assign(Error(status.error),{audioSession:status.audioSession??null});}catch(e){if(e.code!=='ENOENT'&&e.name!=='SyntaxError')throw e;}
    await sleep(100);
  }
  if(!nativeInputState({child,status,parent:process.pid,useIme}).captureReady)throw Error('后台麦克风监听未就绪');
  nativeCaptureStatus=status;
  async function connect(){
    if(closing||native!==child||phone?.active)return;
    try{
      await mouseMode(true,useIme?'doubao-ime':'native');inputBinding();if(!state.request&&!nativeTurn)state.phase='按住后侧键说话';
      console.log(JSON.stringify({event:'native-ready',inputDevice:status.inputDevice,button:'rear-side',at:Date.now()}));
      const g=generation;if(!state.request&&!nativeTurn){await nativeCaption('按住后侧键说话');setTimeout(()=>{if(g===generation&&!nativeTurn&&!state.request)void screen({active:false});},1500);}
    }catch(e){inputBinding(e);nativeMouseRetry=setTimeout(connect,5000);}
  }
  await connect();
  }catch(error){
    if(native===child){native=null;nativeCaptureStatus=null;inputBinding(error);}
    await stopChild(child);
    throw error;
  }
}
async function bridge(path,body){const r=await fetch('http://127.0.0.1:18779'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await r.json();if(!r.ok||data.error)throw Error(data.error||'Harness连接失败');return data;}
function screen(value){const operation=screenTail.then(async()=>{
 if(value.guard&&!value.guard())return;
 const {guard,...display}=value;value=display;
 if(value.active&&value.g!==generation)return;
 if(!value.active&&!closing&&presenceAvailable()){const hint=idlePresence();if(hint)value={...hint,g:generation};}
 await writeJson(new URL('voice-screen.json',parent),{...value,at:Date.now(),pid:process.pid});
 screenCurrentKey=value.active?value.key:null;
 state.screenPresence=value.kind==='presence'?value.text:null;
});screenTail=operation.catch(()=>{});return operation;}
const spokenCaptions=new SpeechCaptionQueue({
 render:async(item,signal)=>{
  if(item.g!==generation||signal.aborted)return {cancelled:true};
  await screen({active:true,text:item.text,key:item.key,g:item.g,playbackTimed:!!item.options.playbackTimed});
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
   if(item.g!==generation||signal.aborted)return {cancelled:true};
   let ack;try{ack=JSON.parse(await fs.readFile(new URL('voice-screen-ack.json',parent),'utf8'));}catch{}
   if(ack?.key===item.key){
    if(ack.error)throw Error(ack.error);state.captionError=null;
    const actual={scrolling:ack.scrolling??(cfg.captionMode==='scroll'||[...item.text].length>11),fontSize:ack.fontSize??cfg.captionFontSize??0,nativeUnsupported:!!ack.nativeUnsupported};
    timing('caption-visible',{key:item.key,textLength:[...item.text].length,scrolling:actual.scrolling,holdMs:captionReadMs(item.text,{...actual,seconds:item.seconds})});return actual;
   }
   await sleep(20);
  }
  throw Error('字幕控制器未响应，请检查设备联动');
 },
 refresh:async item=>{if(item.g===generation&&screenCurrentKey===item.key)await screen({active:true,text:item.text,key:item.key,g:item.g,playbackTimed:!!item.options.playbackTimed});},
 finished:async item=>{if(item&&item.g===generation&&screenCurrentKey===item.key)await screen({active:false});},
 onError:error=>{state.captionError=error.message;},
});
const externalSpeech=new ExternalSpeech({queue:spokenCaptions,clear:guard=>screen({active:false,guard}),options:()=>captionOptions(cfg),generation:()=>generation,
 ownerCurrent:owner=>!closing&&(!owner||owner===leaseId&&phone?.state.id===owner&&phone?.state.phase==='connected'),
 changed:value=>{externalPlaying=value.playing;externalPlaybackUntil=value.until;state.playbackError=value.error;state.phoneVoiceError=value.error?.message??null;},
});
const pttSpeech=new PttSpeech({external:externalSpeech,current:item=>!closing&&item.g===generation,onError:error=>{state.captionError=error.message;}});
async function interrupt(cancel=true){
  live2dSpeechJobs.cancelAll();pttSpeech.cancel();externalSpeech.reset();
  spokenCaptions.cancel();
  if(communityTurn){
    const turn=communityTurn;communityTurn=null;turn.abort.abort();
    await communityStatus({id:turn.id,active:false}).catch(()=>{});
  }
  if(phone?.active&&['dialing','connecting'].includes(phone.state.phase)){state.input='';state.reply='';}
  nativeTurn=null;nativePhase=null;nativeTextTurn=null;
  const abandonedAudio=audio.splice(0);
  generation++;state.request=null;pending=[];sentences=speechSegments();ended=false;characters=0;
  streamPlayer?.write({command:'cancel'});turnTiming=null;
  const currentPlayer=player;player=null;await stopChild(currentPlayer);await discardAudioFiles(abandonedAudio,{cacheDir:root+'/cache'}).catch(error=>{state.cleanupError=error.message;});await screen({active:false});
  if(useLive2d){live2dTurn?.abort();live2dTurn=null;}
  else if(cancel)await bridge('/cancel',{});
  state.phase=state.ready?'按住说话':'加载语音模型';
  phone?.turnFinished();
}
async function submit(text,kind='voice',{fromPtt=false}={}){
  turnTiming??={received:Date.now()};turnTiming.submitted=Date.now();timing('voice-submit');
  state.error=null;state.input=text;state.reply='';
  const communityFollowup=fromPtt&&!communitySearchHint(text)&&await communityChannel.communityContext().then(r=>r.active===true).catch(()=>false);
  if(fromPtt&&(communitySearchHint(text)||communityFollowup)){
    const turn={id:randomUUID(),abort:new AbortController(),generation};
    communityTurn=turn;state.request=turn.id;state.phase='正在查迈从社区';
    const current=()=>communityTurn===turn&&!closing&&generation===turn.generation&&!turn.abort.signal.aborted;
    void (async()=>{
      let reply;
      try{
        await communityStatus({id:turn.id,active:true,pid:process.pid,at:Date.now(),until:Date.now()+180000});
        if(!current())return;
        await screen({active:false});
        const result=await communityChannel.community(text,turn.id,turn.abort.signal);
        if(result.handled===false){
          communityTurn=null;await communityStatus({id:turn.id,active:false});
          if(!closing&&generation===turn.generation)await submit(text,kind,{fromPtt:false});
          return;
        }
        reply=result.spoken;
      }catch(error){if(current())reply='社区这次没查成。'+error.message;}
      finally{
        if(current()){
          communityTurn=null;
          await communityStatus({id:turn.id,active:false}).catch(()=>{});
          if(!closing&&generation===turn.generation)localDeviceReply(reply||'社区没有返回可用结果。');
        }
      }
    })().catch(console.error);
    return;
  }
  let intent;try{intent=parseDeviceCommand(text);}catch(error){localDeviceReply(error.message);return;}
  if(intent){timing('voice-device-intent',{kind:intent.kind});const result=useLive2d?await live2d.device(text):deviceCommands.dispatch(intent);localDeviceReply(result.message);void result.done?.catch(error=>{state.error=error.message;});return;}
  state.request=randomUUID();state.phase='正在思考';timing('model-request');
  if(!useLive2d){await bridge('/talk',{text,request:state.request});return;}
  const g=generation,turn=new AbortController();
  live2dTurn=turn;
  void live2d.reply(text,kind,turn.signal).then(result=>{
    if(closing||g!==generation)return;
    const checked=inspectSpeechOutput(result.reply);
    if(!checked.valid)throw Error('模型返回了内部标记或空回复，已停止朗读，请再试一次。');
    state.reply=spokenReply(checked.text);state.lastReplyWithImage=result.withImage===true;
    timing('model-first-text');enqueue(spokenUtterances(checked.text));ended=true;
    return finish();
  }).catch(error=>{
    if(!turn.signal.aborted&&g===generation)return speechFailure(error);
  }).catch(console.error).finally(()=>{if(live2dTurn===turn)live2dTurn=null;});
}
async function nativeCaption(text){spokenCaptions.cancel();await screen({active:true,text,key:'native-'+randomUUID(),g:generation});}
async function speechFailure(error){
  if(phone?.state.phase==='connecting'){
    console.warn('通话开场语音未播放：'+error.message);
    ended=true;
    await phone.audioPrepared();
    return;
  }
  state.error=error.message;await interrupt(false);
  const g=generation,quota=/额度|HTTP 402/.test(error.message);
  state.phase=quota?'云端音色额度不足':'暂时无法语音回复';
  await screen({active:true,text:quota?'音色额度不足，暂时无法发声':'语音回复失败，请重试',key:'speech-error-'+randomUUID(),g});
  setTimeout(()=>{if(g===generation&&!nativeTurn)void screen({active:false});},6000);
  phone?.turnFinished();
}
const nativeHeartbeat=setInterval(()=>{
  if(!nativeTurn||!nativePhase)return;
  if(Date.now()-nativeSince>90000){void interrupt().catch(e=>state.error=e.message);return;}
  void nativeCaption(nativePhase==='recording'?'听你说，慢慢来':nativePhase==='recognizing'?'正在听懂你的话':'正在想怎么回答').catch(e=>state.error=e.message);
},5000);
async function finish(){if(ended&&!pending.length&&!audio.length&&!producing&&!playing){ended=false;nativeTurn=null;nativePhase=null;state.request=null;spokenCaptions.finish();state.phase=phone?.active?'通话中，听你说':'按住后侧键说话';phone?.turnFinished();}}
function enqueue(text){
  for(const sentence of text){
    if(characters+sentence.length>cfg.maxReplyCharacters){state.phase='长回复已在会话中保留';break;}
    if(pending.length>=cfg.maxQueuedSentences){state.error='回复过快，已停止朗读；完整回复保留在 Harness';void interrupt().catch(e=>state.error=e.message);return;}
    characters+=sentence.length;pending.push({text:sentence,g:generation});
  }
  void produce();
}
async function produce(){
  if(producing)return;producing=true;
  try{
    while(pending.length&&!closing){
      if(audio.length>=cfg.maxQueuedSentences){await sleep(50);continue;}
      const item=pending.shift(),file=root+'/cache/'+randomUUID()+'.wav';
      if(useStream){
        item.stream=randomUUID();item.packets=new StreamPackets(item.stream);item.pages=captionPages(item.text);item.complete=false;let queued=false;
        const start=Date.now();timing('tts-request',{textLength:item.text.length});
        try{
          const result=await pttSpeech.synthesize(item,signal=>tts.run({text:item.text,stream:true,file,pages:captionPages(item.text),speechRate:useLive2d?speechRate():1},row=>{
            if(item.g!==generation)return;
            const packet={command:'chunk',stream:item.stream,audio:row.audio,words:row.words};
            item.packets.push(packet);
            if(!queued&&row.audio){queued=true;audio.push(item);timing('tts-first-audio',{ms:Date.now()-start});void play();}
          },{signal}));
          pttSpeech.synthesized(item,result);
          if(result.fallback){audio.push({...item,stream:null,file:result.file,seconds:result.seconds,captions:result.captions});void play();}
          item.complete=true;item.packets.end();
          if(item.g===generation)timing('tts-complete',{ms:Date.now()-start,seconds:result.seconds,firstAudioMs:result.firstAudioMs});
        }catch(e){await discardAudioFiles([{file}],{cacheDir:root+'/cache'}).catch(error=>{state.cleanupError=error.message;});if(item.g===generation)throw e;}
        continue;
      }
      let result;try{result=await pttSpeech.synthesize(item,signal=>tts.run({text:item.text,file,pages:captionPages(item.text),speechRate:useLive2d?speechRate():1},undefined,{signal}));}catch(error){await discardAudioFiles([{file}],{cacheDir:root+'/cache'}).catch(error=>{state.cleanupError=error.message;});if(item.g!==generation)continue;throw error;}
      pttSpeech.synthesized(item,result);
      if(item.g!==generation){await fs.rm(file,{force:true});continue;}
      audio.push({...item,file,seconds:result.seconds,captions:result.captions});void play();
    }
  }catch(e){await speechFailure(e).catch(()=>{});}
  finally{producing=false;await finish();}
}
async function play(){
  if(playing)return;playing=true;
  try{
    while(audio.length){
      const item=audio.shift();if(item.g!==generation){await discardAudioFiles([item],{cacheDir:root+'/cache'}).catch(error=>{state.cleanupError=error.message;});continue;}
      if(item.stream){
        nativePhase=null;
        await phone?.audioPrepared();
        if(closing||item.g!==generation)continue;
        state.phase='正在准备播放';
        try{
          const result=await playRecoverableStream(item,{
            getPlayer:playbackPlayer,reset:resetStreamPlayer,current:()=>!closing&&item.g===generation,
            recovering:error=>{if(item.g===generation){state.phase='正在恢复播放设备';state.playbackRecovery={phase:'retrying',speechId:item.speechId,at:Date.now(),error:error.message};timing('playback-retry',{speechId:item.speechId});}},
            progress:e=>{
              if(e.event!=='started')return;
              state.playbackRecovery=null;pttSpeech.started(item);state.phase='正在回复';
              if(turnTiming&&!turnTiming.spoken){turnTiming.spoken=Date.now();state.lastLatency={recognitionToAudioMs:Date.now()-turnTiming.submitted,releaseToAudioMs:Date.now()-turnTiming.received};timing('turn-latency',state.lastLatency);}
              timing('play-start',{textLength:[...item.text].length,g:item.g,latency:e.latency,pages:item.pages.length,streamed:true});
            },
          });
          await pttSpeech.finished(item,{cancelled:item.g!==generation||result.canceled===true});
          if(item.g===generation)timing('play-done',{underruns:result.underruns||0,replayed:result.replayed===true});
        }catch(error){await pttSpeech.finished(item,{cancelled:true});if(!closing&&item.g===generation)throw error;}
        finally{item.packets.close();}
        continue;
      }
      const captions=item.captions||[{text:captionPages(item.text)[0],sample:0}];
      let playbackChild;
      try{
      let preparedResolve,preparedReject,doneResolve;
      const prepared=new Promise((r,j)=>{preparedResolve=r;preparedReject=j;}),done=new Promise(r=>{doneResolve=r;});
      const child=spawn(ttsPython,['-X','utf8',root+'/worker.py','play-sync',item.file],{windowsHide:true,stdio:['pipe','pipe','inherit']});player=child;playbackChild=child;
      createInterface({input:child.stdout}).on('line',line=>{try{const e=JSON.parse(line);if(e.event==='prepared')preparedResolve();if(e.event==='started'&&item.g===generation){pttSpeech.started(item);state.phase='正在回复';console.log(JSON.stringify({event:'play-start',textLength:[...item.text].length,g:item.g,latency:e.latency,pages:captions.length,at:Date.now()}));}}catch{}});
      child.on('error',preparedReject);child.on('exit',(code,signal)=>{if(player===child)player=null;preparedReject(Error('播放器提前退出'));doneResolve({code,signal});});
      await waitForPlaybackPrepared(prepared).catch(e=>{if(item.g===generation)throw e;});
      if(item.g!==generation){await stopChild(child);continue;}
      nativePhase=null;
      await phone?.audioPrepared();
      if(closing||item.g!==generation){await stopChild(child);continue;}
      child.stdin.write(JSON.stringify({command:'start',captions})+'\n');
      const result=await done;
      await pttSpeech.finished(item,{cancelled:item.g!==generation||result.code!==0||!!result.signal});
      if(item.g===generation&&result.code!==0&&!result.signal)throw Error('音频播放失败');
      }finally{if(playbackChild?.exitCode===null)await stopChild(playbackChild).catch(error=>{state.cleanupError=error.message;});await discardAudioFiles([item],{cacheDir:root+'/cache'}).catch(error=>{state.cleanupError=error.message;});}
    }
  }catch(e){await speechFailure(e).catch(()=>{});}
  finally{playing=false;await finish();}
}
let voiceEventsAbort;
async function events(){
  while(!closing){
    const connection=new AbortController();
    voiceEventsAbort=connection;
    let deadline=setTimeout(()=>connection.abort(),8000);
    const heartbeat=()=>{
      clearTimeout(deadline);
      deadline=setTimeout(()=>connection.abort(),45000);
    };
    try{
    const r=await fetch('http://127.0.0.1:18779/events',{signal:connection.signal});if(!r.ok)throw Error('事件通道不可用');streamReady=true;
    heartbeat();
    let buffer='';const decoder=new TextDecoder();let attempt=null,lastRevision=-1,trackedRequest=null,attempts=new SpeechAttempts();
    for await(const chunk of r.body){heartbeat();buffer+=decoder.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.startsWith('data: '))continue;const e=JSON.parse(line.slice(6));if(e.request!==state.request)continue;
      if(e.kind==='end'){if(e.reason?.kind==='completed'){enqueue(sentences.push('',true));ended=true;await finish();}else {state.error='会话结束：'+JSON.stringify(e.reason);await interrupt(false);}continue;}
      if(trackedRequest!==e.request){trackedRequest=e.request;attempt=null;lastRevision=-1;attempts=new SpeechAttempts();}
      const f=e.frame;if(!f||f.revision<=lastRevision)continue;lastRevision=f.revision;
      if(f.type==='start'){if(!attempts.start(f)){await interrupt(false);state.error='模型重复重试，本轮朗读已停止以免重复';continue;}if(attempt!==null)enqueue(sentences.push('',true));attempt=f.attemptId;sentences=speechSegments();}
      attempts.observe(f);
      if(f.type==='chunk'&&f.attemptId===attempt&&f.chunk.type==='text-delta'){if(!state.reply)timing('model-first-text');state.reply+=f.chunk.text;enqueue(sentences.push(f.chunk.text));}
      if(f.type==='chunk'&&f.chunk.type==='finish'&&['error','aborted'].includes(f.chunk.reason?.kind)){await interrupt(false);}
      if(f.type==='end'&&f.outcome?.eventType==='assistant/attempt'){await interrupt(false);}
    }}
    throw Error('Harness事件流断开');
    }catch(e){
      streamReady=false;
      if(!closing&&state.request){
        state.error=e.message;
        await interrupt(false).catch(console.error);
      }
    }finally{
      clearTimeout(deadline);
      connection.abort();
      voiceEventsAbort=null;
    }
    if(!closing)await sleep(1000);
  }
}
if(useLive2d){void refreshLive2d();live2dTimer=setInterval(()=>void refreshLive2d(),1000);}
else void events();
const phoneGreetings=new Map();
const phoneGreetingText=direction=>direction==='incoming'?'喂？是我呀，想找你聊聊天。':'喂？我在呢，你说吧。';
function preparePhoneGreeting(direction){
  if(!phoneGreetings.has(direction)){
    const text=phoneGreetingText(direction);
    const file=root+'/cache/phone-greeting-'+direction+'.wav';
    const task=tts.run({text,file,pages:captionPages(text)}).then(result=>({...result,file,text})).catch(e=>{phoneGreetings.delete(direction);throw e;});phoneGreetings.set(direction,task);
  }
  return phoneGreetings.get(direction);
}
phone=await new PhoneService({
  engine:useLive2d?'live2d-native':undefined,
  ready:()=>state.ready&&streamReady&&!useIme&&!state.ttsOperation&&!tts.lock,
  interrupt:()=>interrupt(),voiceState:()=>({...state,busy:!!state.request||playing||producing||!!nativeTurn}),
  connectExternal:useLive2d?connectNativeCall:undefined,
  muteExternal:useLive2d?async(id,muted)=>{
    const {nativeCall:c}=await live2d.nativeCall(id,'mute',{muted});
    if(c?.id!==id||c.muted!==muted)throw Error('Live2D 电话未确认静音状态。');
  }:undefined,
  afterEnd:useLive2d?async id=>{
    live2dSpeechJobs.cancelOwner(id);
    if(leaseId===id)leaseId=null;
    await live2d.nativeCall(id,'stop').catch(error=>{state.channelError=error.message;});
  }:undefined,
  onAudio:async(file,id)=>{
    const g=generation;turnTiming={received:Date.now()};state.phase='正在识别';await nativeCaption('正在听懂你的话');
    if(closing||g!==generation||phone.state.id!==id||phone.state.phase!=='connected')return;
    let result;try{result=await recognizeAudio(file);}catch(e){if(g===generation){await screen({active:false});state.phase='通话中，听你说';}throw e;}
    if(g!==generation||phone.state.id!==id||phone.state.phase!=='connected')return;
    if(!result.text.trim()){await screen({active:false});state.phase='通话中，听你说';phone.turnFinished();return;}
    state.asrProvider=result.asrProvider;state.asrModelTier=result.asrModelTier;
    await nativeCaption('正在想怎么回答');
    if(!closing&&g===generation&&phone.state.id===id&&phone.state.phase==='connected')await submit(result.text,'call');
  },
  prepare:(direction,{signal}={})=>useLive2d?tts.prepareConversation({signal,speechRate:speechRate()}):useStream?undefined:preparePhoneGreeting(direction),
  onGreeting:async(direction,id)=>{
    if(useStream){
      state.input='';state.reply=phoneGreetingText(direction);state.phase='正在准备接通';
      ended=true;enqueue([state.reply]);return;
    }
    try{
    const g=generation,entry=await preparePhoneGreeting(direction);if(g!==generation||phone.state.id!==id||phone.state.phase!=='connecting')return;
    const file=root+'/cache/'+randomUUID()+'.wav';await fs.copyFile(entry.file,file);
    if(closing||g!==generation||phone.state.id!==id||phone.state.phase!=='connecting'){await fs.rm(file,{force:true});return;}
    state.input='';state.reply=entry.text;state.phase='正在准备接通';ended=true;
    audio.push({text:entry.text,g,file,seconds:entry.seconds,captions:entry.captions});void play();
    }catch(error){
      if(phone.state.id===id&&phone.state.phase==='connecting'){
        await speechFailure(error);await finish();
      }
    }
  },
}).init();
const server=createServer(async(req,res)=>{
  try{
    if(!['127.0.0.1:'+cfg.port,'localhost:'+cfg.port].includes(req.headers.host))throw Error('Invalid host');
    if(req.headers.origin&&!['http://127.0.0.1:'+cfg.port,'http://localhost:'+cfg.port].includes(req.headers.origin))throw Error('Invalid origin');
    const finish=res.end.bind(res);res.end=(...args)=>{if(res.statusCode<400&&state.errorRoute===req.url){state.error=null;state.errorRoute=null;}return finish(...args);};
    if(req.url==='/'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await fs.readFile(root+'/index.html'));return;}
    if(req.url==='/status'){
      let imeReceiver;
      if(useIme){try{const value=JSON.parse(await fs.readFile(root+'/'+nativeStatusFile,'utf8'));if(value.parent===process.pid)imeReceiver={ready:value.ready&&Date.now()-value.at<5000,lastEvent:value.lastEvent,error:value.error,submitted:value.submitted,focusOk:value.focusOk,windowRestored:value.windowRestored};}catch{}}
      const playback={...state.playbackOutput,ready:!!streamPlayer?.outputReady()&&!playbackDevice.needsReset&&!playerResetTask,recovering:!!playerResetTask||playbackDevice.needsReset};
      const inputDisconnected=playbackDevice.connected===false&&/MCHOSE K20 GT/i.test(cfg.inputName??'');
      const phase=state.ready&&!playback.ready&&!phone?.active?'正在恢复播放设备':state.phase;
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...state,phase,playback,ready:state.ready&&(!useStream||playback.ready),nativeReady:state.nativeReady&&!inputDisconnected,pid:process.pid,heartbeatAt:Date.now(),busy:!!(state.request||nativeTurn||playing||producing||externalPlaying||live2dSpeechJobs.jobs.size||state.ttsOperation),streamReady,phone:phone.snapshot(),...(useIme?{imeReceiver}:{} )}));return;
    }
    if(req.url==='/device/network'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await probeImageNetwork({network:voiceNetwork})));return;}
    if(req.method==='GET'){res.writeHead(404).end();return;}
    if(req.method!=='POST')throw Error('POST required');
    let chunks=[],size=0;for await(const b of req){size+=b.length;if(size>2000000)throw Error('录音最长60秒');chunks.push(b);}const body=Buffer.concat(chunks);
    if(!['/shutdown','/interrupt'].includes(req.url))requireDeviceLink();
    if(req.url==='/device/plan'){
      const data=JSON.parse(body||'{}');if(typeof data.text!=='string'||data.text.length>2000)throw Error('指令文字无效');const plan=parseDeviceCommand(data.text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({handled:!!plan,plan,paidCalls:0}));return;
    }
    else if(req.url==='/tts/reload'){
      if(!state.ready||state.request||playing||producing||nativeTurn||phone.active||state.ttsOperation)throw Error('请在语音就绪且当前对话、通话或试听结束后切换。');
      await tts.reload();sentences=speechSegments();phoneGreetings.clear();
    }
    else if(req.url==='/tts/manage'){
      const data=JSON.parse(body||'{}');
      if(!state.ready)throw Error('请先在“模型与识别”中启动语音，等待模型就绪。');
      if(state.ttsOperation||state.request||playing||producing||nativeTurn||phone.active)throw Error('正在对话、通话或试听，请稍后再试。');
      state.ttsOperation=data.operation;
      let result;
      try{
        result=await tts.manage(data);
        if(result.file){
          const audition=spawn(ttsPython,['-X','utf8',root+'/worker.py','play',result.file],{windowsHide:true,stdio:['ignore','ignore','inherit']});
          player=audition;
          try{await new Promise((resolve,reject)=>{audition.once('error',reject);audition.once('exit',code=>code===0?resolve():reject(Error('试听播放未完成，请检查播放设备。')));});}
          finally{if(player===audition)player=null;await fs.rm(result.file,{force:true});}
          delete result.file;
        }
      }finally{state.ttsOperation=null;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    else if(req.url==='/live2d/caption'){
      const event=validatePlaybackEvent(JSON.parse(body||'{}'));
      if(!useLive2d||req.headers.origin||!(await live2d.authorized(req.headers['x-pet-token'])))throw Error('Live2D 字幕未授权。');
      const result=await externalSpeech.event(event);
      void syncPresence().catch(error=>{state.captionError=error.message;});
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    else if(req.url==='/tts/live2d-call'||req.url==='/tts/live2d'){
      const {id,text,speechId:requestedSpeechId}=JSON.parse(body||'{}');
      const isCall=req.url==='/tts/live2d-call';
      const current=()=>!closing&&(!isCall||!!leaseId&&id===leaseId&&phone.state.id===id&&phone.state.phase==='connected');
      if(!useLive2d||req.headers.origin||!current()||!(await live2d.authorized(req.headers['x-pet-token']))||!current())throw Error('Live2D 语音请求无效。');
      if(typeof text!=='string'||!text.trim()||[...text].length>2000)throw Error('Live2D 回复文字无效。');
      const speechId=requestedSpeechId??randomUUID();validatePlaybackEvent({speechId,event:'end'});
      const job={id,file:root+'/cache/call-speech-'+randomUUID()+'.wav'},abort=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)abort.abort(new DOMException('播放端已断开','AbortError'));};
      res.on('close',disconnected);externalSpeech.register(speechId);
      try{
        await live2dSpeechJobs.run({speechId,owner:id??null,signal:abort.signal},async signal=>{
          const normalized=spokenReply(text);
          const result=await tts.run({text:normalized,file:job.file,pages:[normalized],speechRate:speechRate()},undefined,{signal});
          signal.throwIfAborted();if(!current())throw Error('这通电话已经结束。');
          const audio=await fs.readFile(job.file);
          if(!current()||res.destroyed)return;
          const durationMs=Math.round(result.seconds*1000);
          if(!audio.length||!Number.isFinite(durationMs)||durationMs<=0)throw Error('语音合成没有返回有效音频。');
          res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store','X-Audio-Duration-Ms':String(durationMs),'X-Speech-Id':speechId}).end(audio);
        });
      }finally{
        res.off('close',disconnected);
        await fs.rm(job.file,{force:true}).catch(()=>{});
      }
      return;
    }
    else if(req.url==='/tts/effect'){
      if(!state.ready||phone.active||state.request||state.ttsOperation)throw Error('语音合成暂忙，使用已录制语音。');
      const result=await tts.effect(JSON.parse(body||'{}'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    else if(req.url==='/phone/action'){
      const data=JSON.parse(body||'{}');
      if(useIme&&['dial','demo','toggle','accept'].includes(data.action))throw Error('连续通话需要鱼搭子或本地识别模型，请在语音设置中切换识别引擎');
      if(data.action==='video'){
        if(!useLive2d||!(await live2d.status()).asr)throw Error('视频陪玩需要 Live2D 语音识别就绪。');
        await phone.command('dial',{video:true});
      }else await phone.command(data.action,{callId:data.callId});
    }
    else if(req.url==='/native/reconnect'){
      const status=JSON.parse(await fs.readFile(root+'/'+nativeStatusFile,'utf8'));
      if(!nativeInputState({child:native,status,parent:process.pid,useIme}).captureReady)throw Error('后台麦克风监听未就绪');
      nativeCaptureStatus=status;await mouseMode(true,useIme?'doubao-ime':'native');inputBinding();state.error=null;
    }
    else if(req.url==='/captions/reload'){
      const fresh=JSON.parse(await fs.readFile(root+'/config.json','utf8'));Object.assign(cfg,captionOptions(fresh));cfg.live2dSpeechRate=fresh.live2dSpeechRate??1;state.live2dSpeechRate=speechRate();
    }
    else if(req.url==='/audio/reload'){
      await phone.end('audio-change');
      if(!state.ready)throw Error('请等语音模型准备好后再切换音频设备。');
      await interrupt();const wasReady=state.ready;state.nativeReady=false;
      await stopChild(native);native=null;clearTimeout(nativeMouseRetry);
      const fresh=JSON.parse(await fs.readFile(root+'/config.json','utf8'));
      for(const key of ['inputName','inputApi','outputName','outputApi','holdMilliseconds'])if(Object.hasOwn(fresh,key))cfg[key]=fresh[key];
      if(streamPlayer)await resetStreamPlayer();
      state.ready=wasReady;await startNative();state.error=null;state.audioSettings={inputName:cfg.inputName,inputApi:cfg.inputApi||'MME',outputName:cfg.outputName||'MCHOSE K20 GT',outputApi:cfg.outputApi||'MME'};
    }
    else if(req.url.startsWith('/ptt/')){
      const data=req.url==='/ptt/audio'?null:JSON.parse(body||'{}'),token=data?.token||req.headers['x-voice-turn'];
      if(typeof token!=='string'||!/^[a-f0-9]{32}$/.test(token))throw Error('Invalid voice turn');
      if(req.url==='/ptt/begin'){
        if(phone.active)throw Error('正在通话，请先挂断后再使用按住说话');
        if(!state.ready||!streamReady||tts.lock||state.ttsOperation)throw Error('语音正在准备或试听，请稍等');
        if(!Number.isSafeInteger(data.sequence)||data.sequence<=nativeSeq)throw Error('这次录音已取消');
        nativeSeq=data.sequence;await interrupt();if(nativeSeq!==data.sequence)throw Error('这次录音已取消');nativeTurn=token;nativeSince=Date.now();state.error=null;
      }else{
        if(token!==nativeTurn)throw Error('这次录音已取消');
        if(req.url==='/ptt/hold'&&[null,'recording'].includes(nativePhase)){nativePhase='recording';state.phase='正在听';await nativeCaption('听你说，慢慢来');}
        else if(req.url==='/ptt/hold'){}
        else if(req.url==='/ptt/tap'){
          nativeTurn=null;nativePhase=null;await screen({active:false});
          const id=randomUUID(),at=Date.now(),folder=new URL('interaction-inbox/',parent);await fs.mkdir(folder,{recursive:true});
          const name=`${at}-000000-${id}.json`;await fs.writeFile(new URL(name+'.tmp',folder),JSON.stringify({kind:'mouse-rear',id,at}));await fs.rename(new URL(name+'.tmp',folder),new URL(name,folder));
          state.phase='按住后侧键说话';
        }else if(req.url==='/ptt/discard'){nativeTurn=null;nativePhase=null;state.request=null;await screen({active:false});state.phase='按住后侧键说话';}
        else if(req.url==='/ptt/text'){
          if(!useIme||data.provider!=='doubao-ime')throw Error('输入法接收未启用');
          if(nativeTextTurn===token)throw Error('这段文字已经提交');
          if(typeof data.text!=='string')throw Error('豆包没有返回有效文字');
          const text=data.text.trim();
          if(!text||text.length>2000)throw Error('豆包没有返回有效文字');
          if(!Number.isSafeInteger(data.releasedAt)||data.releasedAt<nativeSince-2000||data.releasedAt>Date.now()+1000)throw Error('输入法结果已过期');
          nativeTextTurn=token;nativePhase='thinking';turnTiming={received:data.releasedAt};
          timing('ime-result',{provider:'doubao-ime',textLength:text.length,releaseToTextMs:Date.now()-data.releasedAt});
          const g=generation;await nativeCaption('正在想怎么回答');
          if(!closing&&g===generation&&nativeTurn===token)await submit(text,'voice',{fromPtt:true});
        }
        else if(req.url==='/ptt/audio'){
          if(useIme)throw Error('当前使用豆包输入法识别');
          if(body.toString('ascii',0,4)!=='RIFF'||body.toString('ascii',8,12)!=='WAVE')throw Error('Invalid WAV');
          const g=generation,file=root+'/cache/native-'+randomUUID()+'.wav';turnTiming={received:Date.now()};timing('audio-received');nativePhase='recognizing';state.phase='正在识别';await nativeCaption('正在听懂你的话');await fs.writeFile(file,body);
          try{
            const result=await recognizeAudio(file,body);if(g!==generation||nativeTurn!==token)throw Error('这次录音已取消');
            state.asrProvider=result.asrProvider;state.asrDevice=result.asrDevice||state.asrDevice;state.asrModelTier=result.asrModelTier;
            console.log(JSON.stringify({event:'asr-result',language:result.language,provider:result.asrProvider,recognitionMs:result.recognitionMs,textLength:result.text.length,audio:result.audio,at:Date.now()}));
            if(!result.text.trim()){await interrupt(false);throw Error('没有听清，请再说一次');}
            nativePhase='thinking';await nativeCaption('正在想怎么回答');
            if(!closing&&g===generation&&nativeTurn===token)await submit(result.text,'voice',{fromPtt:true});
          }catch(e){
            if(g===generation&&nativeTurn===token){
              nativeTurn=null;nativePhase=null;state.error=e.message;state.phase='请重新按住说话';
              console.log(JSON.stringify({event:'asr-rejected',reason:e.message,audio:e.audio,at:Date.now()}));
              await screen({active:true,text:e.message.includes('人声太弱')?'人声太弱，靠近音箱再说':e.audio?'没收到人声，检查麦克风':'没听清，请再说一次',key:'asr-error-'+randomUUID(),g});
              setTimeout(()=>{if(g===generation&&!nativeTurn)void screen({active:false});},2500);
            }
            throw e;
          }finally{await fs.rm(file,{force:true});}
        }else throw Error('Unknown native route');
      }
    }
    else if(req.url==='/interrupt'){await interrupt();phone.turnFinished();}
    else if(req.url==='/shutdown'){
      const condition=JSON.parse(body||'{}');
      if(condition.expectedPid!==process.pid)throw Error('语音进程已变化或未指定目标，未自动停止。');
      if(condition.ifIdle&&!idleForShutdown({phoneActive:phone.active,request:state.request,nativeTurn,ttsOperation:state.ttsOperation,playing:playing||externalPlaying||!!spokenCaptions.runner,producing,speechJobs:live2dSpeechJobs.jobs.size}))throw Error('语音正在使用，未自动重启。');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
      void shutdown();
      return;
    }
    else if(req.url==='/speak'){
      if(phone.active)throw Error('正在通话，请直接说话，或先挂断');
      if(!state.ready||!streamReady||tts.lock||state.ttsOperation)throw Error('请等待模型、试听和 Harness 连接就绪');
      const text=JSON.parse(body).text;if(typeof text!=='string'||!text.trim()||text.length>2000)throw Error('请输入1至2000字');
      const turn=interrupt();const acceptedGeneration=generation;await turn;if(closing||generation!==acceptedGeneration)throw Error('这次录音已取消');await submit(text);
    }else if(req.url==='/recognize'){
      if(useIme)throw Error('当前使用豆包输入法识别');
      if(!state.ready)throw Error('模型尚未就绪');
      const g=generation,file=root+'/cache/input-'+randomUUID()+'.wav';
      if(body.toString('ascii',0,4)!=='RIFF'||body.toString('ascii',8,12)!=='WAVE')throw Error('Invalid WAV');
      await fs.writeFile(file,body);state.phase='正在识别';
      try{const result=await recognizeAudio(file,body);if(g!==generation)throw Error('录音已取消');state.error=null;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}finally{await fs.rm(file,{force:true});if(g===generation&&state.phase==='正在识别')state.phase='按住后侧键说话';}
    }else throw Error('Unknown route');
    res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
  }catch(e){if(e.message!=='这次录音已取消'&&!req.url.startsWith('/tts/')&&req.url!=='/live2d/caption'){state.error=e.message;state.errorRoute=req.url;}res.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}
});
async function shutdown(){
  if(closing)return;
  closing=true;deviceCommands.close();clearInterval(deviceNoticeTimer);clearInterval(deviceLinkTimer);if(typeof runtimeRepairTimer!=='undefined')clearInterval(runtimeRepairTimer);
  generation++;live2dSpeechJobs.cancelAll();pttSpeech.cancel();externalSpeech.reset();
  const abandonedAudio=audio.splice(0);pending=[];
  if(communityTurn){const turn=communityTurn;communityTurn=null;turn.abort.abort();await communityStatus({id:turn.id,active:false}).catch(()=>{});}
  server.close();
  voiceEventsAbort?.abort();
  live2dTurn?.abort();
  clearInterval(live2dTimer);
  spokenCaptions.cancel();
  clearInterval(nativeHeartbeat);
  clearTimeout(nativeMouseRetry);
  const cleanup=await Promise.allSettled([
    phone?.close(),
    stopChild(native),stopChild(player),tts.close(),
    stopChild(asr?.child),streamPlayer?.dispose(),
    discardAudioFiles(abandonedAudio,{cacheDir:root+'/cache'}),
  ]);
  for(const result of cleanup)if(result.status==='rejected')console.error(result.reason);
  await mouseMode(false).catch(e=>console.error('Mouse restore: '+e.message));
  await screen({active:false}).catch(console.error);
  try{
    if((await fs.readFile(root+'/server.pid','utf8')).trim()===String(process.pid))await fs.rm(root+'/server.pid',{force:true});
  }catch(error){if(error.code!=='ENOENT')console.error(error);}
  process.exit();
}
const deviceLinkTimer=setInterval(()=>{if(!readDeviceLink().enabled)void shutdown();},400).unref();
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
server.listen(cfg.port,'127.0.0.1',async()=>{await fs.writeFile(root+'/server.pid',String(process.pid));console.log('Voice chat: http://127.0.0.1:'+cfg.port);});
server.on('error',async e=>{console.error(e);await shutdown();});
