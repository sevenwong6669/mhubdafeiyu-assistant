// 耳朵：按住说话（第 1 期）
//
// 职责边界很清楚 —— 这个文件**只做两件**事：
//   1. 全局按键：按住说键（默认 F1）/ 按住说图键（默认 F2）的按下与松开
//   2. 把渲染页采好的音频送到 live2d 模块的 /ear 口（识别 + 她想答案在那边做）
//
// 为什么按键放在主进程：Electron 的 globalShortcut 只给「按下」，拿不到「松开」，
// 而按住说话的生命周期就是按下→松开。uiohook-napi 是 N-API 预编译，Electron 45 直接可用
// （2026-11-06 实测：keydown/keyup 都拿到，按住时长可精确到毫秒）。
//
// 不挂键盘钩子的方案（GetAsyncKeyState 轮询）是旧鱼搭子的做法，80ms 一轮、鼠标侧键会抖；
// 这里用真钩子 + 按住集合去重，抖动问题天然不存在。

const fs = require('node:fs')
const {readAudioConfig}=require('./resources.cjs')
const { watchFunctionKeyRelease } = require('./ear-key-release')

// 键码用 uiohook 的 keycode（不是 Windows VK）：F1=59 F2=60。
// 旧鱼搭子配置里存的是 VK（112/113），换到这边要换算 —— 也正因为如此，
// 面板上直接让人选键，别让他记数字。
const DEFAULT_KEYS = { say: 59, sayShot: 60 }

function readEarSettings(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const e = (j && j.ear) || {}
    return {
      on: e.on === true,
      say: Number.isInteger(e.say) && e.say > 0 ? e.say : DEFAULT_KEYS.say,
      sayShot: Number.isInteger(e.sayShot) && e.sayShot > 0 ? e.sayShot : DEFAULT_KEYS.sayShot,
      mic: typeof e.mic === 'string' ? e.mic : '',
      inputName: e.mic ? '' : readAudioConfig().inputName,
      minMs: Number(e.minMs) > 0 ? Number(e.minMs) : 300, // 太短当误触
    }
  } catch {
    return { on: false, ...DEFAULT_KEYS, mic: '', inputName:readAudioConfig().inputName,minMs: 300 }
  }
}

/**
 * @param {object} o
 * @param {(file:string)=>object} o.readEar  读设置（每 2 秒刷新一次，改键即时生效）
 * @param {(path:string, body:object, timeout:number)=>Promise<any>} o.post  POST 到 DSH
 * @param {(ch:string, data:any)=>void} o.send  推给渲染页
 * @param {()=>Promise<null|{base64:string,mediaType:string,w:number,h:number}>} o.capture  截当前屏（第 2 期）
 * @param {()=>boolean} o.isBusy  电话是不是正占着麦克风（第 3 期：通话中按住说话让路）
 * @param {(...a:any)=>void} o.log
 */
function initEar({ readEar, post, send, capture, isBusy, log }) {
  let cfg = readEar()
  let hook = null
  let releaseWatch = null
  const held = new Set()
  let recording = null
  let turn = 0
  let captureTimer = null
  let pendingShot = null // Promise：按下 F2 的那一刻就开始截，松手时再取
  let lastResultAt = 0

  // ---- 设置热刷新：面板改完键不用重启桌宠 ----
  setInterval(() => {
    const next = readEar()
    const changed = next.on !== cfg.on || next.say !== cfg.say || next.sayShot !== cfg.sayShot || next.mic !== cfg.mic || next.inputName !== cfg.inputName
    cfg = next
    if (changed) {
      cancelRecording()
      log('耳朵设置 →', JSON.stringify({ on: cfg.on, say: cfg.say, sayShot: cfg.sayShot, mic: cfg.mic ? '(已选)' : '(默认)' }))
      send('ear-config', publicCfg())
      if (!cfg.on) teardown()
      else if (!hook) setup()
    }
  }, 2000)

  const publicCfg = () => ({ on: cfg.on, say: cfg.say, sayShot: cfg.sayShot, mic: cfg.mic, inputName:cfg.inputName,minMs: cfg.minMs })

  function onKeyDown({ keycode: key }) {
    if (!cfg.on || (key !== cfg.say && key !== cfg.sayShot) || held.has(key)) return
    held.add(key)
    log(`耳朵：收到按下（keycode=${key}）`)
    begin(key)
  }

  function onKeyUp({ keycode: key }) {
    held.delete(key)
    if (recording?.key === key) end('键盘钩子')
  }

  function setup() {
    if (hook) return
    let uio
    try {
      uio = require('uiohook-napi')
    } catch (e) {
      log('耳朵：按键监听加载失败（按住说话不可用，其他功能不受影响）：', e.message)
      return
    }
    const { uIOhook, UiohookKey } = uio
    try {
      uIOhook.on('keydown', onKeyDown)
      uIOhook.on('keyup', onKeyUp)
      uIOhook.start()
      hook = uIOhook
      try {
        releaseWatch = watchFunctionKeyRelease((id) => {
          if (recording?.id !== id) return
          held.delete(recording.key)
          end('Windows 键状态')
        }, log)
      } catch (e) {
        log('耳朵：Windows 松键检测无法启动', e.message)
      }
      log(`耳朵已就绪：按住 ${keyName(cfg.say, UiohookKey)} 说话、${keyName(cfg.sayShot, UiohookKey)} 说话带图`)
    } catch (e) {
      uIOhook.off('keydown', onKeyDown)
      uIOhook.off('keyup', onKeyUp)
      teardown()
      log('耳朵：全局键盘钩子挂不上（可能被杀软拦）：', e.message)
    }
  }

  function teardown() {
    if (!hook) return
    try { hook.stop() } catch {}
    hook.off('keydown', onKeyDown)
    hook.off('keyup', onKeyUp)
    hook = null
    releaseWatch?.close()
    releaseWatch = null
    held.clear()
    cancelRecording()
    log('耳朵已停用')
  }

  function begin(key) {
    if (recording) return // 两个键同时按：先按的那个说了算
    // 电话接通时麦克风归电话：这里两套采集同时抢同一只麦只会互相削音，
    // 而且电话本来就不用按键 —— 直接让路，不弹任何提示。
    if (typeof isBusy === 'function' && isBusy()) {
      log('耳朵：电话通话中，按住说话暂时让路')
      return
    }
    const withShot = key === cfg.sayShot
    recording = { key, withShot, startedAt: Date.now(), id: ++turn }
    // 截图在**按下的瞬间**就开跑：他按 F2 时屏幕正是他要给她看的那个样子，
    // 等松手再截，中间几秒他可能已经切窗口了。异步跑，不挡采音。
    pendingShot = withShot && typeof capture === 'function'
      ? Promise.resolve().then(capture).catch((e) => ({ error: String((e && e.message) || e) }))
      : null
    send('ptt', { action: 'start', withShot })
    releaseWatch?.arm(key, recording.id)
    captureTimer = setTimeout(() => {
      cancelRecording()
      send('ear-state', { ok: false, message: '按住说话超时，录音已停止' })
      log('耳朵：等待松键超时，已停止采音')
    }, 60000)
  }

  function cancelRecording() {
    if (!recording) return
    clearTimeout(captureTimer)
    recording = null
    pendingShot = null
    send('ptt', { action: 'cancel' })
  }

  function end(source) {
    if (!recording) return
    const ms = Date.now() - recording.startedAt
    const withShot = recording.withShot
    clearTimeout(captureTimer)
    recording = null
    log(`耳朵：收到松开（${source}，${ms}ms）`)
    // 短按当误触：200ms 以下基本是手滑（旧鱼搭子没有这道闸，结果 F1 一碰就发一句空话）
    if (ms < cfg.minMs) { send('ptt', { action: 'cancel' }); pendingShot = null; return }
    send('ptt', { action: 'stop', withShot, ms })
  }

  // ---- 渲染页采好的音频 ----
  // pcm 是 Float32Array（16k 单声道），编码成 WAV 由主进程做：
  // 放主进程的好处是渲染页只负责采，编码出错不会污染她的播放链路。
  async function onAudio(_e, d) {
    const pcm = d && d.pcm
    if (!pcm || !pcm.length) { send('ear-state', { ok: false, message: '没录到声音' }); return { ok: false } }
    const ms = Number(d.ms) || 0
    const wav = encodeWav(pcm, Number(d.sampleRate) || 16000)
    send('ear-state', { ok: true, listening: false, uploaded: true })
    log(`耳朵：上送 ${(wav.length / 1024).toFixed(0)}KB / ${(ms / 1000).toFixed(1)}s`)
    // 眼睛：截图在按下 F2 的那一刻就已经开跑了，这里只是等它落地（多数时候早就好了）。
    // 截不到不算失败 —— 大不了这一轮只靠她听到的话。
    let shot = null
    if (d.withShot) {
      const s = (pendingShot ? await pendingShot : null) || d.shot || null
      pendingShot = null
      if (s && s.base64) {
        shot = { base64: s.base64, mediaType: s.mediaType || 'image/jpeg', w: s.w, h: s.h }
        log(`眼睛：截到 ${s.w}×${s.h}，${Math.round(s.base64.length / 1024)}KB`)
      } else {
        log('眼睛：截屏没成功', (s && s.error) || '（没有返回图像）')
      }
    }
    const t0 = Date.now()
    try {
      const r = await post('/ext/live2d/ear', {
        wav: Buffer.from(wav).toString('base64'),
        ms,
        withShot: Boolean(d.withShot),
        shot,
      }, 120000)
      lastResultAt = Date.now()
      log(`耳朵：识别+思考用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, r && r.heard ? `听到「${String(r.heard).slice(0, 30)}」` : '')
      return r
    } catch (e) {
      log('耳朵：上送失败', String((e && e.message) || e))
      send('ear-state', { ok: false, message: String((e && e.message) || e) })
      return { ok: false }
    }
  }

  if (cfg.on) setup()
  send('ear-config', publicCfg())
  return { onAudio, publicCfg, stats: () => ({ recording, lastResultAt }) }
}

// ---- WAV 编码：16k 单声道 PCM16 ----
function encodeWav(f32, sampleRate) {
  const n = f32.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)          // fmt 块长
  buf.writeUInt16LE(1, 20)           // PCM
  buf.writeUInt16LE(1, 22)           // 单声道
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)           // blockAlign
  buf.writeUInt16LE(16, 34)          // 位深
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2)
  }
  return buf
}

function keyName(code, UiohookKey) {
  if (!UiohookKey) return String(code)
  for (const [k, v] of Object.entries(UiohookKey)) if (v === code) return k
  return '键码 ' + code
}

module.exports = { initEar, encodeWav, readEarSettings, DEFAULT_KEYS }
