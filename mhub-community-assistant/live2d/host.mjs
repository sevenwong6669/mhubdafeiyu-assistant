import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicJson, revision} from '../companion/config.mjs';
import {createCore} from './core.mjs';
import {live2dToolDefinitions} from './tools.mjs';

export {live2dToolDefinitions};
export const LIVE2D_PREFIX = '/api/mhub-community/live2d';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const readJson = (file, fallback) => {try {return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));} catch(error) {if (error.code === 'ENOENT') return fallback; throw error;}};
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const directRoutes = ['/dupsim','/test','/ear','/call','/callsay','/earsay','/manual','/motions','/make-motion','/clips','/play','/reset','/size','/look','/fore','/ear-config','/talk-config','/call-config','/wake-config','/watch','/watch-line','/watch-config','/mhub-state','/mhub-asr-prepare','/mhub-native-call','/mhub-call','/mhub-watch-speech','/mhub-watch-status','/mhub-watch','/mhub-asr','/mhub-conversation-repair','/mhub-turn','/state','/launch','/stop','/settings','/desktop-config','/show','/hide','/restart','/expressions','/events','/playback','/tools','/tool'];
const readRoutes = ['/state','/clips','/manual','/motions','/settings','/desktop-config','/expressions','/tools','/events','/mhub-state'];
export const LIVE2D_ROUTES = Object.freeze([...directRoutes, ...directRoutes.map(route => '/ext/live2d' + route)]);
export const LIVE2D_GET_ROUTES = Object.freeze([...readRoutes, ...readRoutes.map(route => '/ext/live2d' + route)]);
const normalizeRoute = value => ('/' + String(value ?? '').replace(/^\/+/, '')).replace(/^\/ext\/live2d(?=\/)/, '');
export const live2dBodyLimit = value => /\/(?:ear|call|watch|watch-line|mhub-asr)$/.test(normalizeRoute(value)) ? 16 * 1024 * 1024 : /\/(?:make-motion|tool)$/.test(normalizeRoute(value)) ? 2 * 1024 * 1024 : 64 * 1024;

// The original author-owned core keeps its complete action, expression and call
// logic. This host replaces only AuraBot's extension API, bus and process owner.
export class InternalLive2d {
  constructor({companion, stateDir = path.join(projectRoot, 'state'), token, clock = Date.now, spawnImpl = spawn, inspectProcess = inspectPetProcess, stopTimeoutMs = 4000, sourcePetDir = path.join(projectRoot, 'live2d-pet'), electronPath = path.join(sourcePetDir, 'node_modules/electron/dist/electron.exe')} = {}) {
    if (!companion) throw Error('内部 Live2D 需要项目内部伙伴服务。');
    this.companion = companion; this.token = token; this.clock = clock;
    this.dir = path.join(stateDir, 'live2d'); this.dataPetDir = path.join(this.dir, 'pet');
    this.sourcePetDir = sourcePetDir; this.electronPath = electronPath;
    this.hostFile = path.join(this.dir, 'host.json'); this.petFile = path.join(this.dir, 'pet.json');
    this.processFile = path.join(this.dir, 'pet-process.json'); this.settingsFile = path.join(this.dir, 'settings.json');
    this.spawn = spawnImpl; this.inspectProcess = inspectProcess; this.stopTimeoutMs = stopTimeoutMs;
    this.routes = new Map(); this.tools = new Map(); this.hooks = new Map(); this.rules = [];
    this.disposers = []; this.intervals = []; this.waiters = new Set(); this.bus = new EventEmitter();
    this.events = []; this.cursor = 0; this.bootId = randomUUID(); this.jobs = new Map(); this.sessions = new Map(); this.requests = new Set();
    this.lastPeerAt = 0; this.peer = null; this.activated = false; this.closed = false;
    this.identity = null; this.processCheck = null; this.lifecycle = null;
    this.cached = {ok:true, provider:'internal-live2d', online:false, asr:false, asrPhase:'unprepared', call:false, watch:false, nativeCall:null, watchStatus:{capture:{phase:'stopped'}}};
    this.runtime = {sourcePetDir, dataPetDir:this.dataPetDir, electronPath, hostFile:this.hostFile, activated:() => this.activated,
      readResource:name => fs.existsSync(path.join(this.dataPetDir,name)) ? path.join(this.dataPetDir,name) : path.join(this.sourcePetDir,name), readPetSettings:() => this.readPet(),
      writePetSettings:patch => {atomicJson(this.petFile,{...this.readPet(),...patch});this.reconcileConversationJobs();}, writeResource:(name,value) => atomicJson(path.join(this.dataPetDir,name),value),
      hasModel:() => this.hasModel(), petRunning:() => this.identity?.matches === true ? this.identity.pid : null,
      launch:() => this.launch(), stop:() => this.stop()};
    this.api = this.createApi(); this.core = createCore(); this.core.setup(this.api);
    this.routes.set('/launch', () => this.launch()); this.routes.set('/stop', () => this.stop());
  }
  activate() {
    if (this.activated || this.closed) return;
    this.seedResources(); this.syncDesktopConfig({coldStart:true});
    atomicJson(this.hostFile, {baseUrl:'http://127.0.0.1:18782', api:LIVE2D_PREFIX, token:this.token, pid:process.pid,
      sourcePetDir:this.sourcePetDir, dataPetDir:this.dataPetDir, version:'0.16.0-integrated'});
    this.activated = true;
    for (const interval of this.intervals) {interval.timer = setInterval(() => this.background(interval.fn,'core-maintenance'), interval.ms); interval.timer.unref?.();}
    this.timer = setInterval(() => {this.background(() => this.refreshStatus(),'heartbeat');this.background(() => this.reconcileProcess(),'process-status');}, 1000); this.timer.unref?.();
    void this.reconcileProcess(); void this.refreshStatus();
  }
  seedResources() {
    fs.mkdirSync(this.dataPetDir, {recursive:true});
    for (const name of ['clips.json','faces.json','参数词典.json','关节词典.md','能力手册.md']) {
      const file = path.join(this.dataPetDir, name), source = path.join(this.sourcePetDir, name);
      if (!fs.existsSync(file) && fs.existsSync(source)) fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
    }
    if (!fs.existsSync(this.petFile)) atomicJson(this.petFile, {ear:{on:false}, call:{on:false}, wake:{on:false}, watch:{on:false}, talk:{to:'system'}});
  }
  readPet() {return readJson(this.petFile, {ear:{on:false},call:{on:false},wake:{on:false},watch:{on:false},talk:{to:'system'}});}
  moduleSettings() {return {...this.core?.defaults ?? {on:true,scope:'private',voice:true,auto:true,autoFace:true}, ...readJson(this.settingsFile, {})};}
  syncDesktopConfig({coldStart = false} = {}) {
    const pet = this.companion.config.read().pet;
    const saved = this.readPet();
    if (coldStart && (saved.call?.on || saved.call?.mhubOwner)) {
      // A new host owns no call. The persisted switch cannot resume the old microphone session.
      saved.call = {...saved.call, on:false, muted:false, mhubOwner:null, mhubSilenceMs:null};
    }
    if (coldStart && saved.mhubWatchOwner) {
      saved.watch = {...saved.watch, on:false};
      saved.mhubWatchOwner = null;
    }
    atomicJson(this.petFile, {...saved, desktop:{...pet, autoHideFullscreen:pet.autoHide}});
    return pet;
  }
  desktopConfig() {
    const saved = this.companion.config.snapshot(), values = {...saved.values.pet, autoHideFullscreen:saved.values.pet.autoHide};
    return {ok:true, values, revision:saved.revision, running:!!this.runtime.petRunning(), applied:true};
  }
  async saveDesktopConfig(input) {
    const saved = this.companion.config.snapshot(), values = input.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('桌宠设置格式无效。');
    if (Object.keys(values).some(key => !['modelFile','coreFile','autoHide','autoHideFullscreen','enabled','displayId'].includes(key))) throw Error('存在无法识别的桌宠设置。');
    const previous = saved.values.pet, next = {...previous, ...values};
    if ('autoHideFullscreen' in values) next.autoHide = values.autoHideFullscreen;
    delete next.autoHideFullscreen;
    for (const key of ['modelFile','coreFile']) if (next[key]) {
      if (!path.isAbsolute(next[key]) || !fs.statSync(next[key]).isFile()) throw Error('请选择本机存在的模型或 Core 文件。');
      if (key === 'modelFile' && !/\.model3\.json$/i.test(next[key])) throw Error('模型需要选择 .model3.json 文件。');
      if (key === 'coreFile' && !/\.js$/i.test(next[key])) throw Error('Core 需要选择 JavaScript 文件。');
    }
    await this.companion.config.save({values:{...saved.values,pet:next}, revision:input.revision});
    this.syncDesktopConfig();
    const needsRestart = !!this.runtime.petRunning() && ['modelFile','coreFile'].some(key => previous[key] !== next[key]);
    return {...this.desktopConfig(), applied:!needsRestart, ...(needsRestart ? {message:'设置已保存，结束电话和陪看后重启桌宠可应用新模型。'} : {})};
  }
  online() {return this.lastPeerAt > 0 && this.clock() - this.lastPeerAt < 45000 && !this.closed;}
  runtimeStatus() {
    const phase = this.companion.asr.phase;
    return {...this.cached, online:this.online() && !!this.runtime.petRunning(), asr:phase === 'ready', asrPhase:phase === 'preparing' ? 'loading' : phase,
      asrError:this.companion.asr.error ?? null, provider:'internal-live2d',lastBackgroundError:this.lastBackgroundError ?? null};
  }
  background(fn,stage) {
    const failed=error=>{this.backgroundError={stage,at:this.clock(),message:error instanceof SyntaxError?'Live2D 配置或状态 JSON 无法读取，原文件已保留。':String(error.message ?? error).slice(0,240)};this.lastBackgroundError=this.backgroundError;this.cached={...this.cached,error:this.backgroundError.message};};
    try{Promise.resolve(fn()).catch(failed);}catch(error){failed(error);}
  }
  async refreshStatus() {
    if (!this.activated || this.closed) return this.runtimeStatus();
    try {this.reconcileConversationJobs();const value = await this.invoke('/mhub-state');if(value?.ok===false)throw Error(value.message || 'Live2D 状态暂不可读。');this.cached = {...this.cached,...value,error:null};this.backgroundError=null;} catch(error) {this.backgroundError={stage:'heartbeat',at:this.clock(),message:error instanceof SyntaxError?'Live2D 配置或状态 JSON 无法读取，原文件已保留。':error.message};this.lastBackgroundError=this.backgroundError;this.cached = {...this.cached,error:this.backgroundError.message};}
    return this.runtimeStatus();
  }
  async snapshot() {
    await this.refreshStatus();
    const state = {...await this.invoke('/state'),nativeCall:this.cached.nativeCall ?? null}, clips = await this.invoke('/clips'), values = this.moduleSettings();
    return {state, clips, settings:{values, revision:revision(values)}, revision:revision(values)};
  }
  push(type, value = {}) {
    const event = {id:++this.cursor, at:this.clock(), type,...value}; this.events.push(event);
    this.events = this.events.filter(item => this.clock() - item.at < 120000).slice(-128);
    for (const wake of [...this.waiters]) wake();
    return event;
  }
  async poll(input, signal) {
    if (this.waiters.size >= 8) throw Error('桌宠订阅连接过多。');
    const client = String(input.client ?? '').slice(0,100);
    if (!client) throw Error('桌宠客户端标识缺失。');
    if (this.online() && this.peer !== client) throw Error('已有另一个桌宠实例连接。');
    this.peer = client; this.lastPeerAt = this.clock();
    const supplied = input.since !== undefined && input.since !== null && input.since !== '';
    const since = supplied ? Number(input.since) : this.cursor;
    if (!Number.isSafeInteger(since) || since < 0 || since > this.cursor) return {bootId:this.bootId,cursor:this.cursor,events:[]};
    // Original pet protocol expresses the long poll duration in seconds.
    const waitMs = Math.min(25000,Math.max(0,Number(input.wait) || 0) * 1000);
    if (waitMs && !this.events.some(event => event.id > since)) await new Promise(resolve => {
      let timer; const done = () => {clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve();};
      this.waiters.add(done); timer = setTimeout(done,waitMs); signal?.addEventListener('abort',done,{once:true}); if (signal?.aborted) done();
    });
    return {bootId:this.bootId,cursor:this.cursor,events:this.events.filter(event => event.id > since)};
  }
  createApi() {
    const self = this;
    const stt = {snapshot:() => ({selection:{providerId:'sensevoice-local'},providers:[{id:'sensevoice-local',preparation:{phase:self.companion.asr.phase === 'preparing' ? 'loading' : self.companion.asr.phase, message:self.companion.asr.error}}]}),
      prepare:() => {const p = self.companion.asr.prepare(); void p.catch(() => {}); return p;},
      resolve:input => input, transcribe:async (spec,signal) => (await self.companion.asr.recognize(Buffer.from(spec.audio),signal)).heard};
    const pet = {online:() => ({online:self.online(),lastSeenAt:self.lastPeerAt}), setThinking:on => {self.push('work',{state:on?'thinking':null});},
      dispatch:async payload => {if (!self.online()) return {ok:false,reason:'pet-offline'}; self.push('proactive',payload); return {ok:true};}};
    return {runtime:this.runtime, settings:() => self.moduleSettings(), config:() => ({ownerQQ:self.companion.config.read().qq.owner}), dataDir:() => self.dir,
      log:{info(){},warn(){},error(){},debug(){}},
      route:(route, fn) => self.routes.set(route, fn), defineTool:definition => self.tools.set(definition.name,definition),
      rule:fn => self.rules.push(fn), on:(name,fn) => {const set = self.hooks.get(name) ?? new Set(); set.add(fn); self.hooks.set(name,set); return () => set.delete(fn);},
      onDispose:fn => self.disposers.push(fn), every:(ms,fn) => self.intervals.push({ms,fn}),
      use:name => name === 'pet' ? pet : undefined,
      lib:() => ({stripMarkdown:text => String(text).replace(/\*\*|__|`/g,'')}),
      dsh:{get:name => name === 'speechToText' ? stt : undefined, on:(name,fn) => {self.bus.on(name,fn); return () => self.bus.off(name,fn);}},
      core:{http:{body:async req => req.input ?? {}, query:req => Object.fromEntries(new URL(req.url,'http://127.0.0.1:18782').searchParams)},
        hub:{pushToSession:(chat,content,owner,options) => self.pushToSession(chat,content,owner,options), canSeeImages:async () => self.companion.config.read().chat.vision,
          sessions:() => Object.fromEntries(self.sessions), chatOfSession:id => [...self.sessions].find(([,entry]) => entry.sessionId === id)?.[0] ?? '',
          resetChat:chatId => {const entry = self.sessions.get(chatId); if (!entry) return false; for (const [turn,job] of self.jobs) if (job.chatId === chatId) self.cancelConversationJob(turn,job); self.sessions.delete(chatId); return true;}}}};
  }
  cancelConversationJob(turn, job) {
    if (job.cancelled) return;
    job.cancelled=true;job.abort.abort();if(this.jobs.get(turn)===job)this.jobs.delete(turn);
    if(!this.closed)this.bus.emit('session/event',{header:job.header},{type:'turn/end',data:{turn,reason:{kind:'cancelled'}}});
  }
  reconcileConversationJobs() {
    if (!this.jobs.size) return;
    const settings=this.readPet();
    for (const [turn,job] of this.jobs) {
      if (job.kind==='watch' && (!settings.watch?.on || settings.watch.sessionVersion!==job.watchVersion)
        || job.kind==='call' && (!settings.call?.on || (settings.call.mhubOwner || '')!==job.callOwner)) this.cancelConversationJob(turn,job);
    }
  }
  async pushToSession(chat, content, owner, options = {}) {
    if (!this.activated || this.closed) throw Error('Live2D 内部服务尚未启动。');
    if (this.jobs.size >= 4) throw Error('正在处理的 Live2D 请求过多，请稍后再试。');
    const chatId = chat.chatId;
    if ([...this.jobs.values()].some(job => job.chatId === chatId)) throw Error('上一轮对话仍在处理中。');
    let session = this.sessions.get(chatId);
    if (!session) {session = {sessionId:randomUUID(), title:chat.title ?? '桌宠对话'}; this.sessions.set(chatId,session);}
    if (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value);
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const watchRequestId=/^【live2d-watch:([a-f0-9-]+)】/.exec(text)?.[1], kind=watchRequestId?'watch':text.startsWith('（我们正在打电话')?'call':'voice';
    const settings=this.readPet(), header = {id:session.sessionId}, turn = randomUUID(), abort = new AbortController(), job = {chatId,abort,header,kind,watchRequestId,
      watchVersion:settings.watch?.sessionVersion,callOwner:settings.call?.mhubOwner || '',at:this.clock()};
    this.jobs.set(turn,job);
    const image = content.find(block => block.type === 'image'), signal = AbortSignal.any([abort.signal,AbortSignal.timeout(kind==='call'?35000:90000)]);
    this.bus.emit('session/event',{header},{type:'user/message',data:{id:turn,role:'user',content,source:{kind:'live2d'}}});
    job.promise = (async () => {
      try {
        const heard = String(options.queryText ?? text);
        const device = this.companion.deviceCommand(heard,chatId.startsWith('private:') ? 'qq' : 'voice');
        const result = device.handled ? {reply:device.message} : await this.companion.turn(text,{kind:'live2d',skipDeviceCommand:true,...this.replyContext('private'),
          conversation:'live2d:'+session.sessionId, signal, ...(image ? {image:'data:'+image.mediaType+';base64,'+image.data} : {})});
        signal.throwIfAborted(); if (job.cancelled || this.closed || this.sessions.get(chatId) !== session) return;
        let reply = result.reply;
        if (chatId.startsWith('private:')) {reply = await this.decorateReply(reply,{chatId,userText:heard}); if (reply && this.companion.qq?.online) await this.companion.qq.send(owner,reply);}
        signal.throwIfAborted();if(job.cancelled||this.closed)return;
        // Core turn/end drains its queued next phone sentence synchronously.
        // Release this host slot first so that next turn is actually accepted.
        if(this.jobs.get(turn)===job)this.jobs.delete(turn);
        this.bus.emit('session/event',{header},{type:'assistant/message',data:{turn,message:{content:[{type:'text',text:result.reply}]}}});
        this.bus.emit('session/event',{header},{type:'turn/end',data:{turn,reason:{kind:'completed'}}});
      } catch(error) {
        if(this.jobs.get(turn)===job)this.jobs.delete(turn);
        if (!job.cancelled && !this.closed) this.bus.emit('session/event',{header},{type:'turn/end',data:{turn,reason:{kind:'error',message:error.message}}});
      } finally {if (this.jobs.get(turn) === job) this.jobs.delete(turn);}
    })();
    void job.promise.catch(() => {});
    return {ok:true,sessionId:session.sessionId,requestId:turn};
  }
  replyContext(kind = 'private') {
    const settings=this.moduleSettings(), inScope=settings.on && (settings.scope === 'both' || kind === 'private');
    if (!inScope) return {systemAppend:'',tools:[]};
    return {systemAppend:this.rules.map(rule=>rule(kind)).filter(Boolean).join('\n'),
      tools:live2dToolDefinitions.map(({name,description,properties,required})=>({type:'function',function:{name,description,parameters:{type:'object',properties,required:required ?? [],additionalProperties:false}}})),
      toolExecutor:(name,args)=>this.invoke('/tool',{name,args})};
  }
  async decorateReply(text, info) {let reply = text; for (const fn of this.hooks.get('reply') ?? []) {const result = await fn(reply,info); if (result === null) return ''; if (typeof result === 'string') reply = result;} return reply;}
  hasModel() {
    const selected = this.companion.config.read().pet.modelFile;
    if (selected) {try {const value = readJson(selected,null); return !!value?.FileReferences?.Moc && fs.existsSync(path.resolve(path.dirname(selected),value.FileReferences.Moc));} catch {return false;}}
    const walk = (dir,depth=0) => {try {return depth < 4 && fs.readdirSync(dir,{withFileTypes:true}).some(entry => entry.isDirectory() ? walk(path.join(dir,entry.name),depth+1) : /\.model3\.json$/i.test(entry.name));} catch {return false;}};
    return walk(path.join(this.dataPetDir,'model'));
  }
  async reconcileProcess({force = false} = {}) {
    if (this.processCheck) {
      await this.processCheck;
      if (force) return this.reconcileProcess({force:true});
      return;
    }
    if (!force && this.processCheckedAt !== undefined && this.clock() - this.processCheckedAt < 10000) return;
    this.processCheckedAt = this.clock();
    this.processCheck = (async () => {
      const record = readJson(this.processFile,null); if (!record?.pid) {if (!this.child) this.identity = null; return;}
      const identity = await this.inspectProcess(record.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath);
      const currentRecord=readJson(this.processFile,null);
      if (currentRecord?.pid!==record.pid) return;
      // Earlier shells stored module-load time as startedAt. Only the host's
      // verified creation time is an identity fence; upgrade legacy telemetry.
      if (identity.matches === true && Number.isFinite(identity.startedAt) && (!currentRecord.identityVerified || currentRecord.startedAt === identity.startedAt)) {
        this.identity = identity;
        if (!currentRecord.identityVerified) atomicJson(this.processFile,{...currentRecord,bootedAt:currentRecord.bootedAt ?? currentRecord.startedAt,startedAt:identity.startedAt,identityVerified:true});
      }
      else if (!this.child) this.identity = null;
    })().catch(() => {}).finally(() => {this.processCheck = null;});
    return this.processCheck;
  }
  async launch() {
    if (!this.activated || this.closed) throw Error('Live2D 服务尚未启动。');
    if (this.lifecycle) return this.lifecycle;
    this.lifecycle = (async () => {
      await this.reconcileProcess({force:true}); if (this.runtime.petRunning()) return {ok:true,message:'桌宠已经在运行。',pid:this.identity.pid};
      if (!fs.existsSync(path.join(this.sourcePetDir,'app/main.js'))) throw Error('完整 Live2D 桌宠程序未安装。');
      if (!fs.existsSync(this.electronPath)) throw Error('桌宠运行环境未安装，请在 live2d-pet 目录执行 npm ci。');
      if (!this.hasModel()) throw Error('请先选择用户自己的 Live2D .model3.json 模型和 Cubism Core。');
      const settings = this.syncDesktopConfig(), fallbackCore = path.join(this.dataPetDir,'sdk/live2dcubismcore.min.js');
      if (!fs.existsSync(settings.coreFile || fallbackCore)) throw Error('请先选择 Cubism Core JavaScript 文件。');
      // Any stale owner must be confirmed absent before creating another shell.
      const record = readJson(this.processFile,null);
      if (record?.pid) {const found = await this.inspectProcess(record.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath); if (found.matches !== false) throw Error('无法确认原桌宠进程已经退出，已避免重复启动。');}
      const env={...process.env,LIVE2D_STATE_DIR:this.dir,LIVE2D_PET_SETTINGS:this.petFile,LIVE2D_PET_ASSETS:this.dataPetDir,
        AURABOT_PET_HOST:this.hostFile,DAFEIYU_COMPANION_HOST:this.hostFile};
      // Electron treats presence (including an empty string) as Node mode.
      // Windows environment names are case insensitive, so remove every alias.
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
      const child = this.spawn(this.electronPath,[path.join(this.sourcePetDir,'app/main.js')],{cwd:this.sourcePetDir,windowsHide:true,detached:true,stdio:'ignore',env});
      this.child = child;
      let exited=false;
      const clearChild=() => {exited=true; if (this.child === child) {this.child=null; if (this.identity?.pid===child.pid) this.identity=null; this.lastPeerAt=0;}};
      // Register before the slow identity query; an immediate startup failure
      // must not be missed and remain cached as a living desktop pet.
      child.once('exit',clearChild); child.once('error',clearChild);
      await new Promise((resolve,reject) => {child.once('spawn',resolve); child.once('error',reject);});
      child.unref?.(); const identity = await this.inspectProcess(child.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath);
      if (exited || child.exitCode != null || child.signalCode != null || identity.matches === false) {clearChild(); throw Error('桌宠启动后已退出，请检查运行环境和桌宠日志。');}
      this.identity = identity.matches === true ? identity : {pid:child.pid,matches:true,startedAt:this.clock(),spawnOwned:true};
      const prior=readJson(this.processFile,{});
      atomicJson(this.processFile,{...(prior.pid===child.pid?prior:{}),pid:child.pid,...(identity.matches===true?{startedAt:identity.startedAt,identityVerified:true}:{bootedAt:this.clock(),identityVerified:false}),sourcePetDir:this.sourcePetDir});
      return {ok:true,pid:child.pid,message:'桌宠启动请求已发送，正在等待画面连接。'};
    })().finally(() => {this.lifecycle = null;});
    return this.lifecycle;
  }
  async stop() {
    await this.reconcileProcess({force:true}); const identity = this.identity;
    if (!identity) {
      const record=readJson(this.processFile,null);
      if (record?.pid && (await this.inspectProcess(record.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath)).matches !== false) throw Error('无法核对桌宠进程归属，已保留该进程，请手动退出桌宠。');
      return {ok:true,message:'桌宠没有在运行。'};
    }
    await this.cancelOwnedSessions(); this.push('control',{action:'quit'});
    const until = Date.now() + this.stopTimeoutMs;
    while (Date.now() < until) {const current = await this.inspectProcess(identity.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath); if (current.matches === false) {this.identity = null; this.lastPeerAt = 0; return {ok:true};} await new Promise(resolve => setTimeout(resolve,100));}
    const current = await this.inspectProcess(identity.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath);
    if (current.matches !== true || !Number.isFinite(identity.startedAt)) throw Error('无法核对桌宠进程归属，已保留该进程，请手动退出桌宠。');
    if (current.startedAt !== identity.startedAt) throw Error('桌宠进程身份已变化，已保留该进程，请重新核对。');
    process.kill(identity.pid);
    const confirmationUntil=Date.now()+2000;
    while (Date.now()<confirmationUntil) {
      const observed=await this.inspectProcess(identity.pid,path.join(this.sourcePetDir,'app/main.js'),this.electronPath);
      if (observed.matches===false) {this.identity=null;this.lastPeerAt=0;return {ok:true,message:'已停止本项目的桌宠进程。'};}
      if (observed.matches!==true || observed.startedAt!==identity.startedAt) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('已请求停止桌宠，尚未确认退出；请稍后重试，已避免立即启动第二个实例。');
  }
  async cancelOwnedSessions() {
    for (const [turn,job] of this.jobs) this.cancelConversationJob(turn,job);
    const settings = this.readPet();
    if (settings.call?.on) await this.invoke('/call-config',{on:false});
    if (settings.watch?.on) await this.invoke('/watch-config',{on:false});
    for (const job of this.jobs.values()) void job.promise?.catch(() => {});
  }
  async invoke(value, body = {}, request) {
    const route = normalizeRoute(value);
    if (this.closed) throw Error('Live2D 服务已停止。');
    if (!this.activated && (!readRoutes.includes(route) || Object.keys(body).length && route !== '/events')) throw Error('Live2D 服务尚未启动。');
    if (!this.activated && route === '/mhub-state') return this.runtimeStatus();
    if (route === '/settings') {
      if (request?.method === 'GET' || !Object.keys(body).length) {const values=this.moduleSettings(); return {ok:true,values,revision:revision(values)};}
      const values = body.values, current = this.moduleSettings();
      if (body.revision !== revision(current)) throw Error('Live2D 设置已改变，请刷新后重试。');
      if (!values || Object.keys(values).some(key => !['on','scope','voice','auto','autoFace'].includes(key)) || ['on','voice','auto','autoFace'].some(key => typeof values[key] !== 'boolean') || !['private','both'].includes(values.scope)) throw Error('Live2D 设置格式无效。');
      atomicJson(this.settingsFile,values); return {ok:true,values,revision:revision(values)};
    }
    if (route === '/desktop-config') return request?.method === 'GET' || !Object.keys(body).length ? this.desktopConfig() : this.saveDesktopConfig(body);
    if (route === '/show' || route === '/hide') {this.push('control',{action:route.slice(1)}); return {ok:true,accepted:true,online:this.online()};}
    if (route === '/restart') {
      const s = this.readPet();
      if (s.call?.on) throw Error('请先结束电话和陪看再重启桌宠。');
      if (!this.runtime.petRunning()) return this.launch();
      if (s.watch?.on) throw Error('请先结束电话和陪看再重启桌宠。');
      await this.stop();
      return this.launch();
    }
    if (route === '/expressions') {const faces=readJson(path.join(this.dataPetDir,'faces.json'),{}), names=Object.keys(faces.faces ?? {}); if (request?.method === 'GET' || !Object.keys(body).length) return {ok:true,names}; if (!names.includes(body.name)) throw Error('表情不存在，请刷新后重试。'); if (!this.online()) throw Error('请先启动桌宠。'); this.push('control',{action:'expression',name:body.name}); return {ok:true,name:body.name};}
    if (route === '/tools') return {ok:true,tools:[...this.tools.values()].map(({execute,...definition}) => definition)};
    if (route === '/tool') {const definition=this.tools.get(body.name); if (!definition) throw Error('没有这个 Live2D 工具。'); if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw Error('工具参数无效。'); return definition.execute(body.args);}
    if (route === '/events') return this.poll(body,request?.signal);
    if (route === '/playback') {this.lastPeerAt=this.clock(); return {ok:true};}
    const fn = this.routes.get(route); if (!fn) throw Object.assign(Error('没有这个 Live2D 功能。'),{status:404});
    const req = new EventEmitter(); req.input=body; req.url=request?.url ?? 'http://127.0.0.1:18782'+LIVE2D_PREFIX+route;
    req.headers={'x-pet-token':this.token}; req.method=request?.method ?? 'POST';
    const abort = () => req.emit('aborted'); request?.signal.addEventListener('abort',abort,{once:true}); this.requests.add(req);
    if (request?.signal.aborted) {this.requests.delete(req); request.signal.removeEventListener('abort',abort); throw request.signal.reason ?? Error('请求已取消。');}
    try {const result=await fn(req); if (route === '/mhub-state') this.cached={...this.cached,...result}; return result;}
    finally {this.requests.delete(req); request?.signal.removeEventListener('abort',abort);}
  }
  async handle(request) {
    const url=new URL(request.url); if (!url.pathname.startsWith(LIVE2D_PREFIX+'/')) return null;
    const route=normalizeRoute(url.pathname.slice(LIVE2D_PREFIX.length));
    const response=(data,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store'}});
    if (!directRoutes.includes(route)) return response({ok:false,error:'没有这个 Live2D 功能。'},404);
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return response({ok:false,error:'不接受跨站请求。'},403);
    if (!['GET','POST'].includes(request.method) || request.method === 'GET' && !readRoutes.includes(route)) return response({ok:false,error:'请求方法无效。'},405);
    const token=request.headers.get('x-pet-token') ?? request.headers.get('x-mhub-panel-token');
    const publicRead=request.method === 'GET' && !['/events','/mhub-state'].includes(route);
    if (!publicRead && !safeEqual(token,this.token)) return response({ok:false,error:'Live2D 请求未授权，请刷新后台。'},403);
    try {
      if (!this.activated) throw Error('内部 Live2D 服务尚未启动。');
      let body=Object.fromEntries(url.searchParams);
      if (request.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return response({ok:false,error:'需要 JSON 请求。'},415);
        let size=0,text=''; const decoder=new TextDecoder();
        for await (const chunk of request.body ?? []) {size+=chunk.byteLength; if (size>live2dBodyLimit(route)) return response({ok:false,error:'请求内容过大。'},413); text+=decoder.decode(chunk,{stream:true});}
        text+=decoder.decode(); body=JSON.parse(text || '{}');
        if (!body || typeof body!=='object' || Array.isArray(body)) throw Error('请求内容无效。');
      }
      const result=await this.invoke(route,body,request);
      return response(result);
    } catch(error) {return response({ok:false,error:String(error.message).slice(0,240),message:String(error.message).slice(0,240),...(error.code?{code:error.code}:{})},error.status ?? 400);}
  }
  close() {
    if (this.closed) return; this.closed=true; clearInterval(this.timer);
    for (const job of this.jobs.values()) job.abort.abort();
    for (const req of this.requests) req.emit('aborted');
    for (const interval of this.intervals) clearInterval(interval.timer);
    for (const dispose of this.disposers) {try {dispose();} catch {}}
    for (const wake of [...this.waiters]) wake(); this.bus.removeAllListeners(); this.hooks.clear();
  }
}

async function inspectPetProcess(pid, script, executable) {
  if (!Number.isSafeInteger(pid) || pid < 1) return {pid,matches:false};
  try {
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/inspect-process.ps1',import.meta.url)),'-TargetId',String(pid)],{windowsHide:true,timeout:6000,maxBuffer:8192});
    if (!stdout.trim()) return {pid,matches:false};
    const info=JSON.parse(stdout.replace(/^\uFEFF/,'')); if (!info.command) return {pid,matches:null};
    const args=(info.command.match(/"[^"]*"|[^\s]+/g) ?? []).map(arg => arg.replace(/^"|"$/g,''));
    return {pid,startedAt:info.startedAt,matches:String(info.name).toLowerCase()==='electron.exe' && !!args[0] && !!args[1] && path.resolve(args[0]).toLowerCase()===path.resolve(executable).toLowerCase() && path.resolve(args[1]).toLowerCase()===path.resolve(script).toLowerCase()};
  } catch {return {pid,matches:null};}
}
