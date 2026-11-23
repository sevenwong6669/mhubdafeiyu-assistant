import {runtime} from '../runtime-paths.mjs';
import {runtimeVersion} from './runtime-version.mjs';
import {commandExpired,recoverCommands} from './command-recovery.mjs';
import {intentToken,invalidateIntent} from '../mhub-community-assistant/device-intent.mjs';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {mhub} from '../dafeiyu-mhub-bridge/mhub.mjs';
import {invoke} from '../mhub_light_sync_api.mjs';
import {screenSnapshot,installResident,rememberResident,displayResident,tintResident,displayText,textSnapshot,restoreText,restoreScreen,captureCaptionScreen,restoreCaptionScreen} from './screen.mjs';
import {ResidentRotation} from './resident-rotation.mjs';
import {speakerAssetClip,savedSpeakerClip} from './device-asset-screen.mjs';
import {DeviceAssetPlayback} from './device-asset-playback.mjs';
import {restoreDefaultTheme} from './default-theme.mjs';
import {BALANCE_KEYBOARDS} from './balance-keyboards.mjs';
import {balancePalette} from './ambient-strip.mjs';
import {Affinity,affinityText} from './affinity.mjs';
import {ScreenWeather} from './weather.mjs';
import {HarnessStatus,TypedTaskEvents} from './status-model.mjs';
import {subscribeHarnessEvents} from './harness-events.mjs';
import {SessionMetadata} from './session-metadata.mjs';
import {Presenter,DisplayRecovery} from './presentation.mjs';
import {PetInteraction} from './pet-model.mjs';
import {playLive2dTouch} from './live2d-touch.mjs';
import {Attention,MemoryGame,nightQuiet} from './playtime.mjs';
import {Fireworks} from './fireworks.mjs';
import {BalanceBar,balanceView} from './balance-bar.mjs';
import {LiveControlSettings,StableTaskState,DEFAULT_BINDINGS,TASK_STATES,validateStyle} from './control-settings.mjs';
import {HardwareScreen} from './hardware-screen.mjs';
import {writeModeOverride,readModeOverride,SCREEN_MODES} from './mode-override.mjs';
import {ControllerConnection,createConnectionReporter} from './controller-connection.mjs';
import {RecoveryGate,writeJson} from './resilience.mjs';
import {TaskScreen,taskScreenPlan} from './task-screen.mjs';
import {LiveSyncDevices,connectedSelection,beginLightingSession} from './sync-devices.mjs';
import {confirmPreviewOutput,keyboardWriterOwned} from './preview-confirmation.mjs';
import {LiveSubtitles} from './subtitles.mjs';
import {NativeLightEngine} from './native-light-engine.mjs';
import {KeyboardFrameBridge} from './keyboard-frame-bridge.mjs';
import {LightSession,taskNeedsLighting} from './light-session.mjs';
import {PhoneVisual} from './phone/visual.mjs';
import {MouseBindingRecovery} from './mouse-binding-recovery.mjs';
import {recoverableScreen,ownedScreenContent,isSpeakerScreenError} from './screen-recovery.mjs';
import {randomUUID} from 'node:crypto';
import {processIdentity} from '../mhub-community-assistant/process-identity.mjs';
import {acquireSupervisorLock} from './process-lock.mjs';
import {readCommunityTask,communityRawState,communityWriting} from './community-work.mjs';
import {readDeviceLink,requireDeviceLink,deviceWritePending} from './device-link-mode.mjs';
import {stopLegacyBridge} from './legacy-bridge.mjs';
const ROOT=new URL('./',import.meta.url),journal=new URL('session.json',ROOT),pidFile=new URL('run.pid',ROOT);
const stopFile=new URL('stop.request',ROOT);
requireDeviceLink();
const stopRequested=async()=>!readDeviceLink().enabled||await fs.access(stopFile).then(()=>true,()=>false);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rgb=color=>color.slice(1).match(/../g).map(x=>parseInt(x,16));
let previous=null;try{previous=JSON.parse(await fs.readFile(journal,'utf8'));}catch{}
const controllerLock=await acquireSupervisorLock({name:'DafeiyuMhubController'});
if(!controllerLock)throw Error('设备联动启动已由另一实例处理');
try{
  const pid=Number(await fs.readFile(pidFile,'utf8'));
  const identity=await processIdentity(pid,fileURLToPath(import.meta.url));
  if(identity.matches!==false)throw Error(identity.matches?'Harness synchronization is already running':'无法核对旧联动进程，已保留原进程');
  await fs.rm(pidFile);
}catch(error){if(error.code!=='ENOENT')throw error;}
await fs.writeFile(pidFile,String(process.pid),{flag:'wx'});
const instanceId=randomUUID(),startedAt=Date.now(),version=runtimeVersion();
let stopping=false,manual=false,owned=false,expected=null,snapshot=null,screenBackup=null,changedImage=false;
let screenReady=false,captionOnly=false,speakerControlReady=false,screenError=null,nextScreenProbe=0,screenFailures=0;
let handoff=false,hotkeyProcess=null,voiceProcess=null,panelProcess=null,numberProcess=null,lastNumberWrite=0,lastNumberHighlight=-2;
const pet=new PetInteraction(),touchFile=new URL('touch.request',ROOT),handoffFile=new URL('handoff.request',ROOT);
let live2dTouchPending=false;
const petJournal=new URL('pet-interaction-state.json',ROOT);
try{pet.restore(JSON.parse(await fs.readFile(petJournal,'utf8')));}catch{}
try{pet.setDurations(JSON.parse(await fs.readFile(new URL('assets/pet-voices/voice-pack.json',ROOT),'utf8')).clips);}catch{}
async function savePetState(){
  const temp=new URL('pet-interaction-state.tmp',ROOT);await fs.writeFile(temp,JSON.stringify(pet.snapshot()));
  for(let i=0;i<8;i++){try{await fs.rename(temp,petJournal);return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await sleep(25);}}
  await fs.rm(temp,{force:true});log('pet-state-save-retry');
}
const attention=new Attention(),game=new MemoryGame(),inbox=new URL('interaction-inbox/',ROOT),gameFlag=new URL('game-keys.request',ROOT);
const affinity=new Affinity();
const weather=new ScreenWeather();
let begRequest=null,affinityUntil=0;
try{const saved=JSON.parse(await fs.readFile(new URL('playtime-state.json',ROOT),'utf8')).game;for(const sequence of saved.randomHistory||[saved.sequence])game.rememberSequence(sequence);}catch{}
const fireworks=new Fireworks();
const balanceBar=new BalanceBar();
const mouseBindingRecovery=new MouseBindingRecovery();
const controls=new LiveControlSettings(),stableTask=new StableTaskState();
const syncDevices=new LiveSyncDevices();
const subtitles=new LiveSubtitles();let subtitlePreview=null,lastSubtitle=null;
const nativeLights=new NativeLightEngine();
const keyboardBridge=new KeyboardFrameBridge();
const phoneVisual=new PhoneVisual(keyboardBridge);let phoneSavedManual=false;
const lightSession=new LightSession();let lightingWanted=false;
let communityTask=null,communityPhaseKey=null,communityKeyboardReleased=false;
const assetPlayback=new DeviceAssetPlayback();
function assetEngineOptions(){
 const view=balanceView(balanceBar.snapshot,balanceBar.settings);keyboardBridge.sidePalettes={};
 if(assetPlayback.active&&balanceBar.settings.enabled&&view){const spec=BALANCE_KEYBOARDS.find(s=>s.id==='GT 75');keyboardBridge.sidePalettes[spec.id]=balancePalette(view,spec,balanceBar.settings.gt75Layout).flatMap(c=>rgb(c));}
 return {assetSceneId:assetPlayback.sceneId,assetDeviceIds:assetPlayback.info?.ids??[],assetMedia:assetPlayback.media};
}
function lightingLease(){return {enabled:assetPlayback.active||lightSession.active&&!manual,token:keyboardBridge.token,options:assetEngineOptions()};}
async function stopAssetPlayback(){
 if(!assetPlayback.active&&!assetPlayback.info)return {stopped:true,alreadyStopped:true};
 await nativeLights.close();await keyboardBridge.stopWriter();
 const result=await assetPlayback.end();keyboardBridge.mainOnly=false;expected=(await mhub('status')).signature;owned=true;balanceBar.ambient.reassert();presenter.state=null;presenter.styleKey=null;
 return result;
}
const hardwareScreen=new HardwareScreen();let previousVoiceScreen=false,previousGameScreen=false;
try{const last=JSON.parse(await fs.readFile(new URL('control-status.json',ROOT),'utf8'));if(Object.hasOwn(hardwareScreen.pages,last.shortcutPage))hardwareScreen.page=last.shortcutPage;}catch{}
const taskScreen=new TaskScreen();let lastScreenFeedback=null;
const displayRecovery=new DisplayRecovery();
const connectionRecovery=new ControllerConnection();let deviceKey=null,lastHeartbeat=0,lastProgressAt=Date.now();
function pauseScreen(error){
  const reason=error.message.split(/\r?\n/,1)[0];
  if(screenReady||screenError!==reason)log('screen-paused',{reason});
  screenReady=false;captionOnly=false;speakerControlReady=false;screenError=reason;
  nextScreenProbe=Date.now()+Math.min(60000,10000*2**Math.min(3,screenFailures++));
  presenter.state=null;presenter.mode=null;hardwareScreen.pageKey=null;hardwareScreen.error=reason;
}
async function screenOperation(operation){
  if(!screenReady)return null;
  try{return await operation();}
  catch(error){pauseScreen(error);return null;}
}
async function invalidateDevices(){presenter.state=null;presenter.mode=null;presenter.styleKey=null;lastCheck=0;nextScreenProbe=0;captionOnly=false;balanceBar.lastKey=null;hardwareScreen.pageKey=null;hardwareScreen.cacheKey=null;hardwareScreen.version=null;await hardwareScreen.pageButtons(false).catch(()=>{});}
const reportConnection=createConnectionReporter(ROOT);
async function heartbeat(extra={}){
 if(Date.now()-lastHeartbeat<900)return;
 lastHeartbeat=Date.now();
 const connection=connectionRecovery.snapshot();
 await reportConnection({pid:process.pid,instanceId,startedAt,version,at:lastHeartbeat,phase:connectionRecovery.failures?'reconnecting':'running',lastProgressAt,manual,screen:{ready:!connectionRecovery.failures&&screenReady,captionsReady:!connectionRecovery.failures&&(screenReady||captionOnly),error:connection.error||screenError},connection,...extra});
}
let lightPreview=null,lastPreviewLights=null,lastControlStatus=0,lastControlCommand=null;
async function failLightPreview(error){
  if(!lightPreview)return;
  lastControlCommand={id:lightPreview.id,ok:false,phase:'failed',error:'试用未完成：'+error.message};lightPreview=null;lastPreviewLights=null;
  presenter.state=null;presenter.styleKey=null;
  try{await nativeLights.close();await keyboardBridge.stopWriter();const restored=await lightSession.end();if(restored){expected=restored.signature;owned=true;balanceBar.ambient.reassert();}}catch(cleanup){log('preview-restore-pending',{reason:cleanup.message});}
  // A connection failure can bypass the normal status write for many retries.
  // Publish this terminal receipt now rather than leaving an accepted trial open.
  const old=await fs.readFile(new URL('control-status.json',ROOT),'utf8').then(JSON.parse).catch(()=>({}));
  await writeJson(new URL('control-status.json',ROOT),{...old,pid:process.pid,at:Date.now(),preview:null,lastCommand:lastControlCommand}).catch(e=>log('preview-receipt-pending',{reason:e.message}));
}
const playVoices=new Set(['game-fireworks.wav','beg.wav','game-start.wav','game-turn.wav','game-win.wav','game-lose.wav','game-count-2.wav','game-count-3.wav','game-count-4.wav']);
const colorVoices=new Set(['color-red.wav','color-yellow.wav','color-blue.wav','color-green.wav']);
async function numberRequest(enabled,highlight=-1){
  const temp=new URL('number-key-request.tmp',ROOT);await fs.writeFile(temp,JSON.stringify({enabled,highlight,at:Date.now()}));
  for(let i=0;i<8;i++){try{await fs.rename(temp,new URL('number-key-request.json',ROOT));return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await sleep(25);}}
}
async function stopNumbers(){
  if(!numberProcess)return;
  const child=numberProcess;child.stopRequested=true;
  await numberRequest(false);
  if(child.exitCode===null&&child.signalCode===null){
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(6000)]);
    if(child.exitCode===null&&child.signalCode===null)child.kill();
  }
  if(numberProcess===child)numberProcess=null;
}
try{game.setDurations(JSON.parse(await fs.readFile(new URL('assets/tone-jobs/playtime/results.json',ROOT),'utf8')).clips);}catch{}
let attentionEnabled=true,lastGameKeyMode='',playStatus='';
// Only a visible window belonging to this controller and this round can accept local answers.
async function gameWindowReady(){
  if(!panelProcess?.pid||panelProcess.exitCode!==null)return false;
  try{
    const status=JSON.parse(await fs.readFile(new URL('game-panel-status.json',ROOT),'utf8'));
    return status.pid===panelProcess.pid&&status.parent===process.pid&&status.visible===true&&
      !status.minimized&&status.observedAt>=game.startedAt&&Date.now()-status.observedAt<3000;
  }catch{return false;}
}
let voiceScreenKey=null,voicePreemptedKey=null,captionBackup=null,captionText=null;
async function restoreCaption(){
  if(!captionBackup)return;
  if(captionText!==null)await restoreCaptionScreen(captionBackup,captionText);
  captionBackup=null;captionText=null;
}
async function voiceDisplay(){
  if(!screenReady&&!captionOnly)return false;
  let request;try{request=JSON.parse(await fs.readFile(new URL('voice-screen.json',ROOT),'utf8'));}catch{}
  if(request?.active&&Date.now()-request.at<15000){
    try{process.kill(request.pid,0);}catch{request=null;}
  }else request=null;
  if(!request&&subtitlePreview&&Date.now()<subtitlePreview.until)request={key:subtitlePreview.id,text:'长字幕向左滚动，结尾是大肥鱼',pid:process.pid,preview:true};
  if(request&&(manual||game.active||pet.visual(model.visual()).startsWith('PET'))){
    await restoreCaption();
    if(request.kind==='presence')voiceScreenKey=null;
    if(voicePreemptedKey!==request.key){
      voicePreemptedKey=request.key;
      await fs.writeFile(new URL('voice-screen-ack.json',ROOT),JSON.stringify({key:request.key,error:'摸摸、游戏或手动控制已取得显示权'}));
      if(!request.preview&&request.kind!=='presence')fetch('http://127.0.0.1:18780/interrupt',{method:'POST',signal:AbortSignal.timeout(1000)}).catch(()=>{});
    }
    return false;
  }
  if(request){
    if(screenReady&&mode==='manual'&&!voiceScreenKey)await hardwareScreen.capture(true);
    attention.interact();voiceProcess?.kill();
    if(voiceScreenKey!==request.key){
      try{
        if(!screenReady){
          captionBackup??=await captureCaptionScreen();
          if(!captionBackup.screen.enabled){
            await fs.writeFile(new URL('voice-screen-ack.json',ROOT),JSON.stringify({key:request.key,error:'音箱屏幕已关闭'}));
            voiceScreenKey=request.key;return false;
          }
          captionText=request.text;
        }
        const style={...subtitles.style(request.text),...(request.playbackTimed?{scroll:false}:{})};let actual;
        try{actual=await displayText(request.text,[70,150,255],style);}
        catch(error){if(!style.scroll||!error.message.includes('style readback'))throw error;subtitles.nativeUnsupported=true;actual=await displayText(request.text,[70,150,255],{fontSize:0});}
        lastSubtitle={...actual,preview:!!request.preview,at:Date.now(),nativeUnsupported:subtitles.nativeUnsupported};voiceScreenKey=request.key;
        await fs.writeFile(new URL('voice-screen-ack.json',ROOT),JSON.stringify({key:request.key,at:Date.now(),scrolling:!!actual.animation,fontSize:actual.fontSize,nativeUnsupported:subtitles.nativeUnsupported}));
      }catch(e){
        await fs.writeFile(new URL('voice-screen-ack.json',ROOT),JSON.stringify({key:request.key,error:e.message}));
        if(isSpeakerScreenError(e)){pauseScreen(e);return false;}
      }
    }
    return true;
  }
  await restoreCaption();
  if(voiceScreenKey){voiceScreenKey=null;presenter.state=null;presenter.mode=null;}
  return false;
}
try{attentionEnabled=JSON.parse(await fs.readFile(new URL('playtime-settings.json',ROOT),'utf8')).attentionEnabled!==false;}catch{}
function playPet(voice){
  voiceProcess?.kill();
  const folder=colorVoices.has(voice)?'tone-jobs/game-colors':playVoices.has(voice)?'tone-jobs/playtime':'pet-voices';
  const original=fileURLToPath(new URL('assets/'+folder+'/'+voice,ROOT));
  const abort=new AbortController();let child;
  const pendingVoice={petFile:voice,kill(){abort.abort();child?.kill();if(voiceProcess===pendingVoice)voiceProcess=null;}};
  voiceProcess=pendingVoice;
  void(async()=>{
    let sound=original;
    try{
      const registry=JSON.parse(await fs.readFile(new URL('voice-chat/tts-services.json',ROOT),'utf8'));
      const scene=folder==='pet-voices'?'pet':'game';
      if(registry.scenes?.[scene]&&registry.scenes[scene]!=='cache'){
        const response=await fetch('http://127.0.0.1:18780/tts/effect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scene,clip:voice}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(90000)])});
        const result=await response.json();if(!response.ok)throw Error('场景音色暂不可用');
        if(result.file)sound=result.file;
      }
    }catch(error){if(error.code!=='ENOENT'&&!abort.signal.aborted)log('scene-voice-fallback',{voice});}
    if(sound===original){
      try{await fs.access(sound);}catch(error){if(error.code!=='ENOENT')throw error;sound=fileURLToPath(new URL('voice-preview/touch.wav',ROOT));}
    }
    if(abort.signal.aborted||voiceProcess!==pendingVoice)return;
    child=spawn(runtime.python,
      ['-X','utf8',fileURLToPath(new URL('voice-chat/worker.py',ROOT)),'play',sound],{windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{if(voiceProcess===pendingVoice)voiceProcess=null;log('pet-audio-error',{voice});});
    child.on('exit',(code,signal)=>{if(voiceProcess===pendingVoice)voiceProcess=null;if(code===0)log('pet-audio-played',{voice});else if(!signal)log('pet-audio-error',{voice});});
  })().catch(()=>{if(voiceProcess===pendingVoice)voiceProcess=null;log('pet-audio-error',{voice});});
}

let mode='animation',lastCheck=0,lastMeta=0,textWritten=false,uploads=0,lastRaw='',lastVisual='',eventTask=null;
let sourceOrigin='http://127.0.0.1:10396';
try{
  const value=JSON.parse(await fs.readFile(new URL('source-origin.json',ROOT),'utf8')).origin;
  const parsed=new URL(value);
  if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Invalid local Harness origin');
  sourceOrigin=parsed.origin;
}catch(error){if(error.code!=='ENOENT')throw error;}
const model=new HarnessStatus(),typedTasks=new TypedTaskEvents(model,new SessionMetadata()),abort=new AbortController(),history=[];
function log(event,data={}){console.log(JSON.stringify({time:new Date().toISOString(),event,...data}));}
function remember(event){history.push(event);if(history.length>300)history.splice(0,history.length-300);}
async function save(extra={}){await writeJson(journal,{optimized:true,pid:process.pid,instanceId,startedAt,hold:true,owned,expected,snapshot,screenBackup,changedImage,mode,uploads,
  source:{base:model.base,visual:model.visual(),sessionId:model.sessionId,sourceAt:model.sourceAt,corrections:model.corrections},history,...extra});}
async function pauseForManual(current){
  if(manual)return;
  if(lightSession.active){
    let preserve=[];try{const old=JSON.parse(expected),next=JSON.parse(current.signature);preserve=old.devices.filter(d=>d.selected&&!next.devices.find(n=>n.id===d.id)?.selected).map(d=>d.id);}catch{}
    const localDeviceChange=preserve.length>0;
    if(!localDeviceChange)preserve=[...lightSession.saved.ids];
    await nativeLights.close();await keyboardBridge.stopWriter({restore:false});
    if(fireworks.active)await fireworks.stop(current.signature);
    const result=await lightSession.end({preserve,restoreScene:localDeviceChange});if(result)current=await mhub('status');
  }
  manual=true;owned=false;expected=current.signature;
  game.cancel('manual-takeover');pet.poll('DISCONNECTED');attention.interact();
  voiceProcess?.kill();panelProcess?.kill();await stopNumbers();
  if(fireworks.active)log('fireworks-manual-takeover',await fireworks.stop(expected));
  await fs.rm(gameFlag,{force:true});lastGameKeyMode='';
  log('manual-control-paused',{keepHotkeys:true});await save({phase:'manual-paused',manual:true});
}
async function resumeInteraction(){
  if(!manual)return;
  const current=await mhub('capture');snapshot=current;expected=current.signature;owned=true;manual=false;
  presenter.state=null;presenter.mode=null;
  log('manual-control-resumed');await save({phase:'running'});
}
function message(value){
  if(['state','pulse'].includes(value.kind)){
    const raw=value.kind+':'+value.state;
    if(raw!==lastRaw){lastRaw=raw;remember({kind:value.kind,state:value.state,at:new Date().toISOString()});log('source-event',{kind:value.kind,state:value.state,resumeState:value.resumeState});}
  }
}
async function events(){
  while(!stopping){
    let renewed=false;
    try{
      renewed=(await subscribeHarnessEvents(sourceOrigin,{signal:abort.signal,onActivity:()=>model.touchTransport(),onMessage:value=>typedTasks.enqueue(value)}))==='quiet';
      if(!stopping&&!renewed)log('source-reconnecting',{reason:'event-stream-closed'});
    }catch(error){
      if(!stopping)log('source-reconnecting',{reason:error.message});
    }
    if(stopping)return;
    try{const next=new URL(JSON.parse(await fs.readFile(new URL('source-origin.json',ROOT),'utf8')).origin);if(next.protocol==='http:'&&next.hostname==='127.0.0.1'&&next.pathname==='/'&&!next.username&&!next.password&&!next.search&&!next.hash)sourceOrigin=next.origin;}catch{}
    if(!renewed)await sleep(1000);
  }
}
const residentRotation=new ResidentRotation();
let customScreenClip=null;try{customScreenClip=await savedSpeakerClip();}catch(error){log('custom-screen-invalid',{reason:error.message});}
let nextResidentAttempt=0;
const presenter=new Presenter({
  async install(){
    if(!screenReady)return;
    const clip=customScreenClip??residentRotation.select();
    uploads++;changedImage=true;await save({phase:'installing-resident'});
    const ticker=setInterval(()=>{void heartbeat({operation:'installing-resident'});},1000);
    try{
      const result=await nativeLights.withLease(()=>installResident(clip),lightingLease);
      if(!customScreenClip)await residentRotation.applied(clip);
      log('resident-installed',{...result,clip:clip.id});
    }finally{clearInterval(ticker);}
  },
  async lights(style,state){
    if(!lightingWanted)return;
    let current=await mhub('status');
    if(owned&&current.signature!==expected){await sleep(250);current=await mhub('status');if(current.signature!==expected){await pauseForManual(current);return false;}}
    let deviceIds=connectedSelection(current,syncDevices.deviceIds).filter(id=>!communityWriting(communityTask)||id!==communityTask.keyboardId);
    if(!deviceIds.length){if(communityWriting(communityTask))return;throw Error('所选灯光设备暂未连接，重连后自动恢复');}
    const selection=await beginLightingSession(lightSession,deviceIds,speakerControlReady,pauseScreen);
    deviceIds=selection.ids;if(lightPreview){lightPreview.skipped=selection.skipped;lightPreview.deviceIds=[...deviceIds];}
    await lightSession.beforeWrite();
    if(fireworks.active&&state!=='GAME_CELEBRATE'){
      const stopped=await fireworks.stop(expected);log('fireworks-ended',stopped);
      if(!stopped.restored){await pauseForManual(await mhub('status'));return false;}
      expected=stopped.signature;await lightSession.markApplied(expected);current=await mhub('status');
      await lightSession.beforeWrite();
    }
    if(state==='GAME_CELEBRATE'){
      try{
        const reward=await fireworks.start(current.signature);expected=reward.signature;owned=true;
        await lightSession.markApplied(expected);
        game.markCelebrationStarted(reward.durationMs);log('fireworks-started',reward);return;
      }catch(error){
        log('fireworks-error',{reason:error.message});game.cancel('reward-error');
        const after=await mhub('status');if(after.signature!==expected)await pauseForManual(after);
        return false;
      }
    }
    let result;
    try{result=await mhub('emotion',{kind:'emotion',mood:state==='SUCCESS'?'happy':'calm',color:style.color,effect:style.effect||'steady',brightness:style.brightness??20,speed:style.speed??1,colorMode:style.colorMode??'solid',deviceIds,seconds:300,expiresAt:Date.now()/1000+20,expected:current.signature,keyboardOverride:game.active&&!game.celebrating});}
    catch(error){if(error.message.includes('M HUB 设置已被手动改变')){await lightSession.cancelWrite();await pauseForManual(await mhub('status'));return false;}throw error;}
    owned=true;expected=result.signature;await lightSession.markApplied(expected);await sleep(250);
  },
  async animation(style){log('display-animation',await displayResident(rgb(style.color)));},
  async tint(style){log('display-tint',await tintResident(rgb(style.color)));},
  async text(style){textWritten=true;log('display-text',await displayText(style.label,rgb(style.color)));},
});
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
// Only the explicit startup transaction clears an older stop request.
await fs.rm(handoffFile,{force:true});await fs.rm(touchFile,{force:true});
await fs.mkdir(inbox,{recursive:true});await fs.rm(gameFlag,{force:true});
try{
  // The debug port becomes available before the app and device stores.
  // Readiness must precede every writer, including balance restoration.
  while(!stopping){
    if(await stopRequested()){stopping=true;break;}
    if(await fs.access(handoffFile).then(()=>true,()=>false)){handoff=true;break;}
    await heartbeat({phase:'waiting-for-mhub'});
    if(connectionRecovery.ready){
      try{await mhub('status');connectionRecovery.success();break;}
      catch(error){await connectionRecovery.fail(error);}
    }
    await sleep(Math.max(150,Math.min(1000,connectionRecovery.nextAt-Date.now())));
  }
  if(handoff||stopping||await stopRequested()){stopping=true;throw Error('设备联动启动已取消');}
  await keyboardBridge.start();
  await balanceBar.init();
  await stopLegacyBridge({directory:fileURLToPath(new URL('../dafeiyu-mhub-bridge/',ROOT))});
  const recoveredFireworks=await fireworks.recover();if(recoveredFireworks)log('fireworks-recovered',recoveredFireworks);
  const recoveredLights=await lightSession.recover().catch(error=>{log('lights-recovery-pending',{reason:error.message});return null;});if(recoveredLights)log('interrupted-lights-restored',recoveredLights);
  const recoveredAsset=await assetPlayback.recover().catch(error=>{log('asset-recovery-pending',{reason:error.message});return null;});if(recoveredAsset)log('interrupted-asset-restored',recoveredAsset);
  await phoneVisual.recover().catch(error=>log('phone-recovery-pending',{reason:error.message}));
  await recoverCommands(ROOT);
  await residentRotation.init();
  const current=await mhub('capture');
  const initialScreen=await screenSnapshot().catch(error=>{pauseScreen(error);return null;});
  speakerControlReady=!!initialScreen;
  const activeHandoff=previous?.owned&&(previous.expected===current.signature||recoveredFireworks?.restored===true);
  const pendingRestore=previous?.changedImage&&!previous.owned&&previous.snapshot?.signature===current.signature;
  const recoveryClip=customScreenClip??residentRotation.catalog.find(clip=>clip.id===residentRotation.current?.id);
  const recoveredScreen=initialScreen?recoverableScreen(previous,initialScreen,recoveryClip):null,recoverResident=recoveredScreen==='resident';
  if(initialScreen&&(activeHandoff||pendingRestore||recoveredScreen)&&previous.snapshot&&previous.screenBackup&&!initialScreen.imageName){
    snapshot=activeHandoff||pendingRestore?previous.snapshot:current;screenBackup=previous.screenBackup;changedImage=previous.changedImage;
    screenReady=!!recoveredScreen;
    log(recoveredScreen&&!activeHandoff&&!pendingRestore?recoveredScreen+'-session-recovered':'session-adopted');
  }else{
    snapshot=current;
    if(ownedScreenContent(initialScreen,recoveryClip)){screenBackup=initialScreen;screenReady=true;changedImage=false;}
    else if(!initialScreen&&previous?.optimized&&previous.changedImage&&previous.screenBackup){
      screenBackup=previous.screenBackup;changedImage=true;
    }
  }
  captionOnly=!!initialScreen&&!screenReady;
  if(!screenReady)screenError=screenError??'保留音箱当前素材。语音字幕可以临时显示。';
  if(screenBackup&&!screenBackup.text)screenBackup.text=await textSnapshot().catch(()=>null);
  expected=current.signature;owned=true;await save({phase:'preparing'});
  expected=(await mhub('status')).signature;
  await affinity.init();
  const resident=initialScreen,knownClip=customScreenClip??residentRotation.catalog.find(clip=>clip.id===residentRotation.current?.id);
  if(screenReady&&(activeHandoff||recoverResident)&&(customScreenClip||!residentRotation.due())&&knownClip&&resident.image.imageCount===12&&resident.image.imageBytes===12288&&resident.image.delay===knownClip.delay/10){
    rememberResident(knownClip);presenter.installed=true;changedImage=true;log('resident-reused');
  }else if(screenReady)await screenOperation(()=>presenter.install());
  
  const modeArg=process.argv.indexOf('--mode');
  if(modeArg>=0){mode=process.argv[modeArg+1];if(!SCREEN_MODES.includes(mode))throw Error('Invalid mode');await writeModeOverride(ROOT,mode);}
  else mode=readModeOverride(ROOT)??mode;
  eventTask=events();log('optimized-watching',{mode,phaseFlapsMerged:true,perStateImageUploads:false});
  hotkeyProcess=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('Hotkey-Bindings.ps1',ROOT)),'-ParentId',String(process.pid)],{windowsHide:true,stdio:'ignore'});
  hotkeyProcess.on('error',()=>log('pet-hotkey-error'));
  while(!stopping){
    await heartbeat();
    if(await stopRequested()){stopping=true;break;}
    try{await fs.access(handoffFile);handoff=true;break;}catch{}
    void mouseBindingRecovery.poll();
    if(!connectionRecovery.ready){await sleep(Math.min(1000,connectionRecovery.nextAt-Date.now()));continue;}
    try{
    if(connectionRecovery.failures){
      const current=await mhub('status');
      if(owned&&expected!==current.signature&&lightSession.active){
        let sameLights=false;try{const old=JSON.parse(expected),next=JSON.parse(current.signature);sameLights=old.id===next.id&&JSON.stringify(old.lights)===JSON.stringify(next.lights);}catch{}
        if(current.companion&&sameLights)expected=current.signature;else await pauseForManual(current);
      }
      await invalidateDevices();
    }
    if(Date.now()-lastMeta>250){
      lastMeta=Date.now();
      if(await typedTasks.poll(message)){log('completion-reconciled',{state:typedTasks.visual()});await save();}
    }
    let phone=await phoneVisual.request();
    if(phone)await affinity.phone(phone).catch(error=>log('affinity-error',{reason:error.message}));
    else{
      const ended=await fs.readFile(new URL('phone/state.json',ROOT),'utf8').then(JSON.parse).catch(()=>null);
      if(ended?.phase==='ended'&&Date.now()-ended.at<3500)await affinity.phone(ended).catch(error=>log('affinity-error',{reason:error.message}));
    }
    const nextCommunity=await readCommunityTask();
    const nextCommunityKey=communityWriting(nextCommunity)?nextCommunity.id+':'+nextCommunity.keyboardId:null;
    // Never resume a hardware writer while a previously approved commit is
    // still in flight, even if the PTT request was interrupted in the meantime.
    if(deviceWritePending()&&!communityWriting(nextCommunity)){
      await heartbeat({phase:'community-board-commit'});await sleep(200);continue;
    }
    if(nextCommunityKey!==communityPhaseKey&&(nextCommunityKey||communityPhaseKey)){
      await nativeLights.close();await keyboardBridge.stopWriter();
      if(lightSession.active)await lightSession.end();
      const strip=await balanceBar.ambient.close();
      if(strip?.pendingRestore)throw Error('板载写入前余额灯条尚未释放');
      expected=(await mhub('status')).signature;owned=true;
      presenter.state=null;presenter.styleKey=null;balanceBar.ambient.reassert();
    }
    communityTask=nextCommunity;communityPhaseKey=nextCommunityKey;
    communityKeyboardReleased=!!nextCommunityKey;
    // Only an incoming ring owns its keyboard ripple and deep-press key.
    // Dialing and connected calls never take over task lights or speaker pages.
    if(phone?.phase==='incoming'&&!communityWriting(communityTask)){
      if(assetPlayback.active)await stopAssetPlayback();
      begRequest=null;
      if(phoneVisual.id!==phone.id){
        if(phoneVisual.id)await phoneVisual.end();
        phoneSavedManual=manual;game.cancel('phone');voiceProcess?.kill();panelProcess?.kill();await stopNumbers();
        await nativeLights.close();await keyboardBridge.stopWriter();
        if(fireworks.active)await fireworks.stop(expected);
        if(lightSession.active)await lightSession.end();
        phone=await phoneVisual.request();if(phone?.phase!=='incoming')continue;
        const scene=await mhub('status');
        const ids=scene.master?connectedSelection(scene,syncDevices.deviceIds):scene.connectedDeviceIds;
        await phoneVisual.begin(phone,ids,{master:scene.master});
      }
      await phoneVisual.poll(phone);
      const old=JSON.parse(await fs.readFile(new URL('control-status.json',ROOT),'utf8'));
      await writeJson(new URL('control-status.json',ROOT),{...old,pid:process.pid,at:Date.now(),phone:phoneVisual.status,keyboardOutput:keyboardBridge.status});
      connectionRecovery.success();await heartbeat({phone:phone.phase});await sleep(100);continue;
    }
    if(phoneVisual.id||phoneVisual.screen){await phoneVisual.end();manual=phoneSavedManual;owned=true;expected=(await mhub('status')).signature;voiceScreenKey=null;presenter.state=null;presenter.mode=null;hardwareScreen.pageKey=null;balanceBar.ambient.reassert();}
    if(!communityWriting(communityTask))await balanceBar.poll(sourceOrigin,{screenBalance:mode==='pages'&&hardwareScreen.pages.balance});
    await weather.poll();
    if(await controls.poll()){presenter.state=null;presenter.styleKey=null;}
    if(await syncDevices.poll()){presenter.state=null;presenter.styleKey=null;}
    await subtitles.poll();
    if(assetPlayback.active&&await assetPlayback.changed())await stopAssetPlayback();
    keyboardBridge.allow((lightSession.active&&!manual||assetPlayback.active)&&!game.active);await nativeLights.poll(lightSession.active&&!manual||assetPlayback.active,keyboardBridge.token,assetEngineOptions());
    if(screenReady)await screenOperation(()=>hardwareScreen.poll());
    if(!screenReady&&!captionOnly&&Date.now()>=nextScreenProbe){
      nextScreenProbe=Date.now()+10000;
      try{
        const currentScreen=await screenSnapshot();
        speakerControlReady=true;
        const clip=customScreenClip??residentRotation.catalog.find(c=>c.id===residentRotation.current?.id);
        const recovered=recoverableScreen(previous,currentScreen,clip);
        if(recovered){
          screenReady=true;captionOnly=false;screenError=null;screenBackup??=previous?.screenBackup??currentScreen;
          if(recovered==='resident'){rememberResident(clip);presenter.installed=true;changedImage=true;}
          else await screenOperation(()=>presenter.install());
          if(screenReady){presenter.state=null;presenter.mode=null;hardwareScreen.pageKey=null;log('screen-channel-restored',{recovered});}
        }else{captionOnly=true;screenError='保留音箱当前素材。语音字幕可以临时显示。';}
      }catch(error){pauseScreen(error);}
    }
    try{await fs.access(handoffFile);handoff=true;break;}catch{}
    if(await stopRequested()){stopping=true;break;}
    mode=readModeOverride(ROOT)??mode;
    if(screenReady)await screenOperation(()=>hardwareScreen.pageButtons(mode==='pages'));
    if(Date.now()-lastCheck>1000){
      const current=await mhub('status');lastCheck=Date.now();
      if(deviceKey!==null&&current.deviceKey!==deviceKey){await invalidateDevices();log('device-topology-changed');}deviceKey=current.deviceKey;
      if(owned&&current.signature!==expected){if(!lightSession.active)expected=current.signature;else{await sleep(250);const confirmed=await mhub('status');if(confirmed.signature!==expected)await pauseForManual(confirmed);}}
    }
    const harnessTaskState=typedTasks.visual(),rawTask=communityRawState(harnessTaskState,communityTask),base=rawTask==='THINKING'||rawTask==='WORKING'?'BUSY':rawTask;
    if(manual&&!taskNeedsLighting(rawTask)){manual=false;owned=true;expected=(await mhub('status')).signature;presenter.state=null;}
    let reply=null,commandsChanged=false;const touches=[];
    let host={};try{host=JSON.parse(await fs.readFile(new URL('pet-hotkey-status.json',ROOT),'utf8'));}catch{}
    if(host.parent!==process.pid||Date.now()-host.observedAt>10000)host={};
    const context={active:Number.isFinite(host.inputIdleMs)&&host.inputIdleMs<120000,fullscreen:host.fullscreen,quiet:nightQuiet()};
    for(const file of (communityWriting(communityTask)?[]:await fs.readdir(inbox)).filter(n=>/^\d{13}-[a-zA-Z0-9-]+\.json$/.test(n)).sort().slice(0,32)){
      const path=new URL(file,inbox);let command;
      const processing=new URL('interaction-processing/',ROOT);await fs.mkdir(processing,{recursive:true});const claim=new URL(file,processing);await fs.rename(path,claim);
      try{command=JSON.parse(await fs.readFile(claim,'utf8'));}catch{}
      try{
      if(commandExpired(command)||command.at<readDeviceLink().at){
        if(['screen-device-asset','device-default-theme','rgb-device-asset-play','rgb-device-asset-stop'].includes(command?.kind)&&/^[a-f0-9-]{36}$/.test(command.id??'')){
          await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});
          await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:false,error:'上传请求等待过久，未开始写屏；请恢复联动后重试。',at:Date.now()});
        }
        continue;
      }
      if(command.applyToken!==undefined&&command.applyToken!==intentToken()){await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:false,error:'自动应用已取消，素材已保留。'});continue;}
      if(command.kind==='device-default-theme'||command.kind==='rgb-device-asset-stop')invalidateIntent();
      if(command.kind==='mouse-rear'){
        let bindings=DEFAULT_BINDINGS;try{bindings={...bindings,...JSON.parse(await fs.readFile(new URL('hotkeys.settings.json',ROOT),'utf8'))};}catch{}
        command.kind=bindings.mouseRearAction;
      }
      if(command.kind==='pet-sweep'){
        if(game.active)continue;
        command.kind='pet';
      }
      if(['rgb-device-asset-play','rgb-device-asset-stop'].includes(command.kind)){
        let takingOver=false;
        try{
          if(command.kind==='rgb-device-asset-stop'){
            const result=await stopAssetPlayback();await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:true,...result,at:Date.now()});
          }else{
            if(game.active||lightPreview)throw Error('正在游戏或试灯，请稍后应用设备动画。');
            const prepared=await assetPlayback.prepare(command.assetId);
            if(command.applyToken!==undefined&&command.applyToken!==intentToken())throw Error('自动应用已取消，素材已保留。');
            // RGB output does not own the screen; speech captions can continue.
            if(assetPlayback.active)await stopAssetPlayback();
            await nativeLights.close();await keyboardBridge.stopWriter();
            if(lightSession.active)await lightSession.end();
            takingOver=true;
            const result=await assetPlayback.start(command.assetId,prepared);expected=result.signature;owned=true;manual=false;
            keyboardBridge.mainOnly=true;keyboardBridge.allow(true);nativeLights.last=0;
            const deadline=Date.now()+10000;let confirmed=false;
            while(Date.now()<deadline){await heartbeat({operation:'starting-device-animation'});await nativeLights.poll(true,keyboardBridge.token,assetEngineOptions());const n=nativeLights.status;
              if(n?.error)throw Error(n.error);
              const keyboardIds=result.ids.filter(id=>BALANCE_KEYBOARDS.some(s=>s.id===id));
              const writersReady=keyboardIds.every(id=>keyboardBridge.workers.get(id)?.status?.state==='running'&&keyboardBridge.workers.get(id).status.at>=result.startedAt);
              if(n?.lastFrameAt>=result.startedAt&&result.ids.every(id=>n.devices?.includes(id))&&writersReady){confirmed=true;break;}await sleep(200);
            }
            if(!confirmed)throw Error('场景已选择，但实时灯光输出未确认，已停止并恢复原灯效。');
            await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:true,assetId:command.assetId,activated:true,outputVerified:true,physicalConfirmed:false,sceneId:result.sceneId,name:result.name,devices:result.ids,nonBlack:nativeLights.status.nonBlack,at:Date.now()});
          }
          lastControlCommand={id:command.id,ok:true};
        }catch(error){
          if(takingOver)await stopAssetPlayback().catch(cleanup=>log('asset-restore-error',{reason:cleanup.message}));
          await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:false,assetId:command.assetId,error:error.message,at:Date.now()});lastControlCommand={id:command.id,ok:false,error:error.message};
        }
        continue;
      }
      if(assetPlayback.active&&['task-light-preview','pet','game-start','game-toggle','beg-demo','fireworks-demo'].includes(command.kind))await stopAssetPlayback();
      if(command.kind==='device-default-theme'){
        let ticker;const oldListening=hardwareScreen.listening;
        try{
          const clip=residentRotation.catalog.find(v=>v.id==='idle');
          ticker=setInterval(()=>{void heartbeat({operation:'restoring-dafeiyu-theme'});},1000);
          const result=await restoreDefaultTheme({
            busy:game.active||previousVoiceScreen||pet.visual(base).startsWith('PET'),clip,
            alreadyInstalled:!customScreenClip&&presenter.installed&&residentRotation.current?.id==='idle',
            prepare:async clip=>{const bytes=await fs.readFile(new URL('assets/residents/'+clip.id+'.bin',ROOT));if(bytes.length!==12288||crc32(bytes)!==clip.crc32)throw Error('默认大肥鱼动画校验失败，未更改设备。');},
            stopRgb:stopAssetPlayback,
            stopTask:async()=>{lightPreview=null;lastPreviewLights=null;if(lightSession.active){await nativeLights.close();await keyboardBridge.stopWriter();await lightSession.end();}manual=false;owned=true;expected=(await mhub('status')).signature;balanceBar.ambient.reassert();},
            block:()=>hardwareScreen.pageButtons(false),
            install:clip=>nativeLights.withLease(()=>installResident(clip),lightingLease),
            display:()=>displayResident([70,150,255]),
            verify:async clip=>{const actual=await screenSnapshot();return {verified:actual.screen.enabled&&actual.screen.mode===0&&actual.screen.theme===8&&actual.image.imageCount===12&&actual.image.imageBytes===12288&&actual.image.delay===clip.delay/10,frames:actual.image.imageCount,bytes:actual.image.imageBytes};},
            commit:async clip=>{screenReady=true;speakerControlReady=true;screenError=null;customScreenClip=null;changedImage=true;presenter.installed=true;presenter.state=null;presenter.mode=null;presenter.styleKey=null;await residentRotation.applied(clip);await fs.rm(new URL('screen-user-asset.json',ROOT),{force:true});hardwareScreen.page='fish';hardwareScreen.pageKey=null;hardwareScreen.cacheKey=null;hardwareScreen.screenOff=false;mode=hardwareScreen.pages.fish?'pages':'animation';await writeModeOverride(ROOT,mode);await hardwareScreen.capture(true);await save({phase:'running'});},
            unblock:()=>hardwareScreen.pageButtons(mode==='pages'||oldListening&&mode!=='animation'),
          });
          await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:true,...result,at:Date.now()});
          lastControlCommand={id:command.id,ok:true};log('default-theme-restored',{resident:clip.id,uploaded:result.uploaded});
        }catch(error){await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:false,error:error.message,at:Date.now()});lastControlCommand={id:command.id,ok:false,error:error.message};}
        finally{clearInterval(ticker);}
        continue;
      }
      if(command.kind==='screen-device-asset'){
        let ticker;
        try{
          if(game.active||previousVoiceScreen||lightPreview)throw Error('正在语音、游戏或试灯，请稍后再上传音箱。');
          const clip=await speakerAssetClip(command.assetId);
          await hardwareScreen.pageButtons(false);
          ticker=setInterval(()=>{void heartbeat({operation:'uploading-user-screen'});},1000);
          const result=await nativeLights.withLease(()=>installResident(clip),lightingLease);
          await hardwareScreen.capture(true);const screen=hardwareScreen.held;
          if(!screen?.enabled||screen.mode!==0||screen.theme!==8||screen.index!==1)throw Error('点阵已上传，音箱未切换到自定义动画；请检查屏幕状态。');
          screenReady=true;speakerControlReady=true;screenError=null;customScreenClip=clip;changedImage=true;presenter.installed=true;presenter.state=null;
          mode='manual';await writeModeOverride(ROOT,mode);await writeJson(new URL('screen-user-asset.json',ROOT),{assetId:command.assetId,at:Date.now()});
          hardwareScreen.pageKey=null;
          await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});
          await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:true,uploaded:true,displayed:true,screenVerified:true,assetId:command.assetId,...result,at:Date.now()});
          lastControlCommand={id:command.id,ok:true};await save({phase:'running'});
        }catch(error){
          await fs.mkdir(new URL('asset-receipts/',ROOT),{recursive:true});await writeJson(new URL('asset-receipts/'+command.id+'.json',ROOT),{ok:false,error:error.message,at:Date.now()});
          lastControlCommand={id:command.id,ok:false,error:error.message};
        }finally{clearInterval(ticker);}
        continue;
      }
      if(command.kind==='task-light-preview'){
        if(!TASK_STATES.includes(command.state))continue;
        try{const style=validateStyle(command.style);if(game.active){lastControlCommand={id:command.id,ok:false,error:'请先退出记忆游戏再试灯光。'};continue;}
          if(assetPlayback.active)await stopAssetPlayback();
          if(manual)await resumeInteraction();lightPreview={id:command.id,state:command.state,style,phase:'applying',until:null};lastPreviewLights=null;
          lastControlCommand={id:command.id,ok:null,phase:'accepted'};
        }catch(e){lastControlCommand={id:command.id,ok:false,error:e.message};}continue;
      }
      if(command.kind==='task-light-stop'){if(screenReady&&lightPreview&&mode==='manual')await screenOperation(()=>hardwareScreen.restore());lightPreview=null;presenter.state=null;lastPreviewLights=null;lastControlCommand={id:command.id,ok:true};continue;}
      if(command.kind==='balance-refresh'){balanceBar.refresh({clearSource:command.clearSource===true});if(command.preferStandalone===true)balanceBar.requestStandalone();lastControlCommand={id:command.id,ok:true};continue;}
      if(command.kind==='subtitle-preview'){subtitlePreview={id:command.id,until:Date.now()+16000};voiceScreenKey=null;lastControlCommand={id:command.id,ok:true};continue;}
      if(command.kind==='screen-page-next'){
        if(!screenReady||hardwareScreen.screenOff){lastControlCommand={id:command.id,ok:false,error:screenError||'请先打开音箱屏幕。'};continue;}
        const deferred=!!(phone||previousVoiceScreen||game.active||lightPreview||manual||base!=='IDLE');
        const applied=await screenOperation(async()=>{
          if(mode!=='pages'){mode='pages';await writeModeOverride(ROOT,mode);await hardwareScreen.pageButtons(true);}
          await hardwareScreen.nextPage();
          if(!deferred)await hardwareScreen.renderPage(controls.lights.IDLE,balanceBar.snapshot,affinity.value,weather.status());
          return true;
        });
        lastControlCommand={id:command.id,ok:applied===true,deferred,...(!applied?{error:screenError}:{})};
        continue;
      }
      if(command.kind==='screen-animation-next'){customScreenClip=null;await fs.rm(new URL('screen-user-asset.json',ROOT),{force:true});residentRotation.requested=true;nextResidentAttempt=0;continue;}
      commandsChanged=true;
      if(manual&&((command.kind==='pet'&&['IDLE','BUSY'].includes(base))||(['game-start','game-toggle','beg-demo','fireworks-demo'].includes(command.kind)&&base==='IDLE')))await resumeInteraction();
      if(command.kind==='pet'){
        const result=pet.touch(base,command,{blocked:game.active});if(result.consumed)reply=result;if(result.accepted)touches.push({...result,id:command.id,at:command.at});
      }else if(['game-start','game-toggle','game-stop'].includes(command.kind)){
        attention.interact();
        if(game.active&&command.kind!=='game-start'){game.cancel('owner');voiceProcess?.kill();}
        else if(command.kind!=='game-stop'&&game.start(base))log('memory-game-started');
      }else if(command.kind==='game-replay'&&game.replay()){voiceProcess?.kill();log('memory-game-replay');}
      else if(command.kind==='fireworks-demo'&&game.demoCelebration(base)){attention.interact();voiceProcess?.kill();log('fireworks-demo-requested');}
      else if(command.kind==='color'&&game.answer(command.value)){log('memory-game-answer',{position:game.position,result:game.lastResult});}
      else if(command.kind==='beg-demo'){
        const accepted=!phone&&!previousVoiceScreen&&!game.active&&attention.request(base,context,true);
        if(accepted){begRequest={start:Date.now(),until:attention.until,demo:true};playPet('beg.wav');log('attention-request',{demo:true});}
        lastControlCommand={id:command.id,ok:accepted,...(!accepted?{error:'请在通话、语音和游戏结束后测试求摸摸'}:{})};
      }
      else if(['attention-off','attention-on'].includes(command.kind)){
        attentionEnabled=command.kind==='attention-on';attention.interact();
        await fs.writeFile(new URL('playtime-settings.json',ROOT),JSON.stringify({attentionEnabled}));
      }
      }finally{if(command?.id){try{await fs.access(new URL('asset-receipts/'+command.id+'.json',ROOT));await fs.rm(claim,{force:true});}catch{if(!['screen-device-asset','device-default-theme','rgb-device-asset-play','rgb-device-asset-stop'].includes(command.kind))await fs.rm(claim,{force:true});}}}
    }
    const panelReady=game.phase==='arming'&&await gameWindowReady();
    const keysReady=host.gameKeysReady===true&&host.observedAt>=game.startedAt;
    game.tick(base,{keysReady,panelReady,voiceBusy:voiceProcess!==null});
    const gameKeyMode=game.active?(game.phase==='paused'?'paused':'game'):'';
    if(lastGameKeyMode!==gameKeyMode){
      if(game.active)await fs.writeFile(gameFlag,gameKeyMode);else await fs.rm(gameFlag,{force:true});
      lastGameKeyMode=gameKeyMode;
    }
    const gameState=game.visual();
    if(!game.active||game.celebrating)await stopNumbers();
    if(game.active&&!panelProcess){
      const panel=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('Game-Panel.ps1',ROOT)),'-ParentId',String(process.pid)],{windowsHide:true,stdio:'ignore'});
      panelProcess=panel;panel.on('error',()=>{game.cancel('panel-error');log('game-panel-error');});
      panel.on('exit',code=>{if(panelProcess===panel)panelProcess=null;if(code){game.cancel('panel-error');log('game-panel-error',{code});}});
    }
    try{const request=JSON.parse(await fs.readFile(touchFile,'utf8'));if(manual&&typeof request.id==='string'&&Number.isFinite(request.at)&&Math.abs(Date.now()-request.at)<10000&&!pet.events.has(request.id)&&['IDLE','BUSY'].includes(base))await resumeInteraction();const result=pet.touch(base,request,{blocked:game.active});if(result.consumed)reply=result;if(result.accepted)touches.push({...result,id:request.id,at:request.at});}catch{}
    if(base!=='IDLE'||game.active||manual)begRequest=null;
    if(touches.length){
      // All accepted touches share this path, including the rear mouse button and its macro.
      if(!live2dTouchPending){
        live2dTouchPending=true;
        void playLive2dTouch().then(played=>{
          live2dTouchPending=false;
          if(played)log('live2d-touch-played',{animation:'害羞'});
        });
      }
      for(const touch of touches){
        const responding=begRequest&&touch.at>=begRequest.start&&touch.at<=begRequest.until;
        await affinity.apply(responding?'requestedTouch':'touch','touch:'+touch.id).catch(error=>log('affinity-error',{reason:error.message}));
        if(responding)begRequest=null;
      }
      affinityUntil=Date.now()+4000;
      attention.interact();if(voiceProcess?.petFile==='beg.wav')voiceProcess.kill();
    }
    const speech=pet.poll(base,{blocked:game.active,voiceBusy:voiceProcess!==null});
    if(reply?.consumed||speech)await savePetState();
    const petState=pet.visual(base);
    if(game.active)attention.interact();
    if(screenReady&&mode==='manual'&&!game.active&&!previousVoiceScreen&&!previousGameScreen&&!lightPreview)await hardwareScreen.capture().catch(e=>hardwareScreen.error=e.message);
    let voiceOwnsScreen=false;
    try{voiceOwnsScreen=await voiceDisplay();}catch(error){if(isSpeakerScreenError(error))pauseScreen(error);else throw error;}
    if(screenReady&&mode==='manual'&&!voiceOwnsScreen&&!game.active&&(previousVoiceScreen||previousGameScreen))await hardwareScreen.restore().catch(e=>hardwareScreen.error=e.message);
    previousVoiceScreen=voiceOwnsScreen;previousGameScreen=game.active;
    if(voiceOwnsScreen||game.active||lightPreview)hardwareScreen.pageKey=null;
    if(phone||voiceOwnsScreen||!attentionEnabled||context.fullscreen||context.quiet||!context.active)begRequest=null;
    if(begRequest&&Date.now()>=begRequest.until){
      if(!begRequest.demo)await affinity.apply('missedTouch','beg:'+begRequest.start).catch(error=>log('affinity-error',{reason:error.message}));
      begRequest=null;
    }
    if(!phone&&!voiceOwnsScreen&&!manual&&!game.active&&!petState.startsWith('PET')&&attention.request(base,{...context,quiet:context.quiet||!attentionEnabled})){
      begRequest={start:Date.now(),until:attention.until};
      playPet('beg.wav');log('attention-request',{demo:false});
    }
    if(lightPreview&&lightPreview.until!==null&&Date.now()>=lightPreview.until){if(screenReady&&mode==='manual')await hardwareScreen.restore();lightPreview=null;presenter.state=null;lastPreviewLights=null;}
    const taskState=stableTask.select(rawTask,controls.lights);
    const state=lightPreview?.state||gameState||(petState.startsWith('PET')?petState:null)||attention.visual(base)||taskState;
    lightingWanted=!assetPlayback.active&&(!!lightPreview||game.active||/^(PET|BEG)/.test(state)||taskNeedsLighting(rawTask));
    if(!lightingWanted&&lightSession.active){
      await nativeLights.close();await keyboardBridge.stopWriter();
      const restored=await lightSession.end();expected=restored.signature;owned=true;balanceBar.ambient.reassert();
      log('task-native-lights-restored',{at:restored.at});
    }
    const showingAffinity=Date.now()<affinityUntil&&state.startsWith('PET')&&!voiceOwnsScreen&&!manual&&!hardwareScreen.screenOff&&mode!=='manual';
    const taskStyle=showingAffinity?{label:affinityText(affinity.value),color:'#FF0000',effect:'breathing',brightness:25}:
      lightPreview?.style||controls.lights[state]||(state==='BUSY'?{...controls.lights.WORKING,label:'正在处理'}:undefined);
    const screenPlan=taskScreenPlan({mode,state,gameState,celebrating:game.celebrating,preview:lightPreview,feedback:taskScreen.update(rawTask,controls.lights),voice:voiceOwnsScreen,manual,screenOff:hardwareScreen.screenOff});
    if(showingAffinity)Object.assign(screenPlan,{mode:'text',suppressScreen:false,phase:'affinity',overlay:{label:taskStyle.label}});
    const fishVisible=mode==='animation'||mode==='pages'&&hardwareScreen.page==='fish';
    if(screenReady&&fishVisible&&state==='IDLE'&&!screenPlan.overlay&&!voiceOwnsScreen&&!game.active&&!lightPreview&&!manual&&!hardwareScreen.screenOff&&residentRotation.due()&&Date.now()>=nextResidentAttempt){
      nextResidentAttempt=Date.now()+60000;
      await screenOperation(()=>presenter.output.install());
      hardwareScreen.pageKey=null;presenter.state=null;
    }
    if(screenReady)await screenOperation(()=>hardwareScreen.blockPages(voiceOwnsScreen||game.active||!!lightPreview||manual||!!screenPlan.overlay||/^(PET|BEG)/.test(state)));
    if(screenPlan.overlay)hardwareScreen.pageKey=null;
    if(!/^(PET|GAME_|BEG)/.test(state)&&voiceProcess)voiceProcess.kill();
    await displayRecovery.run(async()=>{
    if(lightPreview&&lastPreviewLights!==lightPreview.id&&!manual){
      const preview=lightPreview,baseline=new Map([...keyboardBridge.workers].map(([id,w])=>[id,{pid:w.child?.pid,frames:keyboardWriterOwned(w.status,w.child?.pid)?Number(w.status?.frames)||0:0}]));
      if(await presenter.output.lights(taskStyle,state)===false)throw Error('M HUB 灯效已被手动更改，试用未接管');
      const since=Date.now();keyboardBridge.allow(true);nativeLights.last=0;
      const output=await confirmPreviewOutput({ids:preview.deviceIds,keyboardIds:preview.deviceIds.filter(id=>BALANCE_KEYBOARDS.some(s=>s.id===id)),since,baseline,
        poll:()=>nativeLights.poll(true,keyboardBridge.token,assetEngineOptions()),nativeStatus:()=>nativeLights.status,
        writerStatus:id=>{const w=keyboardBridge.workers.get(id);return w?{pid:w.child?.pid,status:w.status}:null;},
        current:()=>!stopping&&readDeviceLink().enabled&&lightPreview===preview,heartbeat:()=>heartbeat({operation:'confirming-light-preview'})});
      lastPreviewLights=lightPreview.id;
      lightPreview.phase='running';lightPreview.output=output;
      lightPreview.until=output.until;
      lastControlCommand={id:lightPreview.id,ok:true,phase:'running',...output,...(lightPreview.skipped?.length?{warning:'音箱 USB 控制通道未就绪，本次仅试用其他已连接设备；音箱未被接管。',skipped:lightPreview.skipped}:{})};
    }
    const suppressScreen=!screenReady||voiceOwnsScreen||screenPlan.suppressScreen;
    if(!manual&&await presenter.render(state,screenPlan.mode,{...(gameState?{label:game.screenLabel()}:{style:taskStyle,...(screenPlan.overlay?{label:screenPlan.overlay.label}:{})}),suppressScreen,lightsHandled:!!lightPreview||assetPlayback.active})){
      if(!suppressScreen)screenFailures=0;
      lastVisual=state;remember({visual:state,mode,at:new Date().toISOString()});log('visual-applied',{state,mode,uploads});await save({phase:'running'});
    }
    if(screenReady&&screenPlan.renderPage)await screenOperation(async()=>{
      await hardwareScreen.renderPage(controls.lights[taskState]??controls.lights.WORKING,balanceBar.snapshot,affinity.value,weather.status());
      screenFailures=0;
    });
    const screenFeedback={phase:voiceOwnsScreen?'voice':screenReady?screenPlan.phase:'unavailable',text:voiceOwnsScreen?null:screenReady?(screenPlan.overlay?.label??(mode==='text'?taskStyle?.label:null)):screenError,baseMode:mode,basePage:mode==='pages'?hardwareScreen.page:null};
    if(JSON.stringify(screenFeedback)!==JSON.stringify(lastScreenFeedback)){lastScreenFeedback=screenFeedback;log('task-screen-changed',screenFeedback);}
    },async error=>{
      if(isSpeakerScreenError(error)){if(lightPreview?.phase==='applying')await failLightPreview(error);pauseScreen(error);return;}
      await connectionRecovery.fail(error);
      log('display-retrying',{state,reason:error.message});
      await failLightPreview(error);
      presenter.state=null;presenter.styleKey=null;
    });
    // Only the balance enable action may take over a conflicting synced strip.
    if(!communityWriting(communityTask)){
    try{if(await balanceBar.ensureStandalone(!assetPlayback.active&&!lightSession.active&&!game.active&&!fireworks.active)){
      expected=(await mhub('status')).signature;owned=true;log('balance-disabled-constant-sync');
    }}catch(error){log('balance-sync-release-retrying',{reason:error.message});}
    if(lightSession.active&&!manual&&!fireworks.active){
      try{
        const strip=await balanceBar.sync(expected,!game.active,{writeStatus:false,beforeWrite:()=>lightSession.beforeWrite()});
        if(strip&&!strip.changed)await lightSession.cancelWrite();
        if(strip?.reason==='manual-change')await pauseForManual(await mhub('status'));
        else if(strip?.changed){expected=strip.signature;owned=true;if(lightSession.active)await lightSession.markApplied(expected);log('balance-strip-updated',{visible:strip.visible,segments:strip.segments});await save({phase:'running'});}
      }catch(error){log('balance-strip-error',{reason:error.message});}
    }
    try{
      const balanceWriter=keyboardBridge.workers.get('GT 75')?.status;
      const nativeSideLease=!!(assetPlayback.active&&keyboardBridge.mainOnly&&balanceWriter?.balancePinned&&balanceWriter.state==='running'&&Date.now()-balanceWriter.at<5000);
      const balanceStatus=await balanceBar.syncAmbient(!game.active&&!lightSession.active&&!fireworks.active,{nativeSideLease});
      if(!balanceStatus.enabled){
        const current=await mhub('status');
        const removed=await balanceBar.removeOverlay(lightSession.active?expected:current.signature,()=>lightSession.beforeWrite());
        if(removed.changed){expected=removed.signature;await lightSession.markApplied(expected);}
        else if(!removed.throttled)await lightSession.cancelWrite();
      }
    }catch(error){log('balance-native-retrying',{reason:error.message});}
    } // Community board commits exclusively own the keyboard, including its strip.
    if(game.active&&!game.celebrating){
      const highlight=game.phase==='show'?game.sequence[game.showIndex]:game.phase==='feedback'?game.echo:-1;
      if(!numberProcess||highlight!==lastNumberHighlight||Date.now()-lastNumberWrite>900){await numberRequest(true,highlight);lastNumberHighlight=highlight;lastNumberWrite=Date.now();}
      if(!numberProcess){
        const child=spawn(runtime.python,[fileURLToPath(new URL('number_keys.py',ROOT)),'--parent',String(process.pid)],{windowsHide:true,stdio:'ignore'});
        numberProcess=child;
        const finishWorker=details=>{
          if(numberProcess!==child)return;
          numberProcess=null;
          if(game.active&&!child.stopRequested){game.cancel('key-light-error');log('number-key-error',details);}
        };
        child.once('error',error=>finishWorker({reason:error.message}));
        child.once('exit',code=>finishWorker({code}));
      }
    }
    for(const touch of touches)log('pet-touch',{count:touch.count,stage:touch.stage});
    if(speech&&!manual){playPet(speech.voice);remember({interaction:'pet',visual:state,count:speech.count,stage:speech.stage,at:new Date().toISOString()});log('pet-response',{state,...speech});await save({phase:'running'});}
    for(const voice of game.drainVoices())playPet(voice);
    if(Date.now()-lastControlStatus>350){
      const controlStatus={deviceAnimation:assetPlayback.snapshot(),pid:process.pid,at:Date.now(),rawState:model.visual(false),harnessTaskState,communityTask:communityTask?{...communityTask,keyboardReleased:communityKeyboardReleased}:null,displayState:state,screenFeedback:lastScreenFeedback,affinity:affinity.value,weather:weather.status(),resident:residentRotation.current?.id,nativeLighting:nativeLights.status,keyboardOutput:keyboardBridge.status,taskLighting:{active:lightSession.active,lastRestoredAt:lightSession.lastResult?.at??null},syncDevicesVersion:syncDevices.version,captionVersion:subtitles.version,subtitle:lastSubtitle?{active:!!previousVoiceScreen,scrolling:lastSubtitle.type===1,fontSize:lastSubtitle.fontSize,nativeUnsupported:lastSubtitle.nativeUnsupported,at:lastSubtitle.at}:null,taskDiagnostics:{retriedTools:model.retriedTools,lastRetryAt:model.lastRetryAt},displayError:displayRecovery.error,connection:connectionRecovery.snapshot(),taskLightsVersion:controls.version,screenCycleVersion:hardwareScreen.version,screenPagesVersion:hardwareScreen.pagesVersion,shortcutPage:mode==='pages'?hardwareScreen.page:null,shortcutButtonCount:hardwareScreen.buttonCount,lastShortcutButtonAt:hardwareScreen.lastButtonAt,shortcutApplyMs:hardwareScreen.lastFastApplyMs,screenCycleError:hardwareScreen.error,screenMode:mode,heldScreen:hardwareScreen.held?{theme:hardwareScreen.held.theme,index:hardwareScreen.held.index,enabled:hardwareScreen.held.enabled}:null,settingsError:controls.error,preview:lightPreview?{id:lightPreview.id,state:lightPreview.state,until:lightPreview.until}:null,lastCommand:lastControlCommand,manual};
      const temp=new URL('control-status.tmp',ROOT);await fs.writeFile(temp,JSON.stringify(controlStatus));
      for(let attempt=0;attempt<8;attempt++){try{await fs.rename(temp,new URL('control-status.json',ROOT));break;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await sleep(25);}}
      lastControlStatus=Date.now();
    }
    const status=JSON.stringify({controller:{pid:process.pid,manualPaused:manual,hotkeysReady:host.ready===true},pet:pet.describe(),game:game.describe(),attention:{enabled:attentionEnabled,nextAt:attention.nextAt,until:attention.until},context,visual:manual?'MANUAL':state,uploads});
    if(status!==playStatus){
      const temp=new URL('playtime-state.tmp',ROOT);await fs.writeFile(temp,status);let written=false;
      for(let attempt=0;attempt<8;attempt++){
        try{await fs.rename(temp,new URL('playtime-state.json',ROOT));written=true;break;}
        catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await sleep(25);}
      }
      if(written)playStatus=status;
      else{await fs.rm(temp,{force:true});log('playtime-status-retry');}
    }
    lastProgressAt=Date.now();
    if(!displayRecovery.error&&connectionRecovery.success())log('connection-restored');
    }catch(error){
      await failLightPreview(error);
      const delay=await connectionRecovery.fail(error);log('connection-retry',{delay,failures:connectionRecovery.failures,reason:error.message});
      game.cancel('connection-lost');voiceProcess?.kill();panelProcess?.kill();await stopNumbers().catch(()=>{});
    }
    await heartbeat();await sleep(150);
  }
}catch(error){
  log('controller-error',{reason:error.message,code:error.code,stack:error.stack});throw error;
}finally{
  stopping=true;abort.abort();await eventTask?.catch(()=>{});
  const releaseIssues=[];
  const reportReleaseError=(event,error)=>{releaseIssues.push(error.message);log(event,{reason:error.message});};
  await mouseBindingRecovery.close();
  hotkeyProcess?.kill();voiceProcess?.kill();panelProcess?.kill();
  await hardwareScreen.pageButtons(false).catch(()=>{});
  await restoreCaption().catch(error=>reportReleaseError('caption-restore-error',error));
  await nativeLights.close().catch(error=>reportReleaseError('native-light-cleanup-error',error));
  if(phoneVisual.id||phoneVisual.screen)await phoneVisual.end().catch(error=>reportReleaseError('phone-restore-error',error));
  if(assetPlayback.active)await stopAssetPlayback().catch(error=>reportReleaseError('asset-restore-error',error));
  await keyboardBridge.close().catch(error=>reportReleaseError('keyboard-cleanup-error',error));
  if(fireworks.active){try{const reward=await fireworks.stop(expected);expected=reward.signature;log('fireworks-cleanup',reward);}catch(error){reportReleaseError('fireworks-cleanup-error',error);}}
  if(lightSession.active){try{const result=await lightSession.end();expected=result.signature;log('task-native-lights-restored',{at:result.at,cleanup:true});}catch(error){reportReleaseError('restore-error',error);}}
  if(!handoff)await balanceBar.ambient.close().then(result=>{if(result?.pendingRestore)reportReleaseError('balance-native-restore-error',Error('键盘氛围灯暂未确认恢复'));}).catch(error=>reportReleaseError('balance-native-restore-error',error));
  try{const host=JSON.parse(await fs.readFile(new URL('pet-hotkey-status.json',ROOT),'utf8'));if(host.parent===process.pid)await fs.writeFile(new URL('pet-hotkey-status.json',ROOT),JSON.stringify({...host,ready:false,stopped:true,observedAt:Date.now()}));}catch{}
  await stopNumbers();
  if(owned&&!manual&&!handoff){try{const strip=await balanceBar.close(expected);if(strip.changed)expected=strip.signature;}catch(error){reportReleaseError('balance-strip-cleanup-error',error);}}
  await fs.rm(gameFlag,{force:true});
  if(!handoff){
  if(!manual&&screenBackup&&changedImage){
    let textError;
    if(screenBackup.text){
      try{await restoreText(screenBackup.text);}catch(error){textError=error.message;log('original-screen-text-restore-error',{reason:textError});}
    }
    try{
      log('restoring-original-screen');log('original-screen-restored',await restoreScreen({...screenBackup,text:null}));changedImage=false;
      if(textError&&screenBackup.screen?.mode===1){await restoreText(screenBackup.text);log('original-screen-text-restored');}
    }catch(error){reportReleaseError('restore-error',error);}
  }
  if(snapshot&&screenBackup)await save({phase:'stopped',finishedAt:new Date().toISOString(),manual});
  await writeJson(new URL('device-link-release.json',ROOT),{pid:process.pid,at:Date.now(),issues:releaseIssues.map(message=>message.split(/\r?\n/,1)[0].slice(0,220))})
    .catch(error=>log('device-release-receipt-error',{reason:error.message}));
  await fs.rm(pidFile,{force:true});
  // The standalone service owns QQ and device requests. Do not resurrect the
  // obsolete NAS writer after this controller has released its hardware.
  }else{
    await save({phase:'handoff'});await fs.rm(pidFile,{force:true});await fs.rm(handoffFile,{force:true});log('handoff-ready');
  }
  controllerLock.release();
}
