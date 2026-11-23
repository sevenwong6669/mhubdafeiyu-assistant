import {runtime} from '../runtime-paths.mjs';
import {invalidateIntent} from './device-intent.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DEFAULT_BINDINGS,DEFAULT_LIGHTS,TASK_STATES,validateBindings,validateLights,validateStyle,shortcut} from '../harness-mhub-sync/control-settings.mjs';
import {DEFAULT_SCREEN_CYCLE,validateScreenCycle,DEFAULT_SCREEN_PAGES,validateScreenPages,systemClock} from '../harness-mhub-sync/hardware-screen.mjs';
import {accountBalance} from '../harness-mhub-sync/balance-bar.mjs';
import {BALANCE_KEYBOARDS,balanceKeyboardInventory} from '../harness-mhub-sync/balance-keyboards.mjs';
import {voiceInfo} from './voice-info.mjs';
import {DEFAULT_SYNC_DEVICES,validateSyncDevices,connectedSelection} from '../harness-mhub-sync/sync-devices.mjs';
import {DEFAULT_SUBTITLES} from '../harness-mhub-sync/subtitles.mjs';
import {evaluateInMhub} from '../mhub_runtime_access.mjs';
import {DEFAULT_PHONE,validatePhone} from '../harness-mhub-sync/phone/settings.mjs';
import {TtsServiceStore} from './tts-service.mjs';
import {writeModeOverride,readModeOverride} from '../harness-mhub-sync/mode-override.mjs';
import {SyncStartup} from '../harness-mhub-sync/startup.mjs';
import {PluginRecovery} from './recovery.mjs';
import {live2dChannel} from '../harness-mhub-sync/live2d-channel.mjs';
import {readDeviceLink,requireDeviceLink,setDeviceLink,deviceWritePending} from '../harness-mhub-sync/device-link-mode.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function optional(file){try{return read(file);}catch(e){if(e.code==='ENOENT')return null;throw Error('配置文件无法读取，原文件已保留。');}}
function runtimeStatus(file){try{return optional(file);}catch{return null;}}
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value??{},k)).map(k=>[k,value[k]]));
const integer=(a,b)=>({type:'number',min:a,max:b,integer:true});
export const CONTROL_FIELDS={
  voice:{voiceHotkey:{type:'string',min:3,max:100},inputName:{type:'string',min:1,max:100},holdMilliseconds:integer(150,1500),maxReplyCharacters:integer(30,1000),maxQueuedSentences:integer(1,16),asrThreads:integer(1,8),asrProvider:{enum:['fish-buddy','qwen3-asr','doubao-ime']},asrContext:{type:'string',min:0,max:500},fishBuddyModel:{enum:['int8','fp32','paraformer']},fishBuddyFollowSelection:{type:'boolean'},ttsProvider:{enum:['indextts2','breezeblue']}},
  balance:{enabled:{type:'boolean'},fullAmount:{type:'number',min:1,max:10000},brightness:integer(1,100),gt75Layout:{enum:['continuous','mirrored']}},
  notifications:{soundEnabled:{type:'boolean'},successSound:{type:'boolean'},errorSound:{type:'boolean'},approvalSound:{type:'boolean'}},
  audio:{inputName:{type:'string',min:1,max:160},inputApi:{type:'string',min:1,max:80},outputName:{type:'string',min:1,max:160},outputApi:{type:'string',min:1,max:80}},
  subtitles:{captionMode:{enum:['auto','scroll','pages']},captionFontSize:{enum:[0,1]}},
};
function validate(group,values){
  if(group==='phone')return validatePhone(values);
  if(group==='bindings')return validateBindings(values);
  if(group==='taskLights')return validateLights(values);
  if(group==='screenCycle')return validateScreenCycle(values);
  if(group==='screenPages')return validateScreenPages(values);
  if(group==='syncDevices')return validateSyncDevices(values);
  const fields=CONTROL_FIELDS[group];
  if(!fields||!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length)throw Error('请选择要保存的参数。');
  for(const [key,value] of Object.entries(values)){
    const rule=fields[key];if(!rule)throw Error('包含不可修改的参数。');
    if(rule.enum?!rule.enum.includes(value):typeof value!==rule.type)throw Error('参数类型或选项不正确：'+key);
    if(rule.type==='number'&&(!Number.isFinite(value)||value<rule.min||value>rule.max||rule.integer&&!Number.isInteger(value)))throw Error('参数超出允许范围：'+key);
    if(rule.type==='string'&&(value.trim().length<rule.min||value.length>rule.max||/[\x00-\x1f]/.test(value)))throw Error('请输入有效的设备名称。');
  }
  return group==='voice'&&Object.hasOwn(values,'voiceHotkey')?{...values,voiceHotkey:shortcut(values.voiceHotkey)}:values;
}
export class ControlService{
  constructor({workspaceRoot=workspace,fetchImpl=fetch,launchImpl,aliveImpl,audioImpl,syncInventoryImpl,balanceKeyboardImpl,waitImpl}={}){
    this.root=workspaceRoot;this.sync=path.join(this.root,'harness-mhub-sync');this.voice=path.join(this.sync,'voice-chat');this.fetch=fetchImpl;
    this.tts=new TtsServiceStore({root:this.voice,fetchImpl});
    this.live2d=live2dChannel({fetchImpl});
    this.syncStartup=new SyncStartup({root:this.sync});
    this.recovery=new PluginRecovery({root:path.join(this.root,'mhub-community-assistant')});
    this.launch=launchImpl??(script=>new Promise((resolve,reject)=>{
      if(script===path.join(this.sync,'Start-Harness.ps1')){this.syncStartup.request().then(resolve,reject);return;}
      const out=fs.openSync(path.join(this.root,'mhub-community-assistant/state/control-start.log'),'a'),err=fs.openSync(path.join(this.root,'mhub-community-assistant/state/control-start-error.log'),'a');
      try{
        // Windows PowerShell can silently exit before executing -File when
        // DETACHED_PROCESS is combined with redirected file handles.
        const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{cwd:path.dirname(script),windowsHide:true,stdio:['ignore',out,err]});
        const timer=setTimeout(()=>resolve({pending:true}),35000);
        child.once('error',()=>{clearTimeout(timer);reject(Error('启动程序未能运行，请检查本机启动日志。'));});
        child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve({pending:false});else reject(Error('启动失败，请查看本机启动日志。'));});child.unref();
      }finally{fs.closeSync(out);fs.closeSync(err);}
    }));
    this.alive=aliveImpl??(pid=>{try{if(!Number.isSafeInteger(pid)||pid<=0)return false;process.kill(pid,0);return true;}catch{return false;}});
    this.lastAction=0;
    this.wait=waitImpl??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.balanceKeyboardImpl=balanceKeyboardImpl??(()=>evaluateInMhub(balanceKeyboardInventory,{models:BALANCE_KEYBOARDS},2500));
    this.syncInventoryImpl=syncInventoryImpl??(()=>evaluateInMhub(async()=>{
      const m=await loadMhubModule(),store=m.c3(),connected=new Set(store.connectedDeviceIds??[]),devices=new Map();
      for(const scene of store.scenes)for(const d of scene.devices??[])if(!devices.has(d.id)||scene.desktopCompanionVersion===1)devices.set(d.id,{id:d.id,name:d.name||d.deviceName||d.productName||d.id,type:d.type,connected:connected.has(d.id),selected:!!d.selected});
      return {available:true,checkedAt:Date.now(),devices:[...devices.values()]};
    },{},3500));
    this.audioImpl=audioImpl??((operation,values)=>new Promise((resolve,reject)=>{
      const child=spawn(runtime.python,['-X','utf8',path.join(this.voice,'audio_devices.py'),...(operation==='test'?['test']:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let out='',error='';const timer=setTimeout(()=>{child.kill();reject(Error('音频设备检测超时，请重新检测。'));},15000);
      child.stdout.on('data',chunk=>{out+=chunk;if(out.length>65536){child.kill();reject(Error('设备列表过长。'));}});child.stderr.on('data',chunk=>{error+=chunk;});
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('音频设备暂不可用：'+error.trim().slice(-300)));try{resolve(JSON.parse(out.trim()));}catch{reject(Error('音频设备未返回有效结果。'));}});
      child.stdin.end(operation==='test'?JSON.stringify(values):'');
    }));
  }
  async syncInventory(force=false){
    const file=path.join(this.root,'mhub-community-assistant/state/sync-devices-snapshot.json'),cached=runtimeStatus(file);
    if(!readDeviceLink(this.sync).enabled)return {...cached,available:false,stale:!!cached,devices:cached?.devices??[]};
    const project=value=>{
      const group=this.fileGroup('syncDevices'),devices=value.devices??[];
      const ids=group.values?.deviceIds??connectedSelection({connectedDeviceIds:devices.filter(d=>d.connected).map(d=>d.id)},null);
      return {...value,devices:devices.map(d=>({...d,selected:ids.includes(d.id)}))};
    };
    if(!force&&cached&&Date.now()-cached.checkedAt>=0&&Date.now()-cached.checkedAt<10000)return project(cached);
    if(!force&&!fs.existsSync(path.join(this.sync,'sync-devices.json')))return {available:false,devices:[]};
    // Multiple open panels share the same read; they must not pile up SDK queries.
    if(!this.inventoryPending){
      const task=(async()=>{const value=await this.syncInventoryImpl();atomicText(file,JSON.stringify(value));return value;})();
      this.inventoryPending=task;
      void task.finally(()=>{if(this.inventoryPending===task)this.inventoryPending=null;}).catch(()=>{});
    }
    try{return project(await this.inventoryPending);}
    catch{return project({...cached,available:false,stale:!!cached,devices:cached?.devices??[],error:'暂时无法检测 M HUB，同步设备设置已保留。'});}
  }
  async http(url,method='GET',body){
    const response=await this.fetch(url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(body&&url.startsWith('http://127.0.0.1:18782/api/mhub-community/companion/')?{'x-mhub-panel-token':optional(path.join(this.root,'mhub-community-assistant/state/companion/host.json'))?.token??''}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(url.endsWith('/audio/reload')?30000:2500),redirect:'error'});
    const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error.slice(0,300):'服务暂不可用，请查看运行状态。');
    return data;
  }
  petOrigin(){const value='http://127.0.0.1:18782';const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('Harness 本机地址不可用。');return u.origin;}
  file(group){if(group==='phone')return path.join(this.sync,'phone/settings.json');if(['voice','audio','subtitles'].includes(group))return path.join(this.voice,'config.json');if(group==='balance')return path.join(this.sync,'balance-bar/settings.json');if(group==='syncDevices')return path.join(this.sync,'sync-devices.json');if(group==='bindings')return path.join(this.sync,'hotkeys.settings.json');if(group==='taskLights')return path.join(this.sync,'task-lights.json');if(group==='screenCycle')return path.join(this.sync,'screen-cycle.json');if(group==='screenPages')return path.join(this.sync,'screen-pages.json');throw Error('不可修改这个配置。');}
  defaultGroup(group){return group==='phone'?{...DEFAULT_PHONE}:group==='syncDevices'?structuredClone(DEFAULT_SYNC_DEVICES):group==='subtitles'?{...DEFAULT_SUBTITLES}:group==='bindings'?structuredClone(DEFAULT_BINDINGS):group==='taskLights'?structuredClone(DEFAULT_LIGHTS):group==='screenCycle'?{...DEFAULT_SCREEN_CYCLE}:group==='screenPages'?{...DEFAULT_SCREEN_PAGES}:null;}
  fileValue(group){try{return read(this.file(group));}catch(e){if(e.code==='ENOENT'&&this.defaultGroup(group))return this.defaultGroup(group);throw e;}}
  fileGroup(group){try{const value=this.fileValue(group);const keys=Object.keys(this.defaultGroup(group)??CONTROL_FIELDS[group]);
    const defaults=group==='audio'?{inputName:'MCHOSE V9 Turbo+',inputApi:'MME',outputName:'MCHOSE K20 GT',outputApi:'MME'}:group==='voice'?{asrProvider:'fish-buddy',asrContext:''}:group==='balance'?{gt75Layout:'continuous'}:this.defaultGroup(group);
    return {available:true,values:pick({...defaults,...value},keys),revision:digest(value),controlVersion:value.controlVersion??null,apply:group==='voice'?'restart-voice':group==='audio'?'apply-audio':'immediate'};
  }catch(e){return {available:false,error:e.code==='ENOENT'?'尚未安装此功能':e.message};}}
  async audioDevices(operation='refresh',values){
    if(!['refresh','test'].includes(operation))throw Error('没有这个音频操作。');
    if(operation==='test'){
      validate('audio',values);if(Object.keys(values).some(x=>!['outputName','outputApi'].includes(x)))throw Error('试听仅接受播放设备。');
      const list=await this.audioImpl('refresh');this.verifyAudio(values,list);const result=await this.audioImpl('test',values);return {message:'试听已播放：'+result.device};
    }
    const result=await this.audioImpl('refresh');const safe={available:true,checkedAt:Date.now(),devices:result.devices.map(d=>pick(d,['index','name','api','input','output','sampleRate']))};
    fs.writeFileSync(path.join(this.root,'mhub-community-assistant/state/audio-devices.json'),JSON.stringify(safe));return safe;
  }
  verifyAudio(values,list){for(const direction of ['input','output'])if(values[direction+'Name']&&values[direction+'Name']!=='__default__'&&!list.devices.some(d=>d[direction]&&d.api===values[direction+'Api']&&d.name.includes(values[direction+'Name'])))throw Error('找不到所选'+(direction==='input'?'麦克风':'播放设备')+'，请重新检测。');}
  queue(kind,extra={}){requireDeviceLink(this.sync);if(['device-default-theme','rgb-device-asset-stop'].includes(kind))invalidateIntent(this.sync);const at=Date.now(),id=randomUUID(),folder=path.join(this.sync,'interaction-inbox');fs.mkdirSync(folder,{recursive:true});atomicText(path.join(folder,`${at}-000000-${id}.json`),JSON.stringify({id,at,kind,value:0,...extra}));return id;}
  async waitStatus(file,test,ms=4500){const until=Date.now()+ms;while(Date.now()<until){const value=optional(file);if(value&&test(value))return value;await new Promise(r=>setTimeout(r,100));}return null;}
  async preview({state,style}){
    requireDeviceLink(this.sync);
    if(!TASK_STATES.includes(state))throw Error('未知的任务状态。');validateStyle(style);const sync=this.syncStatus();if(!sync.running)throw Error('设备联动已停止，请点击“恢复联动”。');if(!sync.ready)throw Error('设备正在初始化，完成后可试用灯光。');
    const id=this.queue('task-light-preview',{state,style});const status=await this.waitStatus(path.join(this.sync,'control-status.json'),s=>s.lastCommand?.id===id&&typeof s.lastCommand.ok==='boolean',35000);
    if(!status)throw Error('联动程序尚未确认试用，请查看运行状态，勿重复点击。');if(!status.lastCommand.ok)throw Error(status.lastCommand.error);return {message:'已开始 8 秒灯光试用，随后自动恢复真实状态。'+(status.lastCommand.warning?' '+status.lastCommand.warning:''),...(status.lastCommand.confirmation?{confirmation:status.lastCommand.confirmation,confirmedAt:status.lastCommand.confirmedAt,until:status.lastCommand.until,physicalConfirmed:status.lastCommand.physicalConfirmed===true}:{}),...(status.lastCommand.skipped?{skipped:status.lastCommand.skipped}:{})};
  }
  async notices(){try{const value=await this.http(this.petOrigin()+'/api/mhub-community/companion/config');return {available:true,values:{soundEnabled:value.soundEnabled!==false,successSound:(value.soundStates??[]).includes('SUCCESS'),errorSound:(value.soundStates??[]).includes('ERROR'),approvalSound:(value.soundStates??[]).includes('APPROVAL')},revision:digest(pick(value,['soundEnabled','soundStates'])),apply:'immediate'};}catch{return {available:false,error:'内部伙伴后台未连接'};}}
  syncStatus(){
    let pid;try{pid=Number(fs.readFileSync(path.join(this.sync,'run.pid'),'utf8'));}catch{}
    const processExists=this.alive(pid);let record;try{record=optional(path.join(this.sync,'session.json'));}catch{record=null;}
    const readStatus=name=>{try{return optional(path.join(this.sync,name));}catch{return null;}};
    const health=readStatus('controller-health.json'),supervisor=readStatus('supervisor-status.json');
    let startup=null;try{startup=optional(path.join(this.sync,'startup-status.json'));}catch{}
    const age=Date.now()-health?.at;
    const currentHeartbeat=processExists&&health?.pid===pid&&age>=0&&age<5000;
    const running=!!currentHeartbeat&&readDeviceLink(this.sync).enabled;
    const healthy=currentHeartbeat&&health.phase==='running'&&health.connection?.state==='ready';
    const startupAge=Date.now()-startup?.at;
    if(!(startupAge>=0&&startupAge<120000)||startup?.phase==='started'&&!healthy)startup=null;
    const supervisorAge=Date.now()-supervisor?.at;
    const supervised=!!(supervisor&&supervisorAge>=0&&supervisorAge<15000&&this.alive(supervisor.pid));
    const recovering=!healthy&&(running||supervised&&supervisor.state!=='stopped');
    return {running,ready:running&&!recovering&&record?.pid===pid&&['running','manual-paused'].includes(record?.phase),reconnecting:!!recovering,supervised,supervisor:supervised?pick(supervisor,['state','restarts','nextRetryAt','connectionRepair']):null,startup,connection:currentHeartbeat?health.connection:null,screen:currentHeartbeat?{...health.screen,ready:healthy&&health.screen?.ready===true,captionsReady:healthy&&health.screen?.captionsReady===true}:null,reason:processExists&&!currentHeartbeat&&!supervised?'stale-process':null,phase:recovering?'正在自动重连':running?(record?.manual?'手动控制，联动已让位':record?.phase??'运行中'):'未运行',mode:readModeOverride(this.sync),attentionEnabled:runtimeStatus(path.join(this.sync,'playtime-settings.json'))?.attentionEnabled!==false,settingsError:(()=>{try{optional(path.join(this.sync,'playtime-settings.json'));return null;}catch(error){return 'playtime-settings.json：'+error.message;}})()};
  }
  deviceLinkStatus(){
    const mode=readDeviceLink(this.sync);
    if(mode.enabled)return {enabled:true,releasing:false};
    const files=[path.join(this.sync,'run.pid'),path.join(this.sync,'supervisor.pid'),path.join(this.voice,'server.pid'),path.join(this.root,'dafeiyu-mhub-bridge/bridge.pid')];
    const release=runtimeStatus(path.join(this.sync,'device-link-release.json'));
    return {enabled:false,releasing:!!(this.syncStartup.pending||this.syncStartup.reserving||files.some(file=>this.alive(Number(optionalText(file))))||deviceWritePending(this.sync)),...(release?.at>=mode.at&&release.issues?.length?{issues:release.issues}:{})};
  }
  async setDeviceLinkEnabled(enabled){
    const current=readDeviceLink(this.sync);
    if(!enabled){
      if(!current.enabled&&!current.invalid)return {message:'已关闭总开关，正在释放设备控制。'};
      const intent=runtimeStatus(path.join(this.root,'mhub-community-assistant/state/runtime-intent.json'));
      setDeviceLink(this.sync,{enabled:false,resumeVoice:current.enabled?(intent?.voice===true||this.alive(Number(optionalText(path.join(this.voice,'server.pid'))))):current.resumeVoice===true});
      this.syncStartup.cancel();
      atomicText(path.join(this.sync,'stop.request'),'device-link-off');
      invalidateIntent(this.sync);
      const voicePid=Number(optionalText(path.join(this.voice,'server.pid')));
      if(this.alive(voicePid))void this.http('http://127.0.0.1:18780/shutdown','POST',{expectedPid:voicePid}).catch(()=>{});
      return {message:'已关闭总开关，正在释放设备控制。'};
    }
    if(current.enabled)return {message:'设备联动总开关已开启。'};
    if(this.deviceLinkStatus().releasing)throw Error('设备仍在释放，请稍后再开启。');
    const file=path.join(this.root,'mhub-community-assistant/state/runtime-intent.json');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    atomicText(file,JSON.stringify({...runtimeStatus(file),sync:true,at:Date.now()}));
    setDeviceLink(this.sync,{enabled:true});
    // The old master-off marker must not survive an explicit enable when a
    // dependency is temporarily down, or the login resume loop will stay off.
    const stopFile=path.join(this.sync,'stop.request');
    if(optionalText(stopFile)==='device-link-off')fs.unlinkSync(stopFile);
    await this.syncStartup.request();
    if(current.resumeVoice)void this.launch(path.join(this.voice,'Start.ps1')).catch(()=>{});
    return {message:'已开启总开关，正在连接设备。'};
  }
  balanceStatus(sync=this.syncStatus(),now=Date.now()){
    const value=runtimeStatus(path.join(this.sync,'balance-bar/status.json'));if(!value)return null;
    const fresh=Number.isFinite(value.updatedAt)&&now-value.updatedAt>=0&&now-value.updatedAt<5000;
    if(!sync.ready)return {...value,live:false,visible:false,reason:'connection-unavailable'};
    if(!fresh)return {...value,live:false,visible:false,reason:'stale-status'};
    return {...value,live:true};
  }
  phoneInputStatus(voice,now=Date.now()){
    const value=runtimeStatus(path.join(this.sync,'phone/input-status.json'));if(!value)return null;
    const live=voice.reachable===true&&voice.pid===value.parent&&Number.isFinite(value.at)&&now-value.at>=0&&now-value.at<5000&&this.alive(value.pid)&&this.alive(value.parent);
    return {...value,live,ready:live&&value.ready===true,...(!live?{hotkey:null,error:null,reason:'listener-unavailable'}:{})};
  }
  audioDeviceStatus(now=Date.now()){
    const value=runtimeStatus(path.join(this.root,'mhub-community-assistant/state/audio-devices.json'));if(!value)return null;
    return {...value,stale:!Number.isFinite(value.checkedAt)||now-value.checkedAt<0||now-value.checkedAt>=60000};
  }
  async snapshot(){
    const deviceLink=this.deviceLinkStatus();
    const [notifications,voice,syncInventory,balanceKeyboard,live2d]=await Promise.all([this.notices(),this.http('http://127.0.0.1:18780/status').then(v=>({reachable:true,...pick(v,['pid','ready','streamReady','nativeReady','nativeKeyboardReady','voiceHotkey','mouseBindingReady','mouseBindingError','phase','error','nativeError','captionError','ttsProvider','ttsVoice','tts','ttsOperation','asrProvider','asrDevice','asrModelTier','phone','phoneVoiceError','playback','playbackError','playbackRecovery','deviceCommand','channel','channelError','lastReplyWithImage'])})).catch(()=>({reachable:false,phase:'未运行'})),this.syncInventory(),deviceLink.enabled?this.balanceKeyboardImpl().catch(()=>({available:false,reason:'connection-unavailable'})):{available:false,reason:'link-off'},this.live2d.status().catch(()=>null)]);
    const sync=this.syncStatus();
    let tts;try{tts=this.tts.snapshot();}catch(error){tts={error:error.message};}
    const runtime=runtimeStatus(path.join(this.sync,'control-status.json'));
    const playtime=runtimeStatus(path.join(this.sync,'playtime-state.json'));
    const game=sync.ready&&runtime?.pid===playtime?.controller?.pid&&playtime?.game?
      pick(playtime.game,['active','phase','celebrating','lastResult']):null;
    const voiceDesired=runtimeStatus(path.join(this.root,'mhub-community-assistant/state/runtime-intent.json'))?.voice;
    const voiceConfig=runtimeStatus(path.join(this.voice,'config.json'))??{};
    return {deviceLink,tts,game,voiceDesired,groups:{phone:this.fileGroup('phone'),syncDevices:this.fileGroup('syncDevices'),subtitles:this.fileGroup('subtitles'),voice:this.fileGroup('voice'),audio:this.fileGroup('audio'),bindings:this.fileGroup('bindings'),taskLights:this.fileGroup('taskLights'),screenCycle:this.fileGroup('screenCycle'),screenPages:this.fileGroup('screenPages'),balance:this.fileGroup('balance'),notifications},voice,live2d,voiceChannel:voiceConfig.voiceChannel??'legacy',voiceInfo:voiceInfo({voiceRoot:this.voice,config:voiceConfig}),systemTime:systemClock(),weather:runtimeStatus(path.join(this.sync,"weather-settings.json")),syncInventory,sync,phoneInput:this.phoneInputStatus(voice),runtime,hotkeys:runtimeStatus(path.join(this.sync,'pet-hotkey-status.json')),mouseBindings:runtimeStatus(path.join(this.voice,'mouse-binding-status.json')),balanceKeyboard,balance:this.balanceStatus(sync),audioDevices:this.audioDeviceStatus(),cloudKeySaved:fs.existsSync(path.join(this.voice,'secrets/breeze-key.dpapi')),savedAt:runtimeStatus(path.join(this.root,'mhub-community-assistant/state/control-last-change.json'))};
  }
  async shortcutCapture({operation,id}){
    if(!['begin','renew','end'].includes(operation)||typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('快捷键录入请求无效。');
    const file=path.join(this.sync,'shortcut-capture.json'),now=Date.now(),old=runtimeStatus(file);
    const active=old&&old.expiresAt>now&&old.expiresAt<=now+6500&&this.alive(old.owner);
    if(operation==='end'){
      if(old?.id===id)atomicText(file,JSON.stringify({...old,expiresAt:0}));
      return {ok:true};
    }
    if(operation==='renew'&&(!active||old.id!==id))throw Error('快捷键录入已结束，请重新点击。');
    if(operation==='begin'&&active&&old.id!==id)throw Error('另一个页面正在录入快捷键，请稍后重试。');
    if(operation==='begin'){
      const phone=runtimeStatus(path.join(this.sync,'phone/state.json')),native=runtimeStatus(path.join(this.voice,'native-status.json'));
      if(['dialing','incoming','connecting','connected'].includes(phone?.phase)&&now-Number(phone.at)<15000)throw Error('请先结束通话，再设置快捷键。');
      if(native?.captureActive&&this.alive(native.pid))throw Error('请先结束录音，再设置快捷键。');
    }
    const lease={id,owner:process.pid,at:now,expiresAt:now+6000};
    atomicText(file,JSON.stringify(lease));
    if(operation==='renew')return {ok:true,id,expiresAt:lease.expiresAt};
    // Do not invite a key press until every live listener has actually let go.
    const candidates=[['pet-hotkey-status.json','observedAt'],['phone/input-status.json','at'],['voice-chat/native-status.json','at']];
    const targets=candidates.map(([name,stamp])=>({file:path.join(this.sync,name),stamp})).map(target=>({...target,status:runtimeStatus(target.file)})).filter(({status,stamp,file})=>status?.ready&&this.alive(status.pid)&&(file.endsWith('native-status.json')||now-Number(status[stamp])<3000));
    try{
      for(let attempt=0;attempt<30;attempt++){
        if(runtimeStatus(file)?.id!==id||runtimeStatus(file)?.expiresAt<=Date.now())throw Error('快捷键录入已结束，请重新点击。');
        if(targets.every(({file,status})=>{const live=runtimeStatus(file);return live?.pid===status.pid&&live.shortcutCaptureId===id;}))return {ok:true,id,expiresAt:lease.expiresAt};
        await this.wait(80);
      }
      throw Error('快捷键监听尚未让出按键，请重启插件后重试。');
    }catch(error){if(runtimeStatus(file)?.id===id)atomicText(file,JSON.stringify({...lease,expiresAt:0}));throw error;}
  }
  async save(input){if(input.group!=='notifications')return this.saveUnlocked(input);const previous=this.noticeTail??Promise.resolve();let release;this.noticeTail=new Promise(r=>release=r);await previous;try{return await this.saveUnlocked(input);}finally{release();}}
  async saveUnlocked({group,revision,values}){
    let applied=false,balanceReceipt=null;
    const inputValues=values;
    if(['phone','bindings','taskLights','screenCycle','screenPages','syncDevices'].includes(group)){if(!values||typeof values!=='object'||Array.isArray(values))throw Error('参数格式不正确。');}
    else values=validate(group,values);
    if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw Error('请刷新参数后再保存。');
    const folder=path.join(this.root,'mhub-community-assistant/state/control-backups');fs.mkdirSync(folder,{recursive:true});
    if(group==='notifications'){
      const current=await this.notices();if(!current.available)throw Error(current.error);if(current.revision!==revision)throw Error('参数已在别处更新，请重新读取后再修改。');
      const next={...current.values,...values};
      fs.writeFileSync(path.join(folder,Date.now()+'-'+randomUUID()+'-notifications.json'),JSON.stringify(current.values,null,2),{flag:'wx'});
      await this.http(this.petOrigin()+'/api/mhub-community/companion/config','PATCH',{soundEnabled:next.soundEnabled,soundStates:[...(next.successSound?['SUCCESS']:[]),...(next.errorSound?['ERROR']:[]),...(next.approvalSound?['APPROVAL']:[])]});
      const checked=await this.notices();if(!checked.available||JSON.stringify(checked.values)!==JSON.stringify(next))throw Error('挂件未确认新设置，请刷新核对。');
    }else{
      const file=this.file(group),lock=file+'.panel.lock';fs.mkdirSync(path.dirname(file),{recursive:true});let fd;
      try{
        try{fd=fs.openSync(lock,'wx');}
        catch(error){
          if(error.code!=='EEXIST')throw error;
          const owner=runtimeStatus(lock),metadata=fs.statSync(lock);
          if(Date.now()-metadata.mtimeMs<60000||this.alive(owner?.pid))throw Error('参数正在保存，请稍后重试。');
          fs.unlinkSync(lock);
          fd=fs.openSync(lock,'wx');
        }
        fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));
        const current=this.fileValue(group);if(digest(current)!==revision)throw Error('参数已在别处更新，请重新读取后再修改。');
        if(['phone','bindings','taskLights','screenCycle','screenPages','syncDevices'].includes(group)){
          const existing=pick(current,Object.keys(this.defaultGroup(group))),merged={...existing,...inputValues};
          if(group==='taskLights')for(const key of TASK_STATES)if(Object.hasOwn(inputValues,key))merged[key]={...existing[key],...inputValues[key]};
          values=validate(group,merged);
        }
        if(group==='voice'&&values.ttsProvider==='breezeblue'&&!fs.existsSync(path.join(this.voice,'secrets/breeze-key.dpapi')))throw Error('尚未保存云端密钥，请先通过原云端音色设置入口配置。');
        if(group==='voice'&&values.asrProvider&&values.asrProvider!==current.asrProvider){const info=voiceInfo({voiceRoot:this.voice,config:{...current,...values}});if(!info.recognition.providers.find(x=>x.id===values.asrProvider)?.installed)throw Error('该识别模型尚未安装，请先安装后再选择。');}
        if(group==='voice'&&values.fishBuddyModel&&values.fishBuddyModel!==current.fishBuddyModel){const info=voiceInfo({voiceRoot:this.voice,config:{...current,...values}});if(!info.recognition.installedTiers.includes(values.fishBuddyModel))throw Error('该鱼搭子识别档位尚未安装，请先下载后再选择。');}
        const otherBalanceEdit=group==='balance'&&Object.entries(values).some(([key,value])=>key!=='fullAmount'&&value!==current[key]);
        if(group==='balance'&&Object.hasOwn(values,'fullAmount')&&(values.fullAmount!==current.fullAmount||!otherBalanceEdit)){
          let balance,snapshot;try{snapshot=await this.http(this.petOrigin()+'/api/mhub-community/companion/balance');balance=accountBalance(snapshot,current.currency??'CNY');}catch{}
          if(!balance&&snapshot?.status==='not-configured')throw Error('Harness 尚未配置 DeepSeek 余额来源，无法核对满格金额。请先配置 API Key 或登录账号；亮度和开关仍可单独保存。');
          if(!balance)throw Error('当前余额暂不可读取，无法核对满格金额，请刷新余额后再保存。');
          if(values.fullAmount<balance.amount)throw Error('满格金额不能低于当前余额 ¥'+(Math.ceil(balance.amount*100)/100).toFixed(2)+'。');
        }
        if(group==='syncDevices'){const list=await this.syncInventory(true);if(!list.available)throw Error(list.error);const before=current.deviceIds??list.devices.filter(d=>d.selected).map(d=>d.id);for(const id of values.deviceIds??[])if(!before.includes(id)&&!list.devices.some(d=>d.id===id&&d.connected))throw Error('所选设备当前未连接，请重新检测。');}
        const voiceKey=group==='voice'&&values.voiceHotkey?values.voiceHotkey:runtimeStatus(path.join(this.voice,'config.json'))?.voiceHotkey??'Ctrl+Alt+Shift+1';
        if(group==='phone'){const bindings=this.fileGroup('bindings');if(Object.values(bindings.values??{}).includes(values.hotkey)||values.hotkey===voiceKey)throw Error('电话快捷键与现有互动或语音快捷键冲突');}
        if(group==='bindings'&&(Object.values(values).includes(this.fileGroup('phone').values?.hotkey)||Object.values(values).includes(voiceKey)))throw Error('互动快捷键与电话或语音快捷键冲突');
        if(group==='voice'&&values.voiceHotkey&&(Object.values(this.fileGroup('bindings').values??{}).includes(voiceKey)||this.fileGroup('phone').values?.hotkey===voiceKey||['Ctrl+Alt+G','Ctrl+Alt+F9','Ctrl+Alt+F8'].includes(voiceKey)))throw Error('语音快捷键与现有互动或电话快捷键冲突');
        if(group==='audio')this.verifyAudio({...current,...values},await this.audioImpl('refresh'));
        fs.writeFileSync(path.join(folder,Date.now()+'-'+randomUUID()+'-'+group+'.json'),JSON.stringify(current,null,2),{flag:'wx'});
        const version=randomUUID(),next={...current,...values,...(['phone','balance','taskLights','bindings','screenCycle','screenPages','syncDevices'].includes(group)?{controlVersion:version}:{}),...(group==='subtitles'?{captionControlVersion:version}:{})};
        const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
        if(group==='bindings'&&this.syncStatus().running){
          const result=await this.waitStatus(path.join(this.sync,'pet-hotkey-status.json'),s=>s.requestedVersion===version);
          if(result?.appliedVersion!==version){atomicText(file,JSON.stringify({...current,controlVersion:randomUUID()},null,2));throw Error(result?.bindingError?'快捷键被占用，已恢复原绑定。'+result.bindingError:'按键监听未确认新设置，已恢复原绑定。');}
        }
        if(group==='voice'&&values.voiceHotkey&&values.voiceHotkey!==current.voiceHotkey){
          const listener=runtimeStatus(path.join(this.voice,'native-status.json'));
          if(listener?.ready&&this.alive(listener.pid)){
            const receipt=await this.waitStatus(path.join(this.voice,'native-status.json'),s=>s.pid===listener.pid&&s.voiceHotkey===values.voiceHotkey,2500);
            if(!receipt){atomicText(file,JSON.stringify(current,null,2)+'\n');throw Error('语音监听未确认新快捷键，已保留原设置。');}
          }
        }
        if(['balance','taskLights','screenCycle','screenPages','syncDevices','subtitles'].includes(group)&&(group==='balance'?this.syncStatus().ready:this.syncStatus().running)){
          const statusFile=path.join(this.sync,group==='balance'?'balance-bar/status.json':'control-status.json');
          const receipt=await this.waitStatus(statusFile,s=>(group==='balance'?s.controlVersion:group==='screenCycle'?s.screenCycleVersion:group==='screenPages'?s.screenPagesVersion:group==='syncDevices'?s.syncDevicesVersion:group==='subtitles'?s.captionVersion:s.taskLightsVersion)===version,4500);
          applied=!!receipt;if(group==='balance')balanceReceipt=receipt;
        }
        if(group==='subtitles')await this.http('http://127.0.0.1:18780/captions/reload','POST',{}).catch(()=>{});
      }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
    }
    const at=new Date().toISOString(),message=group==='phone'?'电话设置已保存，后台会立即应用':group==='syncDevices'?(applied?'同步设备已即时应用':'设备选择已保存，等待联动应用'):group==='subtitles'?(applied?'字幕显示已更新，下一句使用新设置':'字幕设置已保存，等待联动应用'):group==='notifications'?'提示音设置已生效':group==='voice'?'语音参数已保存，点击“应用语音设置”重启语音后生效':group==='audio'?'音频设备已保存，点击“应用音频设备”切换':group==='bindings'?'快捷键和鼠标动作已保存'+(this.syncStatus().running?'并生效':'，联动启动后生效'):group==='screenPages'?(applied?'音箱快捷页面已即时生效':'快捷页面已保存，等待联动应用'):group==='screenCycle'?(applied?'音箱实体键循环清单已写入并读回':'循环清单已保存，等待设备应用'):group==='balance'?(applied?'余额灯带已即时应用':'参数已保存，等待联动应用；请查看灯带状态'):(applied?'任务状态灯光已即时生效':'状态灯光已保存，等待联动应用');
    const actualMessage=group==='voice'&&Object.keys(inputValues).length===1&&inputValues.voiceHotkey?'语音快捷键已保存，后台会自动应用':group==='balance'&&applied?(balanceReceipt?.enabled===false?'余额灯带已关闭并恢复原氛围灯':balanceReceipt?.visible?'余额灯带已即时应用':balanceReceipt?.reason==='balance-unavailable'?'参数已保存；等待有效余额后显示灯条':'参数已保存，灯条暂由其他功能使用，结束后自动恢复'):message;
    fs.writeFileSync(path.join(this.root,'mhub-community-assistant/state/control-last-change.json'),JSON.stringify({group,at,message:actualMessage},null,2));return {ok:true,message:actualMessage,at};
  }
  async action(action){
    if(action==='device-link-off'||action==='device-link-on')return this.setDeviceLinkEnabled(action==='device-link-on');
    if(!['plugin-restart','sync-stop','voice-stop','voice-interrupt','voice-watch-stop','phone-hangup','phone-reject'].includes(action))requireDeviceLink(this.sync);
    if(action==='voice-watch-start'||action==='voice-watch-stop'||action==='voice-watch-retry'){
      const on=action!=='voice-watch-stop';
      const result=await this.live2d.watch(on);
      if(result.watch!==on)throw Error('Live2D 没有确认陪玩设置。');
      return {message:on?'已开启 Live2D 视频陪玩。':'已停止 Live2D 视频陪玩。'};
    }
    if(action==='phone-video'){
      await this.http('http://127.0.0.1:18780/phone/action','POST',{action:'video'});
      return {message:'正在拨出视频陪玩。'};
    }
    if(action==='plugin-restart'){this.syncStartup.cancel();invalidateIntent(this.sync);return this.recovery.request();}
    const recovering=await this.recovery.status();
    if(recovering?.active&&!['phone-hangup','phone-reject','voice-interrupt','sync-stop','voice-stop'].includes(action))throw Error('插件正在重启，请等待恢复结果。');
    if(action==='sync-stop'){
      this.syncStartup.cancel();
      const file=path.join(this.root,'mhub-community-assistant/state/runtime-intent.json');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      atomicText(file,JSON.stringify({...runtimeStatus(file),sync:false,at:Date.now()}));
      atomicText(path.join(this.sync,'stop.request'),'stop');
      return {message:'已请求停止联动和取消恢复'};
    }
    if(/^phone-(dial|demo|accept|reject|hangup|mute)$/.test(action)){await this.http('http://127.0.0.1:18780/phone/action','POST',{action:action.slice(6)});return {message:({'phone-dial':'正在拨给大肥鱼','phone-demo':'来电演示已开始','phone-accept':'正在接听','phone-reject':'已拒接','phone-hangup':'已挂断','phone-mute':'麦克风静音状态已切换'})[action]};}
    if(Date.now()-this.lastAction<1200)throw Error('操作正在处理，请稍等片刻。');this.lastAction=Date.now();
    const dir=this.sync;
    if(['sync-start','sync-stop','voice-start','voice-stop','voice-restart'].includes(action)){
      const file=path.join(this.root,'mhub-community-assistant/state/runtime-intent.json');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const intent=runtimeStatus(file)??{};
      const key=action.startsWith('voice-')?'voice':'sync';
      atomicText(file,JSON.stringify({...intent,[key]:!action.endsWith('-stop'),at:Date.now()}));
    }
    if(action==='voice-start'){
      let voice;try{voice=await this.http('http://127.0.0.1:18780/status');}catch{}
      if(voice&&!voice.ready&&['failed','error'].includes(voice.phase)||voice?.nativeError||voice?.error&&voice?.ready===false)action='voice-restart';
    }
    if(action==='sync-devices-refresh'){const list=await this.syncInventory(true);if(!list.available)throw Error(list.error);return {message:'已检测到 '+list.devices.filter(d=>d.connected).length+' 台支持神光同步的设备'};}
    if(action==='audio-apply'){await this.http('http://127.0.0.1:18780/audio/reload','POST',{});return {message:'麦克风和播放设备已应用，语音模型保持加载。'};}
    if(action==='voice-interrupt'){await this.http('http://127.0.0.1:18780/interrupt','POST',{});return {message:'已请求停止当前回复'};}
    if(['voice-stop','voice-restart'].includes(action)){
      let status;try{status=await this.http('http://127.0.0.1:18780/status');}catch{}
      const pidFile=path.join(this.voice,'server.pid');
      const oldPid=status?.pid||Number(optionalText(pidFile));
      if(status)await this.http('http://127.0.0.1:18780/shutdown','POST',{expectedPid:status.pid});
      if(action==='voice-stop')return {message:'已请求停止语音，正在释放麦克风和模型'};
      // CUDA workers and the mouse binding restore can take longer than 15s.
      // Wait for both the port and the old PID; never start competing workers.
      for(let i=0;i<120;i++){
        let listening=false;
        try{await this.http('http://127.0.0.1:18780/status');listening=true;}catch{}
        if(!listening&&!this.alive(oldPid))break;
        if(i===119)throw Error('旧语音服务释放模型超过30秒，请稍后重试。');
        await this.wait(250);
      }
    }
    if(['voice-start','voice-restart','sync-start'].includes(action)){
      if(action==='sync-start'&&this.syncStatus().ready)return {message:'设备联动正常运行，无需重复启动。'};
      if(action==='voice-start'){try{await this.http('http://127.0.0.1:18780/status');return {message:'语音服务已经运行，修改参数后请选择“应用语音设置”'};}catch{}}
      fs.mkdirSync(path.join(this.root,'mhub-community-assistant/state'),{recursive:true});
      const requestedAt=Date.now();let launch;
      try{launch=await this.launch(action==='sync-start'?path.join(dir,'Start-Harness.ps1'):path.join(this.voice,'Start.ps1'));}
      catch(error){let startup;try{startup=optional(path.join(this.sync,'startup-status.json'));}catch{}if(action==='sync-start'&&startup?.phase==='failed'&&startup.at>=requestedAt&&typeof startup.message==='string')throw Error(startup.message);throw error;}
      if(action==='sync-start'&&!launch?.pending){const startup=optional(path.join(this.sync,'startup-status.json'));if(!startup||startup.at<requestedAt)throw Error('启动程序未返回本次确认，请检查启动日志后重试。');if(startup.phase==='failed')throw Error(startup.message);}
      return {message:action==='sync-start'?(launch?.pending?'正在启动设备联动，页面会自动更新启动结果。':this.syncStatus().ready?'设备联动已恢复。':'联动守护已启动，正在初始化设备。'):'语音启动程序已运行，模型加载可能需要数十秒'};
    }
    if(action==='sync-stop'){this.syncStartup.cancel();atomicText(path.join(dir,'stop.request'),'stop');return {message:'已请求停止联动和取消恢复'};}
    if(!this.syncStatus().running)throw Error('设备联动尚未运行，请先启动设备联动。');
    if(/^screen-|^subtitle-preview$/.test(action)){
      if(!this.syncStatus().ready)throw Error('设备连接尚未恢复，请等待连接就绪后重试。');
      const screen=this.syncStatus().screen;
      if(screen?.ready===false&&!(action==='subtitle-preview'&&screen.captionsReady))throw Error(String(screen.error||'音箱屏幕未就绪，正在单独重连。').split(/\r?\n/,1)[0]);
    }
    if(action==='screen-page-next'){
      const id=this.queue(action);
      const status=await this.waitStatus(path.join(dir,'control-status.json'),s=>s.lastCommand?.id===id,8000);
      if(!status)throw Error('音箱尚未回执。请查看当前页面，避免重复切换。');
      if(!status.lastCommand.ok)throw Error(String(status.lastCommand.error||'音箱切页失败。').split(/\r?\n/,1)[0]);
      return {message:status.lastCommand.deferred?'已选中下一页，当前屏幕提示结束后显示。':'音箱已切到下一页。'};
    }
    if(action==='balance-refresh'){
      let balance;
      try{balance=await this.live2d.refreshBalance();}
      finally{this.queue('balance-refresh');}
      return {message:balance.status==='ready'?'余额已重新读取，灯条正在按真实余额更新。':balance.message||'余额来源暂不可用，未生成灯条数值。',balanceStatus:balance.status};
    }
    if(['balance-enable','balance-disable'].includes(action)){
      const enabled=action==='balance-enable',group=this.fileGroup('balance');
      const result=await this.save({group:'balance',revision:group.revision,values:{enabled}});
      if(enabled)this.queue('balance-refresh',{preferStandalone:true});
      return result;
    }
    if(action==='sync-stop'){atomicText(path.join(dir,'stop.request'),'stop');return {message:'已请求停止联动并恢复原设置，图片恢复可能需要约一分钟'};}
    if(['screen-animation','screen-text','screen-manual','screen-pages'].includes(action)){await writeModeOverride(dir,action==='screen-text'?'text':action==='screen-manual'?'manual':action==='screen-pages'?'pages':'animation');return {message:action==='screen-pages'?'已开启四种快捷页面，单击实体键切换':action==='screen-manual'?'已开启实体键浏览，任务状态继续控制灯光':'屏幕切换请求已发送'};}
    if(action==='beg-demo'){
      if(!this.syncStatus().ready)throw Error('请先恢复设备联动，再测试主动求摸摸');
      const id=this.queue('beg-demo');
      const state=await this.waitStatus(path.join(this.sync,'control-status.json'),s=>s.lastCommand?.id===id);
      if(!state)return {message:'测试请求已受理，状态暂未更新，请稍候查看灯光，不要重复触发'};
      if(state.lastCommand?.ok===false)throw Error(state.lastCommand.error||'当前无法测试求摸摸');
      return {message:'主动求摸摸测试已开始，请在八秒内摸摸回应；测试未回应不扣好感度'};
    }
    const mapping={'device-default-theme':'device-default-theme','subtitle-preview':'subtitle-preview','pet':'pet','beg-demo':'beg-demo','game-start':'game-start','game-replay':'game-replay','game-stop':'game-stop','attention-on':'attention-on','attention-off':'attention-off','fireworks-demo':'fireworks-demo','task-light-stop':'task-light-stop','balance-refresh':'balance-refresh','screen-page-next':'screen-page-next','screen-animation-next':'screen-animation-next'};
    if(!Object.hasOwn(mapping,action))throw Error('没有这个控制操作。');
    this.queue(mapping[action]);
    return {message:'请求已发送，联动程序会按当前任务状态处理'};
  }
}
function optionalText(file){try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}}
function atomicText(file,text){const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);}
