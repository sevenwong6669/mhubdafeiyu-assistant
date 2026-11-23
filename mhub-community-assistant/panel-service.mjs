import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CommunityAssistant } from './assistant.mjs';
import { deviceInventory } from './devices.mjs';
import { normalizeShare, hash, textArgument } from './community.mjs';
import { learnCommunity } from './scripts/learn-community.mjs';
import { ControlService } from './control-service.mjs';
import {LearningCoordinator} from './learning.mjs';
import {stateDirectoryId} from './learning-client.mjs';
import {smartisanAssets} from './smartisan-assets.mjs';
import {weatherAction} from '../harness-mhub-sync/weather.mjs';
import {qqConnection,AuraBotLocator} from './qq-connection.mjs';
import {saveUiLanguage} from './ui-preferences.mjs';
import {readRecovery,recentOperations} from './recovery.mjs';
import {CompanionService,COMPANION_PREFIX,COMPANION_GET,COMPANION_POST,companionBodyLimit} from './companion/service.mjs';
import {WallpaperService,WALLPAPER_BODY_LIMIT} from './wallpaper-service.mjs';
import {InternalLive2d,LIVE2D_PREFIX,LIVE2D_ROUTES,LIVE2D_GET_ROUTES,live2dBodyLimit} from './live2d/host.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export const PANEL_VERSION=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
export const PANEL_PREFIX = '/api/mhub-community';
const animationAssets=JSON.parse(fs.readFileSync(path.join(root,'../harness-mhub-sync/assets/residents/catalog.json'),'utf8'))
  .filter(clip=>/^[a-z_]+$/.test(clip.id))
  .map(({id})=>['/screen-preview/'+id+'.gif',['../harness-mhub-sync/assets/residents/'+id+'.gif','image/gif']]);
const assets = new Map([
  ['/panel', ['panel/index.html', 'text/html; charset=utf-8']],
  ['/panel.css', ['panel/panel.css', 'text/css; charset=utf-8']],
  ['/panel.js', ['panel/panel.js', 'text/javascript; charset=utf-8']],
  ['/setup.js', ['panel/setup.js', 'text/javascript; charset=utf-8']],
  ['/setup.css', ['panel/setup.css', 'text/css; charset=utf-8']],
  ['/tts.js', ['panel/tts.js', 'text/javascript; charset=utf-8']],
  ['/tts.css', ['panel/tts.css', 'text/css; charset=utf-8']],
  ['/control.js', ['panel/control.js', 'text/javascript; charset=utf-8']],
  ['/wallpaper.js', ['panel/wallpaper.js', 'text/javascript; charset=utf-8']],
  ['/wallpaper.css', ['panel/wallpaper.css', 'text/css; charset=utf-8']],
  ['/companion.js', ['panel/companion.js', 'text/javascript; charset=utf-8']],
  ['/live2d.js', ['panel/live2d.js', 'text/javascript; charset=utf-8']],
  ['/live2d.css', ['panel/live2d.css', 'text/css; charset=utf-8']],
  ['/themes/boot.js', ['panel/themes/boot.js', 'text/javascript; charset=utf-8']],
  ['/themes/appearance.js', ['panel/themes/appearance.js', 'text/javascript; charset=utf-8']],
  ['/themes/appearance.css', ['panel/themes/appearance.css', 'text/css; charset=utf-8']],
  ['/themes/liquid-glass-light/theme.css', ['panel/themes/liquid-glass-light/theme.css', 'text/css; charset=utf-8']],
  ['/themes/porcelain/theme.css', ['panel/themes/porcelain/theme.css', 'text/css; charset=utf-8']],
  ['/themes/porcelain/glyphs.css', ['panel/themes/porcelain/glyphs.css', 'text/css; charset=utf-8']],
  ['/themes/porcelain/icons.js', ['panel/themes/porcelain/icons.js', 'text/javascript; charset=utf-8']],
  ['/themes/porcelain/glyphs.png', ['panel/themes/porcelain/glyphs.png', 'image/png']],
  ['/themes/porcelain/fonts/PorcelainUI.woff2', ['panel/themes/porcelain/fonts/PorcelainUI.woff2', 'font/woff2']],
  ['/themes/assets/dafeiyu-original.png', ['panel/themes/assets/dafeiyu-original.png', 'image/png']],
  ['/themes/assets/dafeiyu-wallpaper.png', ['panel/themes/assets/dafeiyu-wallpaper.png', 'image/png']],
  ...["catalog.js","runtime.js","settings.js","settings.css","zh-CN.json","en.json","ru.json","fr.json","it.json","assets/arrow-pressed.png","assets/arrow.png","assets/divider.9.png","assets/language.png","assets/provenance.json","assets/radio-off.png","assets/radio-on.png","assets/radio-pressed.png","assets/row-pressed.9.png","assets/row.9.png","assets/settings.png","assets/check.png","assets/check-pressed.png","assets/flag-china.png","assets/flag-russia.png","assets/flag-usa.png","assets/flag-france.png","assets/flag-italy.svg","assets/keyboard.png"].map(name=>['/i18n/'+name,['panel/i18n/'+name,name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'application/json; charset=utf-8']]),
  ...smartisanAssets(),
  ...animationAssets,
]);
export const PANEL_ASSET_ROUTES = Object.freeze([...assets.keys()]);
export const PANEL_API_ROUTES=Object.freeze(['/ui/preferences','/state','/learning/state','/learning/host','/learning/settings','/devices/refresh','/learning/run','/search','/preview','/controls/settings','/controls/action','/controls/shortcut-capture','/wallpaper','/wallpaper-media','/controls/preview','/controls/audio-devices','/controls/weather','/controls/tts',...new Set([...COMPANION_GET,...COMPANION_POST].map(x=>'/companion/'+x)),...LIVE2D_ROUTES.map(x=>'/live2d'+x)]);
export const PANEL_GET_ROUTES=Object.freeze(['/state','/learning/state','/wallpaper-media',...COMPANION_GET.map(x=>'/companion/'+x),...LIVE2D_GET_ROUTES.map(x=>'/live2d'+x)]);
export function panelBodyLimit(route) {
  if (route === '/wallpaper') return WALLPAPER_BODY_LIMIT;
  if (route.startsWith('/live2d/')) return live2dBodyLimit(route.slice('/live2d'.length));
  if (route.startsWith('/companion/')) return companionBodyLimit(route.slice('/companion/'.length));
  return 8000;
}
const readHistory=file=>{try{const value=readOptional(file);if(value!==null&&(typeof value!=='object'||Array.isArray(value)||value.devices!==undefined&&!Array.isArray(value.devices)))throw Error('记录结构不正确');return value===null?null:{...value,devices:(value.devices??[]).filter(d=>d&&typeof d==='object'&&typeof d.model==='string')};}catch(error){return {stale:true,error:error.message,devices:[]};}};
const INVENTORY_MAX_AGE = 15000;
const readOptional = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('本机记录无法读取，请保留原文件后检查。'); } };
async function probe(url, json = false) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1200) }); return { reachable: true, ...(json ? { value: await response.json() } : {}) }; }
  catch { return { reachable: false }; }
}
export const readSchedule=coordinator=>coordinator.state();
export class PanelService {
  constructor({ stateDir = path.join(root, 'state'), assistant, inventory = deviceInventory, learn, probeImpl = probe, schedule, controls = new ControlService(),learning,wallpapers } = {}) {
    this.stateDir = stateDir; this.assistant = assistant ?? new CommunityAssistant({ stateDir });
    this.inventory = inventory; this.probe = probeImpl;
    this.qqLocator=new AuraBotLocator();
    this.inventoryReadAt = 0;
    this.token = randomBytes(32).toString('hex'); this.recent = [];this.dataId=stateDirectoryId(stateDir);
    try{const recent=readOptional(path.join(stateDir,'panel-recent.json'));if(Array.isArray(recent))this.recent=recent.filter(r=>r&&typeof r.action==='string'&&typeof r.message==='string').slice(0,30);}catch{}
    this.learning=learning??new LearningCoordinator({stateDir,learn:learn??learnCommunity,onComplete:job=>this.log('整理社区',job.status==='completed',job.status==='completed'?`新增 ${job.added} 条，更新 ${job.changed} 条`:job.error??'整理未完成')});
    this.schedule=schedule??(()=>this.learning.state());
    this.controls=controls;this.wallpapers=wallpapers??new WallpaperService({stateDir});
    this.companion=new CompanionService({stateDir,token:this.token});
    this.companion.onBalanceChanged=()=>{if(this.controls.deviceLinkStatus?.().enabled)this.controls.queue('balance-refresh',{clearSource:true});};
    this.live2d=new InternalLive2d({companion:this.companion,stateDir,token:this.token});
    this.companion.live2d=this.live2d;
  }
  log(action, ok, message, ticketId) {
    this.recent.unshift({at:new Date().toISOString(),action,ok,message,...(ticketId?{ticketId}:{})});this.recent=this.recent.slice(0,30);
    try{fs.mkdirSync(this.stateDir,{recursive:true});const file=path.join(this.stateDir,'panel-recent.json'),tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.recent));fs.renameSync(tmp,file);}catch{}
  }
  async state() {
    let knowledge,knowledgeError=null;try{knowledge=this.assistant.store.read();if(this.assistant.store.quarantined)knowledgeError='已隔离 '+this.assistant.store.quarantined+' 条异常社区记录，原文件已保留。';}catch(error){knowledge={observations:{},proposals:{}};knowledgeError=error.message;}
    const companion=(()=>{try{return this.companion.snapshot();}catch(error){return {ok:false,error:error.message};}})(),internal=companion.config?.values?.qq;
    let internalProvider=false;try{internalProvider=readOptional(path.join(this.stateDir,'qq-provider.json'))?.provider==='internal';}catch{}
    const useInternal=!!internal&&(internal.enabled||internalProvider);
    const [voice, legacyQq, ingress, controls] = await Promise.all([this.probe('http://127.0.0.1:18780/status', true), useInternal?null:qqConnection({stateDir:this.stateDir,probe:this.probe,locator:this.qqLocator}), this.probe('http://127.0.0.1:3188/health', true), this.controls.snapshot().catch(error=>({error:error.message}))]);
    const live2d=await this.live2d.snapshot().catch(error=>({error:error.message}));
    const qq=useInternal?{provider:'internal',reachable:this.companion.qq.online,loginVerified:this.companion.qq.loginVerified===true,ready:internal.enabled&&this.companion.qq.loginVerified===true,enabled:internal.enabled,detail:!internal.enabled?'内部 QQ 通道未启用':this.companion.qq.loginVerified?'内部 QQ 通道已连接并核对登录':'内部 QQ 通道：'+this.companion.qq.phase}:legacyQq;
    const records = Object.values(knowledge.observations??{}).filter(v=>v&&typeof v==='object').sort((a, b) => (Date.parse(b.fetchedAt) || 0) - (Date.parse(a.fetchedAt) || 0));
    const recovery=this.controls.recovery?.status?await this.controls.recovery.status():readRecovery(this.stateDir);
    return { wallpapers:this.wallpapers.snapshot(), deploymentVersion:this.versionInfo?.()??null, token: this.token, version:PANEL_VERSION,dataDirectoryId:this.dataId,knowledgeError,recovery,checkedAt: new Date().toISOString(), records,
      proposals: Object.values(knowledge.proposals??{}).filter(v=>v&&typeof v==='object').sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0, 20),
      inventory: await this.currentInventory(controls.balanceKeyboard?.available ? controls.balanceKeyboard.model : null),
      learning: readHistory(path.join(this.stateDir, 'learning-last-run.json')), schedule: this.schedule(),
      counts: { records: records.length, proposals: Object.keys(knowledge.proposals).length,
        fresh: records.filter(r => Date.now() - Date.parse(r.fetchedAt) < 4 * 3600000).length },
      connections: { voice: { reachable: voice.reachable, ready: Boolean(voice.value?.ready && voice.value?.streamReady && voice.value?.nativeReady),
        phase: voice.value?.phase ?? null, error: voice.value?.error ?? null,
        asr: voice.value?.asrProvider ?? null, tier: voice.value?.asrModelTier ?? null, tts: voice.value?.ttsProvider ?? null },
        qq, ingress: { reachable: Boolean(ingress.value?.ok) } },
      job: this.job, recent: recentOperations(this.stateDir,this.recent,recovery), controls, companion, live2d, installationAvailable: false };
  }
  cachedInventory() {
    const stored = readHistory(path.join(this.stateDir, 'devices-snapshot.json'));
    const storedAt = Date.parse(stored?.fetchedAt);
    const resultAt = Date.parse(this.inventoryResult?.fetchedAt);
    if (!this.inventoryResult || Number.isFinite(storedAt) && (!Number.isFinite(resultAt) || storedAt > resultAt)) return stored;
    return this.inventoryResult;
  }
  readDevices() {
    if (this.inventoryPending) return this.inventoryPending;
    const task = Promise.resolve().then(() => this.inventory(this.stateDir)).then(result => {
      if (!Array.isArray(result?.devices)) throw Error('设备清单格式不正确');
      return { ...result, ...(this.cachedInventory()?.error?{cacheError:this.cachedInventory().error}:{}), devices: result.devices.filter(d => d && typeof d.model === 'string') };
    }).catch(() => {
      const cached = this.cachedInventory();
      return { ...cached, stale: true, note: 'M HUB 未能实时读取，保留上次记录。', devices: cached?.devices ?? [] };
    }).then(result => {
      this.inventoryResult = result;
      this.inventoryReadAt = Date.now();
      return result;
    }).finally(() => { this.inventoryPending = null; });
    this.inventoryPending = task;
    return task;
  }
  currentInventory(connectedKeyboard) {
    if (this.inventoryPending) return this.inventoryPending;
    const cached = this.cachedInventory(), now = Date.now();
    const normalize = name => String(name ?? '').replace(/\s+/g, '').toLowerCase();
    const missing = connectedKeyboard && !cached?.devices.some(d => d.family === 'keyboard' && normalize(d.model) === normalize(connectedKeyboard));
    const age = now - Date.parse(cached?.fetchedAt);
    if (!missing && !cached?.stale && age >= 0 && age < INVENTORY_MAX_AGE) return cached;
    if (cached && now - this.inventoryReadAt < (missing ? 5000 : INVENTORY_MAX_AGE)) return cached;
    return this.readDevices();
  }
  async refreshDevices() { const result = await this.readDevices(); this.log('刷新设备', !result.stale, result.stale ? 'M HUB 未能实时读取，保留上次记录' : `读取到 ${result.devices.length} 个设备`); return result; }
  get job(){return this.learning.job;}
  get pending(){return this.learning.pending;}
  runLearning(owner=null){return this.learning.run('manual',owner);}
  learningState(){return {token:this.token,version:PANEL_VERSION,dataDirectoryId:this.dataId,schedule:this.learning.state()};}
  async dispose(){this.wallpapers.close();this.live2d.close();this.companion.close();this.controls.syncStartup?.cancel();await this.learning.dispose();}
  async search(args) { const result = await this.assistant.search(args); const source = {'cache-first':'本机资料','cache-fallback':'社区暂不可用，显示历史资料','read-only':'社区读取'}[result.mode]; this.log('查询配置', result.mode !== 'cache-fallback', source ? `找到 ${result.candidates.length} 条候选 · ${source}` : result.note); return result; }
  async preview({ shareCode, device, slot }) {
    textArgument(shareCode, '分享码', 160); textArgument(device, '设备');
    if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new Error('请选择板载 1、2 或 3。');
    const stored = this.assistant.store.read().observations[hash(shareCode)];
    if (!stored) throw new Error('这条分享还未收录，请先查询。');
    const target = readOptional(path.join(this.stateDir, 'devices-snapshot.json'))?.devices?.find(d => d.model === device);
    if (!target) throw new Error('请先刷新设备清单，再选择目标设备。');
    const validFamily = stored.category < 2000 ? target.family === 'keyboard' : stored.category < 3000 ? target.family === 'mouse' : ['headset','speaker'].includes(target.family);
    if (!validFamily) throw new Error('分享类别与目标设备类型不同，请重新选择。');
    const query = { category1: Math.floor(stored.category / 1000), category2: stored.category, shareCode, tag: '', sort: 2, page: 1, size: 8,
      ...(stored.category === 1001 ? { name: [] } : { deviceName: [] }) };
    const response = await this.assistant.client.search(query);
    const item = response.items.map(raw => normalizeShare(raw, { queriedCategory: stored.category, fetchedAt: new Date().toISOString() })).find(x => x?.shareCode === shareCode);
    if (!item) throw new Error('社区未返回这条分享的当前版本，没有生成建议。');
    this.assistant.store.update(state => { state.observations[hash(shareCode)] = item; });
    const proposal = this.assistant.preview({ shareCode, device, slot });
    this.log('生成槽位预览', true, `板载 ${slot + 1} · 仅预览`); return proposal;
  }
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
export function createPanelHandler(service, { nativeTransport = false } = {}) {
  return async request => {
    const url = new URL(request.url), source = request.headers.get('origin');
    const local = ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const native = ['dsh-app:', 'dsh:'].includes(url.protocol) && url.hostname === 'app';
    // Connection authenticates owner-only routes before replacing the URL with
    // this fixed internal authority. It is never accepted by the preview server.
    const internal = nativeTransport && url.origin === 'http://dsh.internal';
    const origin = local ? url.origin : internal ? 'dsh-app://app' : `${url.protocol}//${url.host}`;
    const route = url.pathname.slice(PANEL_PREFIX.length);
    const publicAsset = request.method === 'GET' && assets.has(route);
    if ((!local && !native && !internal) || !publicAsset && (source && source !== origin || ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')))) return json({ error: '仅接受本机管理面板的请求。' }, 403);
    if (!url.pathname.startsWith(PANEL_PREFIX + '/')) return json({ error: '没有这个功能。' }, 404);
    if(!publicAsset&&request.headers.has('x-dafeiyu-data-id')&&request.headers.get('x-dafeiyu-data-id')!==service.dataId)return json({error:'插件和本机后台的数据目录不一致，未执行操作。'},409);
    try {
      if(url.pathname.startsWith(COMPANION_PREFIX+'/'))return await service.companion.handle(request);
      if(url.pathname.startsWith(LIVE2D_PREFIX+'/'))return await service.live2d.handle(request);
      if (request.method === 'GET' && assets.has(route)) {
        const [file, type] = assets.get(route);
        return new Response(fs.readFileSync(path.join(root, file)), { headers: { 'content-type': type, 'cache-control': type==='font/woff2'?'private, max-age=86400':'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" } });
      }
      if(request.method==='GET'&&route==='/wallpaper-media'){const id=url.searchParams.get('id');if(!/^(?:dafeiyu-blue|[a-f0-9]{64})$/.test(id??''))return json({error:'壁纸资源不存在。'},404);return service.wallpapers.media(id,request.headers.get('range'));}
      if(route==='/wallpaper-media')return json({error:'没有这个功能。'},404);
      if (request.method === 'GET' && route === '/state') return json(await service.state());
      if(request.method==='GET'&&route==='/learning/state')return json(service.learningState());
      if (request.method !== 'POST' || !PANEL_API_ROUTES.filter(x=>!['/state','/learning/state'].includes(x)).includes(route)) return json({ error: '没有这个功能。' }, 404);
      const token = request.headers.get('x-mhub-panel-token');
      if (!/^[a-f0-9]{64}$/.test(token ?? '') || !timingSafeEqual(Buffer.from(token), Buffer.from(service.token))) return json({ error: '请刷新面板后重试。' }, 403);
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return json({ error: '请求格式不正确。' }, 415);
      let input = '', length = 0; const decoder = new TextDecoder();
      for await (const chunk of request.body ?? []) { length += chunk.length; if (length > panelBodyLimit(route)) return json({ error: '请求太长。' }, 413); input += decoder.decode(chunk, {stream:true}); }
      input += decoder.decode();
      const args = JSON.parse(input || '{}');
      const allowed = { '/wallpaper':['operation','id','name','data'], '/ui/preferences':['locale'], '/devices/refresh': [], '/learning/run': [], '/learning/host':['action','owner','version'],'/learning/settings':['revision','values'],'/search': ['topic','category','device','fresh'], '/preview': ['shareCode','device','slot'], '/controls/shortcut-capture':['operation','id'],'/controls/settings':['group','revision','values'], '/controls/action':['action'], '/controls/preview':['state','style'], '/controls/audio-devices':['operation','values'],'/controls/weather':['operation','query','id','enabled'],'/controls/tts':['operation','id','profile','revision','apiKey','clearKey','scenes','fallback','text'] }[route];
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k))) return json({ error: '请求包含未知设置。' }, 400);
      if(route==='/ui/preferences')return json(saveUiLanguage(service.stateDir,args.locale));
      if (route === '/devices/refresh') return json(await service.refreshDevices());
      if(route==='/learning/host'){if(!['tick','release'].includes(args.action))return json({error:'没有这个调度动作。'},400);return json(args.action==='tick'?await service.learning.tick(args.owner,args.version):service.learning.release(args.owner));}
      if(route==='/learning/settings')return json(await service.learning.configure(args));
      if (route === '/learning/run') return json(service.runLearning(request.headers.get('x-dafeiyu-host-owner')), 202);
      if (route === '/search') return json(await service.search(args));
      if(route==='/wallpaper')return json(await service.wallpapers.action(args));
      if(route==='/controls/shortcut-capture')return json(await service.controls.shortcutCapture(args));
      if(route==='/controls/settings'){const result=await service.controls.save(args);service.log('保存参数',true,result.message);return json(result);}
      if(route==='/controls/action'){try{const result=await service.controls.action(args.action);service.log('操作已受理 · '+args.action,true,result.message,result.ticketId);return json(result,202);}catch(error){service.log('操作失败 · '+String(args.action??'未知操作'),false,error.message);throw error;}}
      if(route==='/controls/preview')return json(await service.controls.preview(args));
      if(route==='/controls/audio-devices')return json(await service.controls.audioDevices(args.operation,args.values));
      if(route==='/controls/tts')return json(await service.controls.tts.action(args));
      if(route==='/controls/weather')return json(await weatherAction(args));
      return json(await service.preview(args));
    } catch (error) { return json({ error: error.message || '操作未完成，请稍后重试。' }, 400); }
  };
}
