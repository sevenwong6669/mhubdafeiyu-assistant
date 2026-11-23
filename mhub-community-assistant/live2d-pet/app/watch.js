// 陪看（第 4 期）· 主进程半边
//
// 分工和电话一样：
//   渲染页（renderer/watch.js）—— 抓屏、算变化分、攒帧、拼图。它拿得到 video 流和 canvas，
//   主进程两样都没有；而且拼图是纯 canvas 活，放在渲染页不占主进程的循环。
//   主进程（这个文件）—— 读设置、把拼好的图 POST 给 DSH、把开关状态推给渲染页。
//
// 为什么不是每张图都"想"一轮：见 index.mjs 里 /watch 的注释。这里只负责搬运。
//
// 出图节奏的口径和 dsh-see-now 一致（calm 30s / normal 15s / dense 8s）：
// 节奏管的是"最多多久交一次"，画面没变化就一次都不交 —— 静止的屏幕不花 token。

const fs = require('node:fs')
const { encodeWav } = require('./ear')

const PACE_SEC = { calm: 30, normal: 15, dense: 8 }
// mode：auto = 看画面变化、按 pace 交付；active = 不看变化、按随机间隔主动搭话。
// 2026-11-06 晚和模块侧一起从「两个叠加开关」改成「二选一」（先生嫌频率太高）。
const DEFAULTS = { on: false, mode: 'auto', pace: 'normal', listen: true, proactive: false, chatMin: 45, chatMax: 120 }

// 主动搭话的区间：和模块侧同一个口径（20–180 秒）。两边都钳是故意的 ——
// 手改 pet.json 写 5 秒，这里不拦，模块也会抬到 20，面板上就会「显示的值和实际不符」。
const clampSec = (v, d) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return d
  return Math.max(20, Math.min(180, Math.round(n)))
}

function readWatchSettings(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const w = (j && j.watch) || {}
    const pace = PACE_SEC[w.pace] ? w.pace : DEFAULTS.pace
    const lo = clampSec(w.chatMin, DEFAULTS.chatMin)
    const hi = clampSec(w.chatMax, DEFAULTS.chatMax)
    return {
      // 默认**关**：这功能要在后台持续抓屏 + 定期想一轮，不主动开不该跑
      sessionVersion: String(w.sessionVersion || 'legacy'),
      displayId: String(w.displayId || ''),
      on: w.on === true,
      pace,
      paceSec: PACE_SEC[pace],
      // 听声音 = 抓系统回环做台词，和画面是两个可独立关的东西（有人只想看画面）
      listen: w.listen !== false,
      // 驱动方式二选一（口径必须和模块 readWatchCfg 完全一致，否则面板显示的和实际跑的不一样）：
      // 老配置没有 mode，就用 proactive 推断。
      mode: w.mode === 'active' ? 'active'
        : w.mode === 'auto' ? 'auto'
          : (w.proactive === true ? 'active' : 'auto'),
      // 旧字段，留着给「还没升级的渲染页/面板」读
      proactive: (w.mode === 'active') || (w.mode !== 'auto' && w.proactive === true),
      chatMin: Math.min(lo, hi),
      chatMax: Math.max(lo, hi),
    }
  } catch {
    return { ...DEFAULTS, paceSec: PACE_SEC[DEFAULTS.pace] }
  }
}

/**
 * @param {object} o
 * @param {(file:string)=>object} o.readWatch  每 2 秒读一次，面板/右键菜单改完即时生效
 * @param {(path:string, body:object, timeout:number)=>Promise<any>} o.post
 * @param {(ch:string, data:any)=>void} o.send
 * @param {()=>boolean} o.callOn  电话现在通没通：通着就只攒图不叫醒（交给电话那一轮带走）
 * @param {(...a:any)=>void} o.log
 */
function initWatch({ readWatch, post, send, log, callOn, displayId=()=>'' }) {
  let cfg = { ...readWatch(), callOn: !!callOn() }
  let busy = false        // 上一张还在上送：新来的直接丢（陪看宁可丢画面，不要排队看十几秒前的事）
  let drop = 0            // 丢了几张（下次成功时一并报出来，不然"为什么她没反应"查不出来）
  let sheets = 0
  let lastAt = 0
  let capture = {phase:'stopped',lastFrameAt:0}, upload = {}, reporting=false
  const version=()=>String(cfg.sessionVersion||'legacy')
  const report=async()=>{if(reporting)return;reporting=true;try{await post('/ext/live2d/mhub-watch-status',{sessionVersion:version(),capture,upload},3000)}catch{}finally{reporting=false}}
  function onStatus(_event,data){if(String(data?.sessionVersion||'legacy')!==version())return;capture=data;void report()}
  let holds = 0           // 电话期间攒了几次（攒不花钱，只是本地存一张）

  const publicCfg = () => ({
    sessionVersion:version(), displayId:cfg.displayId||displayId(),
    on: cfg.on, mode: cfg.mode, pace: cfg.pace, paceSec: cfg.paceSec, listen: cfg.listen,
    proactive: cfg.proactive, chatMin: cfg.chatMin, chatMax: cfg.chatMax,
    callOn: !!cfg.callOn,
  })

  function sync() {
    const next = readWatch()
    const nowCall = !!callOn()
    const changed=String(next.sessionVersion||'legacy')!==version() || next.displayId!==cfg.displayId
    const turned = next.on !== cfg.on || changed
    const tuned = next.mode !== cfg.mode || next.pace !== cfg.pace || next.listen !== cfg.listen
      || next.proactive !== cfg.proactive || next.chatMin !== cfg.chatMin || next.chatMax !== cfg.chatMax
      || nowCall !== !!cfg.callOn
    cfg = { ...next, callOn: nowCall }
    if (turned) {
      log(`陪看 → ${cfg.on ? '开' : '关'}`)
      busy=false;capture={phase:cfg.on?'preparing':'stopped',lastFrameAt:0};upload={};void report()
      send('watch-config', publicCfg())
      send('watch-ctl', { action: cfg.on ? 'start' : 'stop' })
    } else if (tuned) {
      send('watch-config', publicCfg())
      // 节奏 / 主动搭话 / 电话状态变了都不用重开采集：渲染页每轮都读一次 cfg
    }
  }
  setInterval(sync, 2000)
  setInterval(()=>void report(),5000)

  /** 渲染页拼好一张图后交过来。dataURL → base64 在这一层剥掉（渲染页只管画）。 */
  async function onSheet(_e, d) {
    if(String(d?.sessionVersion||'legacy')!==version())return {ok:false,cancelled:true,message:'旧陪看会话'}
    if (!cfg.on) return { ok: false, message: '陪看没开' }
    const url = String((d && d.sheet) || '')
    const textOnly = Boolean(d && d.textOnly) || !url
    const comma = url.indexOf(',')
    if (!textOnly && comma < 0) return { ok: false, message: '没有图' }
    if (busy) {
      drop++
      return { ok: false, message: '上一张还在路上', busy: true }
    }
    // 电话通着：只把最新一张存到模块，不叫醒她 —— 等主人说完这一句，电话那一轮把图一起带走。
    // 这不是省 token 的优化，是防冲突：两条链路各叫醒一次，两句回复会抢着往桌宠投。
    const hold = !!cfg.callOn
    busy = true
    const t0 = Date.now(), sessionVersion=version()
    try {
      const body = {
        sessionVersion, capturedAt:Number(d.capturedAt)||t0, displayId:cfg.displayId||displayId(),
        tiles: Array.isArray(d.tiles) ? d.tiles : [],
        spanSec: Number(d.spanSec) || 0,
        level: Number(d.level) || 0,
        quiet: Boolean(d.quiet),
        textOnly,
        active: Boolean(d.active),
        hold,
      }
      if (!textOnly) {
        body.sheet = url.slice(comma + 1)
        body.mediaType = 'image/jpeg'
      }
      const r = await post('/ext/live2d/watch', body, 180000)
      if(sessionVersion!==version()||!cfg.on)return {ok:false,cancelled:true}
      upload={at:Date.now(),ok:r?.ok===true,requestId:r?.requestId||'',withImage:r?.withImage===true,
        held:r?.held===true,visionUnsupported:r?.visionUnsupported===true,stage:r?.stage||'submit',message:r?.message||''}
      void report()
      if (hold) {
        holds++
        if (r && r.ok && (holds === 1 || holds % 10 === 0)) {
          log(`陪看：电话中，图先存着（第 ${holds} 次），等你说完一句再一起带过去`)
        }
        return r || { ok: true }
      }
      sheets++
      lastAt = Date.now()
      const ms = lastAt - t0
      if (r && r.ok) {
        log(r.textOnly
          ? `陪看：主动搭话已交（${ms}ms，没带图），等她想`
          : `陪看：第 ${sheets} 张已交（${ms}ms${r.withImage ? '，带图' : '，没写图'}），等她想`)
      } else log(`陪看：第 ${sheets} 张没投出去（${ms}ms）：${(r && r.message) || ''}`)
      if (drop) { log(`陪看：此前丢了 ${drop} 张（上送还没回来）`); drop = 0 }
      return r || { ok: true }
    } catch (e) {
      if(sessionVersion===version()){upload={at:Date.now(),ok:false,stage:'submit',message:String(e?.message||e).slice(0,200)};void report()}
      log('陪看：上送失败', String((e && e.message) || e))
      return { ok: false, message: String((e && e.message) || e) }
    } finally {
      if(sessionVersion===version())busy = false
    }
  }

  const poke = () => sync()
  const on = () => cfg.on
  let lines = 0          // 收到了几句台词（第 4b 期）
  let lastLineAt = 0

  /**
   * 一段系统声音（视频里在说的话）→ 转成一句台词存到模块那边。
   * 这里只负责编码 + 上送；识别和"哪句配哪张图"都在模块侧做，
   * 这样桌宠就算重开也不会丢台词（台词是模块内存里的，重开就丢，可接受）。
   */
  async function onLine(_e, d) {
    if(d?.sessionVersion!==version())return {ok:false,cancelled:true}
    if (!cfg.on || !cfg.listen) return { ok: false, message: '没在听' }
    const pcm = d && d.pcm
    if (!pcm || !pcm.length) return { ok: false, message: '没有音频' }
    const ms = Number(d.ms) || 0
    if (ms < 600) return { ok: false, message: '太短' }
    try {
      const wav = encodeWav(pcm, 16000)
      const r = await post('/ext/live2d/watch-line', { wav: Buffer.from(wav).toString('base64'), ms,sessionVersion:version() }, 60000)
      if (r && r.heard) {
        lines++
        lastLineAt = Date.now()
        log(`陪看·台词识别完成（${r.sttMs || 0}ms）`)
      }
      return r || { ok: true }
    } catch (e) {
      log('陪看·台词上送失败', String((e && e.message) || e))
      return { ok: false, message: String((e && e.message) || e) }
    }
  }

  send('watch-config', publicCfg())
  return { onStatus, onSheet, onLine, publicCfg, isOn: on, poke, stats: () => ({ on: cfg.on, capture, upload, sheets, lastAt, drop, lines, lastLineAt, holds }) }
}

module.exports = { initWatch, readWatchSettings, PACE_SEC }
