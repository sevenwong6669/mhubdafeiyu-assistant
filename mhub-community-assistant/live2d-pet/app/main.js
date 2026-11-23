// 迈从大肥鱼内置完整 Live2D 桌宠 —— Electron 主进程。
// 完整保留作者渲染与动作实现，配置和资源仅来自本项目私有状态目录。
//
// 职责：
//   · 本地静态服务（127.0.0.1 随机端口）伺服 renderer + 模型 + 贴图（绕开 file:// 限制）
//   · 透明无边框置顶窗口 + 托盘退出 + 鼠标穿透（forward 模式，命中检测在渲染页做）
//   · 长轮询内置 Live2D 服务 /events：proactive → 气泡 + 语音（音频字节经 IPC 喂渲染页，主进程拉取免 CORS）
//   · focus → 收气泡；work/behavior/pack → 先只记日志（M2 再接 <body> 动作协议）
const { app, BrowserWindow, Menu, Tray, ipcMain, screen, session, desktopCapturer, globalShortcut } = require('electron')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
// 耳朵（按住说话）：按键监听 + 音频上送。单独一个文件，坏了也不影响桌宠本体。
const { initEar, readEarSettings } = require('./ear')
const { initCall, readCallSettings } = require('./call')
const { initWake, readWakeSettings } = require('./wake')
const { initWatch, readWatchSettings } = require('./watch')
const { captureScreen } = require('./shot')
const { selectDisplay, selectSource } = require('./display-selection')
const { CallVisibility, speechWakesPet } = require('./voice-visibility.cjs')
const { petPermissionOrigin } = require('./media-permissions.cjs')
const { CaptureSettings } = require('./capture-settings.cjs')

const { sourceRoot, stateRoot, assetsRoot, settingsFile: PET_SETTINGS, hostFile, readDesktop, readAudioConfig, createResourceResolver } = require('./resources.cjs')
const ROOT = assetsRoot
const HOST_CANDIDATES = [hostFile]
fs.mkdirSync(stateRoot, {recursive:true})
fs.mkdirSync(assetsRoot, {recursive:true})
const PROCESS_FILE = path.join(stateRoot, 'pet-process.json')
const PROCESS_STARTED_AT = Date.now()

const POLL_WAIT_MS = 25_000
const FETCH_TIMEOUT_MS = 40_000
const MHUB_TTS_TIMEOUT_MS = 125_000 // backend owns a 120s synthesis budget
const speechDeliveries = new Map()
let captionTail = Promise.resolve()
// Polling remains alive during synthesis; only one paid synthesis runs at a
// time and a burst replaces the single waiting reply instead of queuing old speech.
class ProactiveQueue {
  constructor(deliver,onError=()=>{}) { this.deliver=deliver;this.onError=onError;this.pending=[];this.running=null;this.epoch=0 }
  enqueue(event,host) { this.pending.splice(0,this.pending.length,{event,host,epoch:this.epoch});this.pump() }
  clear() { this.epoch++;this.pending=[] }
  pump() {
    if(this.running||!this.pending.length)return
    const item=this.pending.shift(),current=()=>item.epoch===this.epoch
    const task=Promise.resolve().then(()=>current()?this.deliver(item.event,item.host,current):null).catch(this.onError).finally(()=>{if(this.running===task)this.running=null;this.pump()})
    this.running=task
  }
}

const validPlaybackEvents = new Set(['start','end','cancel','error','text-only'])
function rememberSpeech(payload, current) {
  const row = {payload, current, reported:false, createdAt:Date.now()}
  speechDeliveries.set(payload.speechId, row)
  for (const [id, item] of speechDeliveries) {
    if (speechDeliveries.size <= 64 && Date.now() - item.createdAt < 300000) break
    speechDeliveries.delete(id)
  }
  return row
}
function playbackReceipt(data) {
  if (!data || !validPlaybackEvents.has(data.event)) return null
  const row=speechDeliveries.get(data.speechId)
  if (!row || !row.current()) return null
  const p=row.payload
  return {row, event:{speechId:p.speechId, event:data.event, phoneOwner:p.phoneOwner, text:p.text,
    watchVersion:p.watchVersion, watchRequestId:p.watchRequestId,
    audioMs:Math.max(0,Math.min(180000,Number(data.audioMs)||0)),
    startedAt:Number.isFinite(data.startedAt)?data.startedAt:Date.now(),
    stage:data.stage || (data.event==='error'?'playback':undefined), message:String(data.message||'').slice(0,180)}}
}

// 窗宽决定取景：窗口越宽，同样「装下整幅内容宽度」所需的距离越近，脸就越大。
// 380=全身(脸小)、480=到小腿、560=到大腿、640=到裙摆、720=标准上半身(脸约 380 的 1.9 倍)。
// 取景距离由渲染页按内容包围盒反算，改这里不用再动别的常量。PET_W=560 可临时覆盖。
const WIN_W = Number(process.env.PET_W) || 720, WIN_H = 780

// 独立 userData：与旧 pet-app 的单实例锁互不冲突；
// 调试档（PET_PROFILE=debug）还要和常驻实例分开，否则 requestSingleInstanceLock 直接把它 quit 掉。
const PROFILE = process.env.PET_PROFILE || ''
app.setPath('userData', path.join(stateRoot, PROFILE ? 'electron-' + PROFILE.replace(/[^a-z0-9_-]/gi,'_') : 'electron'))
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') // 桌宠语音无手势也要能播

const VISIBILITY_SETTINGS = path.join(app.getPath('userData'), 'visibility.json')
let win = null
let tray = null
let manuallyHidden = false, fullscreen = process.platform === 'win32' ? null : false
let autoHideFullscreen = true
let windowReady = false, fullscreenProbe = null, lastWakeAt = Date.now()
const captureSettings=new CaptureSettings({file:path.join(stateRoot,'capture-stop.json'),post:apiPostJson,
  onStop:key=>send(key+'-ctl',{action:'stop'}),
  onChange:key=>{(key==='call'?call:watch)?.poke();updateTray()},onError:message=>{try{log(message)}catch{}}})
let fullscreenRetry = null, fullscreenFallback = null, quitting = false
let serverPort = 0
let cursor = null
let bootId = ''
let clientId = 'live2d-' + Math.random().toString(16).slice(2, 10)
let pollState = { ok: false, lastPollAt: 0, lastError: '', events: 0, online: false }
// 换衣模式：面板画在渲染页里，这里只记住开关状态供菜单打勾。
// 渲染页自己关（点面板的「完成」）时会回传 dress-state，两侧始终是同一个值。
let dressOn = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// stdout 可能已经断了（启动命令接了 `| head`、管道另一端退出、被 IDE 收回），
// 这时 console.log 会抛 EPIPE。在主进程里那是未捕获异常 → 弹「A JavaScript error
// occurred in the main process」对话框，把桌宠整个卡住。日志永远不该有这种权力：
// 兜住它，写不出去就丢掉这条日志。
//
// 除了 stdout 还写一份 pet.log（项目根）：从面板 /launch 起的实例是 detached spawn，
// 根本没有终端接着它，出问题时一行日志都看不到。1MB 轮转一份。
const LOG_FILE = path.join(stateRoot, 'pet.log')
try {
  if (fs.statSync(LOG_FILE).size > 1024 * 1024) {
    try { fs.unlinkSync(LOG_FILE + '.1') } catch { /* 上一份轮转文件不存在 */ }
    fs.renameSync(LOG_FILE, LOG_FILE + '.1')
  }
} catch { /* 日志文件还不存在 */ }
const log = (...a) => {
  const line = new Date().toTimeString().slice(0, 8) + ' ' + a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })())).join(' ')
  try { console.log('[live2d-pet]', ...a) } catch { /* stdout 已断，静默丢弃 */ }
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch { /* 磁盘写不了就算了 */ }
}
// 兜底：Electron/Node 内部也可能自己往 stdout 写（EPIPE 从非本函数栈抛上来时命中这里）。
// 桌面宠物不该因为一次杂音弹模态框挡住桌面，所以不弹窗，改记到 crash.log 供事后排查。
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || /broken pipe/i.test(String(err.message || '')))) return
  const line = `[${new Date().toISOString()}] ${err && err.stack ? err.stack : String(err)}\n\n`
  try { fs.appendFileSync(path.join(stateRoot, 'crash.log'), line) } catch { /* 连文件都写不了就放弃 */ }
  try { console.error('[live2d-pet] 未捕获异常:', err) } catch { /* 无处可写 */ }
})

function readHost() {
  for (const f of HOST_CANDIDATES) {
    try {
      const h = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (!/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(String(h.baseUrl || ''))) continue
      if (!/^[a-f0-9]{32,80}$/.test(String(h.token || ''))) continue
      if (h.api !== '/api/mhub-community/live2d') continue
      return { baseUrl: String(h.baseUrl).replace(/\/+$/, ''), token: h.token, api: h.api }
    } catch { /* 下一个候选 */ }
  }
  return null
}
async function apiGet(pathname, query) {
  const host = readHost()
  if (!host) return null
  const url = `${host.baseUrl}${host.api}${pathname}${query ? '?' + new URLSearchParams(query) : ''}`
  const res = await fetch(url, { headers: { 'x-pet-token': host.token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}
function apiPost(pathname, body) {
  const host = readHost()
  if (!host) return
  fetch(`${host.baseUrl}${host.api}${pathname}`, {
    method: 'POST',
    headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).catch(() => {})
}
// 同上，但要等结果：耳朵上送音频后得知道「她听到了什么」，否则出错只能靠猜。
async function apiPostJson(pathname, body, timeoutMs = 120000) {
  const host = readHost()
  if (!host) throw new Error('迈从大肥鱼后台尚未就绪')
  const res = await fetch(`${host.baseUrl}${host.api}${pathname}`, {
    method: 'POST', redirect: 'error',
    headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 120))
  let result
  try { result = JSON.parse(text) } catch { throw Error('桌宠后台返回了无效 JSON，请检查后台状态。') }
  if(result?.ok===false)throw Error(result.message || result.error || '桌宠设置未完成。')
  return result
}

// ---------- 模型描述文件（分发包能跑起来的关键一步） ----------
// 作者原版的 大肥鱼.model3.json 里只声明了 moc/贴图/物理/参数表，没有声明 Exp3/ 下的
// 23 个表情，也没有 Animation/ 下的 8 条动作。pixi-live2d-display 只认描述文件里写过的东西，
// 所以拿原版直接加载的结果是「人出来了，但没有表情可用」。
// 我们另外生成一份 <名字>.pet.model3.json：补 Expressions / Motions，并把 Groups 换成
// VTS 风格的单项 —— 原版的 EyeBlink / LipSync 两个组必须去掉，否则库会自动随机眨眼、
// 按音频做口型，跟渲染页自己的眨眼和表情打架。
//
// 生成条件：同目录已有 <名字>.model3.json、且 <名字>.pet.model3.json 还不存在。
// 已存在就一个字都不动（本机这份是手工调过的，不能被覆盖）。
function ensureModelDescriptor() {
  const modelRoot = path.join(ROOT, 'model')
  if (!fs.existsSync(modelRoot)) return
  const bases = []
  ;(function walk(d, depth) {
    if (depth > 4) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && /\.model3\.json$/i.test(e.name) && !/\.pet\.model3\.json$/i.test(e.name)) bases.push(p)
    }
  })(modelRoot, 0)

  for (const src of bases) {
    const dst = src.replace(/\.model3\.json$/i, '.pet.model3.json')
    if (fs.existsSync(dst)) continue
    try {
      const j = JSON.parse(fs.readFileSync(src, 'utf8'))
      const dir = path.dirname(src)
      const fr = j.FileReferences || (j.FileReferences = {})
      const list = (sub, re) => {
        try { return fs.readdirSync(path.join(dir, sub)).filter((n) => re.test(n)).sort() } catch { return [] }
      }
      const exps = list('Exp3', /\.exp3\.json$/i)
      // 表情名 = 文件名去掉后缀。动作库、faces.json 里的名字都按这个约定写的，不能改。
      if (exps.length) fr.Expressions = exps.map((n) => ({ Name: n.replace(/\.exp3\.json$/i, ''), File: 'Exp3/' + n }))
      const mots = list('Animation', /\.motion3\.json$/i)
      if (mots.length) {
        fr.Motions = {
          Motion: mots.map((n) => ({ File: 'Animation/' + n, Sound: null, FadeInTime: 0.5, FadeOutTime: 0.5 })),
        }
      }
      j.Groups = [{ Id: 'Motion', Name: '动作' }]
      fs.writeFileSync(dst, JSON.stringify(j, null, 2))
      log('已生成模型描述文件 ' + path.basename(dst) + '（表情 ' + exps.length + ' 条 / 动作 ' + mots.length + ' 条）')
    } catch (e) {
      // 生不出来也不能挡启动：窗口照开，只是没有表情，日志里能看出原因
      log('生成模型描述文件失败（不影响桌宠本体）：' + src + ' —— ' + String((e && e.message) || e))
    }
  }
}

// ---------- 本地静态服务（只绑 127.0.0.1，根 = 项目目录） ----------
const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
}
function startServer() {
  const resolveResource = createResourceResolver()
  return new Promise((resolve,reject) => {
    const srv = http.createServer((req, res) => {
      if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{'allow':'GET, HEAD'});return res.end()}
      const resource = resolveResource(req.url)
      if(!resource){res.writeHead(404);return res.end()}
      const finish = (err,buf) => {
        if(err){res.writeHead(404);return res.end()}
        res.writeHead(200,{'content-type':resource.type||MIME[path.extname(resource.file).toLowerCase()]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'})
        res.end(req.method==='HEAD'?undefined:buf)
      }
      if(resource.body)finish(null,resource.body)
      else fs.readFile(resource.file,finish)
    })
    srv.once('error',reject)
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port))
    app.once('will-quit',()=>srv.close())
  })
}

// ---------- 窗口 ----------
function createWindow() {
  const display = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = display.workArea
  win = new BrowserWindow({
    show: false,
    width: WIN_W, height: WIN_H,
    x: sw - WIN_W - 24, y: sh - WIN_H,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, // 后台也要跑口型/音频
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.once('ready-to-show', () => {
    windowReady = true
    applyVisibility()
  })
  win.loadURL(`http://127.0.0.1:${serverPort}/app/renderer/index.html`)
  // 面板设置（模型大小 / 外观）必须在页面加载完之后补推一次：
  // watchPetSettings 的 2 秒轮询会在渲染页还没准备好时就把值推出去，
  // 那一次 IPC 落在空气里，渲染页一直用默认值 —— 表现就是「每次重启模型都大 5%」
  // （pet.json 的 scale 是 0.95，渲染页却按 1.0 画）。这里重置比较基准再推一次。
  win.webContents.on('did-finish-load', () => {
    lastZoom = null
    lastLook = ''
    pushSettings()
    log('页面已加载，补推面板设置')
  })
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  win.on('closed', () => { win = null; stopCursorPoll() })
  startCursorPoll()
}

// ---------- 全局光标轮询 ----------
// 渲染页只能收到窗口内（380×780）的 mousemove，鼠标一移出窗口注视就冻住——
// 这是「鼠标离远一点就不跟了」的根因。改由主进程 30fps 读系统光标位置，
// 换算成相对窗口左上角的坐标推给渲染页，鼠标在屏幕任何角落都能被追踪。
// 只在坐标变化时发送，鼠标静止时零 IPC 开销。
let cursorTimer = null
let lastCursor = { x: -99999, y: -99999 }
function startCursorPoll() {
  stopCursorPoll()
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    try {
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const x = p.x - b.x, y = p.y - b.y
      if (x === lastCursor.x && y === lastCursor.y) return
      lastCursor = { x, y }
      win.webContents.send('cursor', { x, y, sx: p.x, sy: p.y })
    } catch {}
  }, 33) // ~30fps，渲染端还有指数平滑，感觉不到台阶
}
function stopCursorPoll() {
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null }
  lastCursor = { x: -99999, y: -99999 }
}

// 电话 / 陪看开关的「真相源」是 pet.json 的 call.on / watch.on —— 面板、右键菜单、排障口
// 改的都是这一个字段。菜单里直接写它，然后 poke 一下对应模块立刻同步，不用等 2 秒轮询
// （点了没反应会让人以为点错，再点一次又变回原样）。
function featureIsOn(key) {
  if(captureSettings.blocked(key))return false
  const mod = key === 'call' ? call : watch
  if (mod && typeof mod.isOn === 'function') return !!mod.isOn()
  try {
    const f = JSON.parse(fs.readFileSync(PET_SETTINGS, 'utf8'))
    return (f[key] || {}).on === true
  } catch { return false }
}
async function setFeatureOn(key, on) {
  return captureSettings.set(key,!!on)
}

async function selectWatchDisplay(displayId) {
  try {
    await apiPostJson('/ext/live2d/watch-config',{displayId:String(displayId)},8000)
    watch?.poke()
    return true
  } catch(error) { log('显示器选择失败：',error.message);return false }
  finally { updateTray() }
}

async function saveAutoHidePreference(next) {
  try {
    const saved=await apiPostJson('/ext/live2d/desktop-config',{},8000)
    const result=await apiPostJson('/ext/live2d/desktop-config',{values:{autoHideFullscreen:next===true},revision:saved.revision},8000)
    autoHideFullscreen=result.values.autoHideFullscreen
    applyVisibility()
    log('全屏时自动隐藏 →',autoHideFullscreen?'开':'关')
    return true
  } catch(error) { log('全屏自动隐藏设置保存失败：',error.message);return false }
  finally { updateTray() }
}

function buildMenu() {
  const onAir = featureIsOn('call')
  const watching = featureIsOn('watch')
  return Menu.buildFromTemplate([
    { label: '隐藏桌宠', click: () => setManualHidden(true) },
    autoHideMenuItem(),
    { label: '上半身 / 全身切换', click: () => send('toggle-view', {}) },
    {
      // 她默认是半身取景，裙子下摆和鞋子本来就在画外 —— 换衣模式顺手切全身，
      // 不然点了半天什么也看不见。关掉时渲染页会自己切回原来的视图。
      label: dressOn ? '换衣模式：开着（点此收起）' : '换衣模式（看她换衣服）',
      type: 'checkbox',
      checked: dressOn,
      click: (item) => {
        dressOn = !!item.checked
        send('dress-mode', { on: dressOn })
        log('换衣模式（右键菜单）→', dressOn ? '开' : '关')
      },
    },
    { label: '口型测试（本地音频）', click: () => send('test-mouth', {}) },
    { label: '隐藏气泡', click: () => send('hide-bubble', {}) },
    { type: 'separator' },
    // 勾选态 = 现在通着 / 现在看着。这两个都是常驻占资源的（麦克风 / 抓屏），
    // 必须能从看得见的地方一键关掉 —— 面板在浏览器里，右键在桌面上。
    {
      label: captureSettings.blocked('call')?'电话：本地已停止，等待后台保存':onAir ? '电话：通话中（点此挂断）' : '电话：未接通（点此接听）',
      type: 'checkbox',
      checked: onAir,
      click: (item) => { setFeatureOn('call', !!item.checked) },
    },
    {
      label: captureSettings.blocked('watch')?'陪看：本地已停止，等待后台保存':watching ? '陪看：已请求开启（点此停下）' : '陪看：没在看（点此开始）',
      type: 'checkbox',
      checked: watching,
      click: (item) => { setFeatureOn('watch', !!item.checked) },
    },
    {label:'陪看显示器',submenu:screen.getAllDisplays().map((display,i)=>({
      label:`显示器 ${i+1} · ${display.label || display.id} · ${display.size.width}×${display.size.height}`,
      type:'radio',checked:String(readWatchSettings(PET_SETTINGS).displayId||screen.getPrimaryDisplay().id)===String(display.id),
      click:()=>{void selectWatchDisplay(display.id)}
    }))},
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } },
  ])
}
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data) }

function applyVisibility() {
  if (!windowReady || !win || win.isDestroyed()) return
  if (manuallyHidden || (autoHideFullscreen && fullscreen !== false)) {
    if (win.isVisible()) win.hide()
  } else if (!win.isVisible()) win.showInactive()
}

const callVisibility=new CallVisibility({hidden:()=>manuallyHidden,wake:()=>wakePet(),hide:()=>setManualHidden(true,false)})
function setManualHidden(hidden,manual=true) {
  if(manual)callVisibility.manual()
  manuallyHidden = hidden
  updateTray()
  applyVisibility()
}

function wakePet() {
  if (autoHideFullscreen && fullscreen !== false) return
  if (manuallyHidden) setManualHidden(false,false)
  else applyVisibility()
}

function autoHideMenuItem() {
  return { label: '全屏时自动隐藏', type: 'checkbox', checked: autoHideFullscreen,
    enabled: process.platform === 'win32', click: item => {void saveAutoHidePreference(item.checked===true)} }
}

function allowVisibilityIfProbeStalls() {
  fullscreenFallback ??= setTimeout(() => {
    fullscreenFallback = null
    fullscreen = false
    applyVisibility()
  }, 3000).unref()
}

function startFullscreenProbe() {
  if (process.platform !== 'win32' || quitting) return
  allowVisibilityIfProbeStalls()
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'fullscreen.ps1'), '-ParentId', String(process.pid),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  fullscreenProbe = child
  let last = null, samples = 0
  createInterface({ input: child.stdout }).on('line', line => {
    if (fullscreenProbe !== child) return
    const value = line.trim()
    if (value !== '0' && value !== '1') return
    const active = value === '1'
    samples = last === active ? samples + 1 : 1
    last = active
    if (samples < (active ? 2 : 3)) return
    clearTimeout(fullscreenFallback)
    fullscreenFallback = null
    if (fullscreen === active) return
    fullscreen = active
    applyVisibility()
  })
  const disconnected = () => {
    if (quitting || fullscreenProbe !== child) return
    fullscreenProbe = null
    allowVisibilityIfProbeStalls()
    fullscreenRetry = setTimeout(startFullscreenProbe, 1500).unref()
  }
  child.on('error', disconnected)
  child.on('exit', disconnected)
}

function updateTray() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: manuallyHidden ? '显示桌宠' : '隐藏桌宠', click: () => setManualHidden(!manuallyHidden) },
    autoHideMenuItem(),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
}

async function createTray() {
  try {
    const img = await app.getFileIcon(process.execPath, { size: 'small' })
    if (img.isEmpty()) return
    tray = new Tray(img)
    tray.setToolTip('大肥鱼 Live2D 桌宠')
    updateTray()
  } catch (e) { log('托盘创建失败（不影响使用）：', e.message) }
}

// ---------- 长轮询主循环（契约与旧 pet-app 一致） ----------
async function fetchAudio(absUrl) {
  try {
    const res = await fetch(absUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch { return null }
}

async function publishCaption(host, text, audioMs = 0, playback = {}) {
  try {
    const res = await fetch('http://127.0.0.1:18780/live2d/caption', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { 'content-type': 'application/json', 'x-pet-token': host.token },
      body: JSON.stringify({ text, audioMs, role:'assistant', ...playback }),
    })
    if (!res.ok) throw Error('HTTP ' + res.status)
  } catch (error) { log('迈从字幕投递失败：', error.message) }
}

const proactiveQueue = new ProactiveQueue((e,host,current)=>handleProactive(e,host,current),error=>log('语音事件处理失败：',String(error.message).slice(0,180)))
function callReplyCurrent(owner,manualCall) {
  if(!owner&&!manualCall)return true
  const cfg=captureSettings.mask('call',readCallSettings(PET_SETTINGS))
  return cfg.on&&(!owner||cfg.owner===owner)
}
function watchReplyCurrent(version) {
  if(!version)return true
  const cfg=captureSettings.mask('watch',readWatchSettings(PET_SETTINGS))
  return cfg.on&&cfg.sessionVersion===version
}
async function handleDisplayCapture(req,cb) {
  try {
    if(!featureIsOn('watch')){cb({});return}
    const version=readWatchSettings(PET_SETTINGS).sessionVersion
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:8,height:8}})
    if(!featureIsOn('watch')||readWatchSettings(PET_SETTINGS).sessionVersion!==version){cb({});return}
    const selected=watchDisplay(),source=selectSource(sources||[],selected)
    captureSourceError=null
    log('陪看采集源',JSON.stringify({displayId:String(selected.id),width:selected.size.width,height:selected.size.height,scale:selected.scaleFactor,audio:req.audioRequested,sources:sources.length}))
    cb({video:source,...(req.audioRequested?{audio:'loopback'}:{})})
  }catch(error){
    captureSourceError={stage:'source-selection',name:error.name,message:error.message}
    watch?.onStatus(null,{sessionVersion:readWatchSettings(PET_SETTINGS).sessionVersion,phase:'failed',lastFrameAt:0,error:captureSourceError})
    log('陪看：抓屏请求没接上',JSON.stringify({name:error.name,stage:'source-selection'}));cb({})
  }
}
async function handleProactive(e, host, valid=()=>true) {
  const purpose = String(e.purpose || '')
  const phoneOwner = /^电话:([a-f0-9-]{36})$/.exec(purpose)?.[1]
  const watchToken=/^L2W([vt]):([a-f0-9]{32})$/.exec(purpose)
  let receipt=null
  if(watchToken){
    const id=watchToken[2].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5')
    try{receipt=await apiPostJson('/ext/live2d/mhub-watch-speech',{requestId:id},3000)}catch{return}
    if(!receipt?.valid)return
  }
  const dialogue = watchToken ? [purpose,watchToken[1]==='v'?'voice':'text','陪看'] : /^Live2D:(voice|text):(.+)$/.exec(purpose)
  if(dialogue?.[2]?.startsWith('陪看@'))return // discard legacy truncated envelopes
  const watchVersion=receipt?.sessionVersion,watchRequestId=receipt?.requestId
  const watchCurrent=()=>watchReplyCurrent(watchVersion)
  const currentCall=()=>valid()&&callReplyCurrent(phoneOwner,dialogue?.[2]==='电话'||purpose==='电话')
  if (!currentCall() || !watchCurrent()) return
  const payload = {
    text: String(e.text || ''),
    speechId: require('node:crypto').randomUUID(), phoneOwner,
    mood: String(e.mood || 'neutral'),
    watchVersion,watchRequestId,
    tag: watchVersion ? '陪看' : phoneOwner ? '电话' : dialogue?.[2] || purpose || '主动来找你',
    audio: null, durationMs: 0,
    anim: String(e.anim || ''), playbackId: String(e.playbackId || ''),
    // 面板「动作库」点播：只演动作，不弹气泡也不出声。
    // 理由很实际——气泡正好盖在她脸上，预览就看不见形体了。
    preview: String(e.purpose || '') === '预览',
    // 面板「复位」：把身体收回初始状态（收动作/手型/表情/姿势/思考态），不弹气泡不出声。
    reset: String(e.purpose || '') === '复位',
  }
  if (!payload.reset && !payload.preview) rememberSpeech(payload,()=>currentCall()&&watchCurrent())
  if (phoneOwner || dialogue?.[1] === 'voice') {
    const abort = new AbortController()
    const validityTimer=setInterval(()=>{if(!currentCall()||!watchCurrent())abort.abort(Error('语音所属通话或陪看已结束'))},250)
    try {
      const response = await fetch('http://127.0.0.1:18780/tts/' + (phoneOwner ? 'live2d-call' : 'live2d'), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([abort.signal,AbortSignal.timeout(MHUB_TTS_TIMEOUT_MS)]),
        headers: { 'content-type': 'application/json', 'x-pet-token': host.token },
        body: JSON.stringify({ id: phoneOwner, text: payload.text, speechId:payload.speechId }),
      })
      if (!response.ok || response.headers.get('content-type') !== 'audio/wav') throw Error('语音未就绪')
      payload.audio = new Uint8Array(await response.arrayBuffer())
      payload.durationMs = Number(response.headers.get('x-audio-duration-ms')) || 0
    } catch (error) { payload.synthesisError=String(error.message).slice(0,180); if(watchVersion)void apiPostJson('/ext/live2d/mhub-watch-status',{sessionVersion:watchVersion,speech:{requestId:watchRequestId,stage:'synthesis',ok:false,message:payload.synthesisError}},3000).catch(()=>{}); log('Live2D BreezeBlue 合成失败：', error.message) }
    finally { clearInterval(validityTimer) }
  } else if (e.audio && e.audio.url) {
    const abs = e.audio.url.startsWith('http') ? e.audio.url : host.baseUrl + e.audio.url
    const buf = await fetchAudio(abs)
    if (buf) { payload.audio = buf; payload.durationMs = Number(e.audio.durationMs) || 0 }
  }
  if (!currentCall() || !watchCurrent()) { speechDeliveries.delete(payload.speechId); return }
  if (speechWakesPet({preview:payload.preview,phoneOwner,purpose})) {
    if(phoneOwner||purpose==='电话')callVisibility.sync(true)
    else wakePet()
  }
  send('speak', payload)
  if (phoneOwner && payload.audio) log('电话 BreezeBlue 音频已送播放器：', payload.durationMs + 'ms')
  if (payload.playbackId) apiPost('/playback', { playbackId: payload.playbackId, anim: payload.anim, status: 'played' })
  // 复位和预览都不弹气泡，日志也分开写，免得排查时以为她真说了句话
  if (payload.reset) log('复位：身体收回初始状态')
  else if (payload.preview) log('预览动作：', payload.anim || '(空)')
  else if(watchVersion)log('陪看回复已送达渲染器',JSON.stringify({requestId:watchRequestId,speechId:payload.speechId,audio:!!payload.audio,durationMs:payload.durationMs}))
  else log('气泡' + (payload.audio ? '+语音' : '') + '：', payload.text.slice(0, 40), '｜anim=' + (payload.anim || '(空)'))
}

async function pollLoop() {
  let attempt = 0
  while (!quitting) {
    const host = readHost()
    if (!host) { pollState.lastError = 'host.json 未就绪'; await sleep(5000); continue }
    try {
      const url = `${host.baseUrl}${host.api}/events?${new URLSearchParams({ ...(cursor != null ? { since: String(cursor) } : {}), wait: String(POLL_WAIT_MS / 1000), client: clientId })}`
      const res = await fetch(url, { headers: { 'x-pet-token': host.token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      attempt = 0
      const firstBoot = bootId && data.bootId !== bootId
      bootId = data.bootId
      cursor = data.cursor
      pollState = { ok: true, lastPollAt: Date.now(), lastError: '', events: pollState.events, online: true, bootId, cursor }
      if (firstBoot) { cursor = null; proactiveQueue.clear() } // old jobs belong to the previous host boot
      for (const e of data.events || []) {
        pollState.events++
        if (e.type === 'control' || e.type === 'visibility') { handleControl(e); continue }
        if (e.type === 'proactive' && String(e.text || '').trim() && !firstBoot) proactiveQueue.enqueue(e, host)
        else if (e.type === 'focus') { if(e.enabled===true)proactiveQueue.clear();send('focus', { enabled: e.enabled === true }); log('focus:', e.enabled) }
        else if (e.type === 'behavior' && e.say && !firstBoot) {
          void publishCaption(host, String(e.say))
          send('speak', { text: String(e.say), mood: 'neutral', tag: '行为动作', audio: null, durationMs: 0 })
          if (e.playbackId) apiPost('/playback', { playbackId: e.playbackId, anim: String(e.action || ''), status: 'played' })
          log('behavior 台词：', String(e.say).slice(0, 40))
        }
        // DSH 宿主的工作状态（thinking / working / result / waiting / success / error）：
        // 状态一变就下发一条，这里转给渲染页做「思考态」。state 为 null = 那边翻页了，收工。
        else if (e.type === 'work') {
          send('think', { state: String(e.state || ''), label: String(e.label || '') })
          log('work →', e.label || '(idle)')
        }
        else if (e.type === 'pack') log('pack 事件（Live2D 不吃 webm 包，忽略）')
      }
      await sleep(50)
    } catch (err) {
      attempt++
      pollState = { ...pollState, ok: false, online: false, lastError: String(err.message || err) }
      await sleep(Math.min(15_000, 1500 + attempt * 1500))
    }
  }
}

function handleControl(event) {
  if (typeof event.autoHideFullscreen === 'boolean') {
    autoHideFullscreen=event.autoHideFullscreen
    applyVisibility();updateTray()
  }
  if(event.action==='show')wakePet()
  else if(event.action==='hide')setManualHidden(true)
  else if(event.action==='quit'){proactiveQueue.clear();send('focus',{enabled:true});app.quit()}
  else if(event.action==='expression' && event.name)send('expression',{name:String(event.name)})
}
function syncDesktopSettings() {
  captureSettings.retryPending()
  const desktop=readDesktop()
  const value=desktop.autoHideFullscreen ?? desktop.autoHide
  if(typeof value==='boolean' && value!==autoHideFullscreen){autoHideFullscreen=value;applyVisibility();updateTray()}
}
function writeProcessState() {
  try {
    let startedAt,identityVerified=false
    try{const previous=JSON.parse(fs.readFileSync(PROCESS_FILE,'utf8'));if(previous.pid===process.pid&&Number.isFinite(previous.startedAt)){startedAt=previous.startedAt;identityVerified=previous.identityVerified===true}}catch{}
    const temp=PROCESS_FILE+'.'+process.pid+'.tmp'
    fs.writeFileSync(temp,JSON.stringify({pid:process.pid,at:Date.now(),startedAt,identityVerified,bootedAt:PROCESS_STARTED_AT,sourcePetDir:sourceRoot,appFile:__filename,version:require('../package.json').version,visible:!!win?.isVisible(),manuallyHidden,autoHideFullscreen,fullscreen,poll:pollState}))
    fs.renameSync(temp,PROCESS_FILE)
  }catch{}
}
// ---------- IPC ----------
// 移动用 setBounds 锁死宽高：透明无边框窗在 125% 缩放下 setPosition 每次会漂移 ~1px 尺寸，
// 长按微动会累积成「桌宠缓慢放大」。setBounds 原子设定位置+尺寸，杜绝漂移。
ipcMain.on('move', (_e, x, y) => {
  if (win) try { win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H }) } catch {}
})
ipcMain.on('set-hit', (_e, hit) => { if (win) try { win.setIgnoreMouseEvents(!hit, { forward: true }) } catch {} })
ipcMain.on('menu', () => { if (win) buildMenu().popup({ window: win }) })
ipcMain.on('dress-state', (_e, on) => { dressOn = !!on })
ipcMain.on('mhub-playback', (event, data) => {
  if(event.sender !== win?.webContents) return
  const receipt=playbackReceipt(data)
  if(!receipt)return
  const {row,event:playback}=receipt
  if(playback.watchVersion)void apiPostJson('/ext/live2d/mhub-watch-status',{sessionVersion:playback.watchVersion,speech:{requestId:playback.watchRequestId,stage:playback.stage||'playback',event:playback.event,speechId:playback.speechId,ok:playback.event!=='error',message:playback.message}},3000).catch(()=>{})
  if(playback.phoneOwner&&!row.reported&&['start','text-only','error'].includes(playback.event)){
    row.reported=true
    void apiPostJson('/ext/live2d/mhub-native-call',{id:playback.phoneOwner,action:'speech',text:playback.text,audioMs:playback.event==='start'?playback.audioMs:0},3000).catch(error=>log('电话语音状态回报失败：',error.message))
  }
  const host=readHost()
  if(host) captionTail=captionTail.catch(()=>{}).then(()=>row.current()?publishCaption(host,playback.text,playback.audioMs,playback):null)
  if(['end','cancel','text-only'].includes(playback.event))speechDeliveries.delete(playback.speechId)
})
ipcMain.on('log', (_e, ...a) => log('[renderer]', ...a))
ipcMain.handle('screen-info', () => {
  if (!win) return null
  const [x, y] = win.getPosition()
  return { x, y }
})
ipcMain.handle('poll-state', () => pollState)
ipcMain.handle('audio-config',()=>readAudioConfig())

// 耳朵：渲染页采完音（Float32 16k）交到这里编码成 WAV 再上送。
// 放在主进程做编码，是为了让渲染页只管采、出问题也好只查一处。
let ear = null
ipcMain.handle('ear-audio', (e, d) => {
  return ear ? ear.onAudio(e, d) : { ok: false, message: '耳朵未启用' }
})
ipcMain.handle('ear-config', () => (ear ? ear.publicCfg() : null))

// 电话（第 3 期）：一直开着麦，渲染页断好句回传 PCM，这里编码上送。
let call = null
ipcMain.handle('call-audio', (e, d) => (call ? call.onAudio(e, d) : { ok: false, message: '电话未启用' }))
ipcMain.handle('call-config', () => (call ? call.publicCfg() : null))
ipcMain.on('call-status', (event, status) => {
  if (event.sender !== win?.webContents) return
  call?.report(status)
  if (status?.owner && status.phase === 'connected' && call?.publicCfg().owner === status.owner) callVisibility.sync(true)
})

// 唤醒词（第 5 期）：渲染页一直开着麦，每 128ms 推一帧 16k PCM 过来做关键词识别。
// 走 on 不走 handle —— 每秒 8 帧，每次都要回执会把主进程事件循环堵住。
let wake = null
ipcMain.on('wake-pcm', (_e, pcm) => { if (wake && pcm) wake.feed(pcm) })
ipcMain.handle('wake-config', () => (wake ? wake.publicCfg() : null))

// 陪看（第 4 期）：抓屏筛帧全在渲染页做（它才有 video 流和 canvas），
// 这里只管把拼好的图 POST 给 DSH，以及告诉渲染页"桌宠自己占哪块"。
let watch = null
let captureDisplay=null, captureSourceError=null
function watchDisplay(){
  const cfg=readWatchSettings(PET_SETTINGS)
  if(captureDisplay?.version!==cfg.sessionVersion)captureDisplay={version:cfg.sessionVersion,id:String(selectDisplay(screen,cfg.displayId).id)}
  return selectDisplay(screen,captureDisplay.id)
}
ipcMain.handle('watch-snapshot',async(e,data)=>{
  const cfg=readWatchSettings(PET_SETTINGS)
    if(e.sender!==win?.webContents||!featureIsOn('watch')||data?.sessionVersion!==cfg.sessionVersion)return {ok:false,cancelled:true}
  try{
    const frame=await captureScreen(String(watchDisplay().id))
    const next=readWatchSettings(PET_SETTINGS)
    if(!next.on||next.sessionVersion!==cfg.sessionVersion)return {ok:false,cancelled:true}
    if(frame?.error||!frame?.base64)return {ok:false,name:frame?.name,message:frame?.error||'单帧采集没有取得画面'}
    return {ok:true,...frame}
  }catch(error){return {ok:false,name:error.name,message:error.message}}
})
ipcMain.on('watch-status',(e,d)=>{if(e.sender!==win?.webContents)return;if(captureSourceError&&d?.error?.name==='NotAllowedError')d={...d,error:captureSourceError};watch?.onStatus(e,d)})
ipcMain.handle('watch-sheet', (e, d) => (watch ? watch.onSheet(e, d) : { ok: false, message: '陪看未启用' }))
ipcMain.handle('watch-line', (e, d) => (watch ? watch.onLine(e, d) : { ok: false, message: '陪看未启用' }))
ipcMain.handle('watch-config', () => (watch ? watch.publicCfg() : null))
ipcMain.handle('watch-mask', () => {
  try {
    const d = watchDisplay()
    const b = win && !win.isDestroyed() && win.isVisible() ? win.getBounds() : { x: 0, y: 0, width: 0, height: 0 }
    return {
      rect: { x: b.x-d.bounds.x, y: b.y-d.bounds.y, w: b.width, h: b.height },
      screen: { w: d.bounds.width, h: d.bounds.height },
      scale: d.scaleFactor || 1,
    }
  } catch { return null }
})

// 她在聊天里用 <body:,钢盆> 这类标签切外观时，渲染页会把新值发到这里落盘，
// 免得 2 秒后轮询又把旧值推回去。和面板走同一个文件，一个真相源。
async function saveLookPatch(patch) {
  try {
    const result=await apiPostJson('/ext/live2d/look',patch,8000)
    lastLook=lookCanon(result.look)
    return result
  } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
}
ipcMain.handle('set-look', (event, patch) => {
  if(event.sender!==win?.webContents)return {ok:false,message:'仅接受本桌宠的外观修改。'}
  return saveLookPatch(patch)
})

// ---------- 面板「模型大小 / 外观」（DSH live2d 模块写的 pet.json，这里只读） ----------
// PET_SETTINGS belongs to this plugin; no external plugin is needed.
let lastZoom = 1
let lastLook = ''
let lastFore = ''
const FORE_KINDS = ['none', 'planter', 'snack', 'dinner']
// 外观字段按固定顺序归一化，免得 JSON 键序抖动导致每 2 秒重发一次
// Clothes4（鞋子）必须在这个列表里：漏了它的话，别处改了鞋，轮询比不出差异就永远不推。
const LOOK_KEYS = ['key10', 'key11', 'key12', 'Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5']
// 五个 Clothes 都是 0~1 的连续参数（换衣面板的滑块会写中间值），压到 2 位小数
// 再比较：滑块 100 档正好一位不丢，浮点误差也不会触发重发。
// 道具类（钢盆 / 两副眼镜）仍是开关，塌成 0/1。
const LOOK_CONT = { Clothes1: 1, Clothes2: 1, Clothes3: 1, Clothes4: 1, Clothes5: 1 }
function lookCanon(look) {
  return JSON.stringify(
    LOOK_KEYS.map((k) => {
      if (typeof look[k] !== 'number') return null
      if (LOOK_CONT[k]) return Math.round(Math.min(1, Math.max(0, look[k])) * 100) / 100
      return look[k] ? 1 : 0
    })
  )
}
// 读一次 pet.json 并推给渲染页。启动时也要主动调一次 —— 见 did-finish-load 的注释。
function pushSettings () {
  try {
    const s = JSON.parse(fs.readFileSync(PET_SETTINGS, 'utf8'))
    const z = Number(s.scale)
    if (z >= 0.4 && z <= 2.5) { lastZoom = z; send('zoom', z) }
    if (s.look && typeof s.look === 'object') { lastLook = lookCanon(s.look); send('look', s.look) }
    lastFore = foreCanon(s.fore); send('fore', lastFore)
  } catch { /* 文件还没有或不合法：保持现状 */ }
}
function foreCanon(v) { return FORE_KINDS.indexOf(v) >= 0 ? v : 'none' }
function watchPetSettings() {
  setInterval(() => {
    try {
      const s = JSON.parse(fs.readFileSync(PET_SETTINGS, 'utf8'))
      const z = Number(s.scale)
      if (z >= 0.4 && z <= 2.5 && z !== lastZoom) { lastZoom = z; send('zoom', z); log('模型大小 →', z) }
      if (s.look && typeof s.look === 'object') {
        const canon = lookCanon(s.look)
        if (canon !== lastLook) { lastLook = canon; send('look', s.look); log('外观 →', canon) }
      }
      const f = foreCanon(s.fore)
      if (f !== lastFore) { lastFore = f; send('fore', f); log('前景 →', f) }
    } catch { /* 文件还没有或不合法：保持现状 */ }
    syncDesktopSettings()
  }, 2000)
}

// ---------- 启动 ----------
app.whenReady().then(async () => {
  try {
    const visibility=JSON.parse(fs.readFileSync(VISIBILITY_SETTINGS, 'utf8'))
    autoHideFullscreen = visibility.autoHideFullscreen !== false
    manuallyHidden = visibility.startHidden === true
  } catch (error) {
    if (error.code !== 'ENOENT') log('全屏自动隐藏设置无法读取：', error.message)
  }
  syncDesktopSettings()
  writeProcessState()
  // 麦克风权限：桌宠页面是自己伺服的本机网页，不需要弹系统授权框。
  // 只放行采音相关的三种，其余一律拒——这个窗口只用来画她，不该能开摄像头之类。
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      const own=wc===win?.webContents
      const audio=readEarSettings(PET_SETTINGS).on || featureIsOn('call') || readWakeSettings(PET_SETTINGS).on
      const display=featureIsOn('watch')
      const types=details?.mediaTypes || []
      cb(own && ((permission==='display-capture' && display) || permission==='speaker-selection' || (['media','microphone','audioCapture'].includes(permission) && audio && !types.includes('video'))))
    })
  } catch (e) { log('权限处理器设置失败：', String((e && e.message) || e)) }
  // A granted check exposes device labels without opening a temporary default microphone.
  const permissionDenials=new Map()
  session.defaultSession.setPermissionCheckHandler((wc,permission,origin,details)=>{
    const own=wc===win?.webContents,source=petPermissionOrigin(origin,serverPort)
    const audio=readEarSettings(PET_SETTINGS).on || featureIsOn('call') || readWakeSettings(PET_SETTINGS).on
    const allowed=own&&source.matched&&(permission==='speaker-selection'||permission==='media'&&details?.mediaType!=='video'&&audio||permission==='display-capture'&&featureIsOn('watch'))
    if(!allowed){
      const meta={permission:String(permission).slice(0,80),own,origin:source.origin,originMatched:source.matched,mediaType:details?.mediaType,audioEnabled:audio}
      const key=JSON.stringify(meta),now=Date.now()
      if(now-(permissionDenials.get(key)||0)>10000){permissionDenials.set(key,now);while(permissionDenials.size>32)permissionDenials.delete(permissionDenials.keys().next().value);log('权限检查拒绝',key)}
    }
    return allowed
  })
  // 陪看要抓屏：Electron 里 getDisplayMedia 必须由主进程指定「给哪块屏」，
  // 否则渲染页拿到的请求没人接，直接报 NotAllowedError。
  // 不弹系统选择器（桌宠没有能让人选的 UI）：固定第一块屏 + 系统回环音频。
  try {
    session.defaultSession.setDisplayMediaRequestHandler(handleDisplayCapture,{useSystemPicker:false})
  } catch (e) { log('抓屏处理器设置失败（陪看会不可用）：', String((e && e.message) || e)) }
  // 起服务之前先把模型描述文件备好：渲染页第一件事就是按 .pet.model3.json 的路径去要模型，
  // 文件不在会 404，窗口一片空白。生成失败也继续往下走（日志里有原因）。
  ensureModelDescriptor()
  serverPort = await startServer()
  log('静态服务端口', serverPort)
  createWindow()
  void createTray()
  startFullscreenProbe()
  if (!globalShortcut.register('CommandOrControl+Alt+Shift+L', () => setManualHidden(!manuallyHidden))) {
    log('桌宠显隐快捷键未注册，请使用托盘菜单')
  }
  setInterval(() => {
    callVisibility.sync(!!call?.isOn())
    writeProcessState()
    try {fs.writeFileSync(path.join(app.getPath('userData'),'visibility-status.json'),JSON.stringify({pid:process.pid,at:Date.now(),visible:!!win?.isVisible(),manuallyHidden,call:!!call?.isOn(),callOwned:callVisibility.active,fullscreen,autoHideFullscreen}))}catch{}
    try {
      const at = Number(fs.readFileSync(path.join(stateRoot, 'mhub-visibility-wake.txt'), 'utf8'))
      if (at > lastWakeAt && at <= Date.now()) {
        lastWakeAt = at
        if (Date.now() - at < 3000) wakePet()
      }
    } catch {}
  }, 400).unref()
  watchPetSettings()
  // 耳朵在窗口建好之后再挂：它推 ear-config 时渲染页得已经在。
  // 失败（被杀软拦 / 没装 uiohook）只记一行，绝不向上抛 —— 桌宠本体不该因为耳朵报废。
  // 电话要先于耳朵初始化：耳朵的「让路」判断要读电话开关状态
  try {
    call = initCall({
      readCall: () => captureSettings.mask('call',readCallSettings(PET_SETTINGS)),
      post: apiPostJson,
      send,
      log,
    })
  } catch (e) {
    log('电话初始化失败（其他功能不受影响）：', String((e && e.message) || e))
  }
  try {
    ear = initEar({
      readEar: () => readEarSettings(PET_SETTINGS),
      post: apiPostJson,
      send,
      capture: () => captureScreen(String(watchDisplay().id)),
      isBusy: () => !!(call && call.isOn()),
      log,
    })
  } catch (e) {
    log('耳朵初始化失败（按住说话不可用，其他功能不受影响）：', String((e && e.message) || e))
  }
  // 唤醒词：必须晚于耳朵 —— 叫醒之后录的那一句是走 ear-audio 上送的。
  // 引擎载入失败（模型缺了、dll 被杀软拦）只降级成「叫不醒」，本体照跑。
  try {
    wake = initWake({
      readWake: () => readWakeSettings(PET_SETTINGS),
      send,
      log,
    })
  } catch (e) {
    log('唤醒初始化失败（叫不醒她，其他功能不受影响）：', String((e && e.message) || e))
  }
  // 陪看放最后：它只依赖抓屏和上送，和耳朵/电话互不影响；挂了也只丢一行日志
  try {
    watch = initWatch({
      displayId:()=>captureDisplay?.id||String(screen.getPrimaryDisplay().id),
      readWatch: () => captureSettings.mask('watch',readWatchSettings(PET_SETTINGS)),
      post: apiPostJson,
      send,
      // 电话通着时陪看只攒图不叫醒 —— 两条链路各叫醒一次就会连说两句
      callOn: () => featureIsOn('call'),
      log,
    })
  } catch (e) {
    log('陪看初始化失败（其他功能不受影响）：', String((e && e.message) || e))
  }
  pollLoop()
})
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  quitting = true
  clearTimeout(fullscreenRetry)
  clearTimeout(fullscreenFallback)
  fullscreenProbe?.kill()
  globalShortcut.unregisterAll()
  try{if(JSON.parse(fs.readFileSync(PROCESS_FILE,'utf8')).pid===process.pid)fs.unlinkSync(PROCESS_FILE)}catch{}
})
