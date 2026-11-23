// 电话（第 3 期）：一直开着麦克风，自己断句，一句一句送过去。
//
// 分工：
//   渲染页（renderer/call.js）—— 采音 + 能量 VAD 断句 + 插话（她出声时检测到人声就把她掐掉）；
//   主进程（这个文件）—— 收切好的句子、编码 WAV、串行上送、把开关状态推给渲染页。
// 断句为什么不在主进程：主进程没有麦克风，PCM 只存在于渲染页的音频回调里。
// 上送为什么不在渲染页：编码 + 排队 + 失败重试都更适合放在没有 UI 线程压力的一侧。
//
// 和「耳朵」的关系：电话开着时耳朵让路（同一只麦克风，两套采集同时跑只会互相打架）。

const fs = require('node:fs')
const {readAudioConfig}=require('./resources.cjs')
const { encodeWav } = require('./ear')

const DEFAULTS = { on: false, mic: '', thr: 0.006, minMs: 400, maxSec: 12 }

function readCallSettings(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const c = (j && j.call) || {}
    return {
      // 默认**关**：这是常驻占麦克风的功能，只有明确打开才开
      on: c.on === true,
      owner: typeof c.mhubOwner === 'string' ? c.mhubOwner : '',
      muted: c.muted === true,
      silenceMs: Number(c.mhubSilenceMs) || null,
      mic: typeof c.mic === 'string' ? c.mic : '',
      inputName: c.mic ? '' : readAudioConfig().inputName,
      thr: Number(c.thr) > 0 ? Number(c.thr) : DEFAULTS.thr,
      minMs: Number(c.minMs) > 0 ? Number(c.minMs) : DEFAULTS.minMs,
      maxSec: Number(c.maxSec) > 0 ? Number(c.maxSec) : DEFAULTS.maxSec,
    }
  } catch {
    return { ...DEFAULTS,inputName:readAudioConfig().inputName }
  }
}

/**
 * @param {object} o
 * @param {(file:string)=>object} o.readCall  每 2 秒读一次，面板改完即时生效
 * @param {(path:string, body:object, timeout:number)=>Promise<any>} o.post
 * @param {(ch:string, data:any)=>void} o.send
 * @param {(...a:any)=>void} o.log
 */
function initCall({ readCall, post, send, log }) {
  let cfg = readCall()
  let lastLogAt = 0
  let total = 0

  const publicCfg = () => ({ ...cfg })

  function report({owner, phase, error} = {}) {
    if (!owner || owner !== cfg.owner || !['connected','ended','failed'].includes(phase)) return
    void post('/ext/live2d/mhub-native-call', {id: owner, action: 'report', phase, error}, 3000)
      .catch(e => log('电话状态回报失败：', e.message))
  }

  // 把 pet.json 的 call 设置同步到「正在跑的这条通路」。
  // 抽成函数是为了能让右键菜单立刻触发（poke），不用等下面那个 2 秒轮询
  // —— 点完菜单要 2 秒才有反应，会让人以为点错了又点一次。
  function sync() {
    const next = readCall()
    const turned = next.on !== cfg.on
    const ownerChanged = next.owner !== cfg.owner
    const muteChanged = next.muted !== cfg.muted
    const micChanged = next.mic !== cfg.mic || next.inputName !== cfg.inputName
    const tuningChanged = next.thr !== cfg.thr || next.minMs !== cfg.minMs || next.maxSec !== cfg.maxSec
    cfg = next
    if (turned || ownerChanged) {
      log(`电话 → ${cfg.on ? '接通' : '挂断'}（设置变更）`)
      send('call-config', publicCfg())
      send('call-ctl', { action: cfg.on ? 'start' : 'stop' })
    } else if (micChanged || tuningChanged || muteChanged) {
      send('call-config', publicCfg())
      // 换麦克风必须重开流，否则还在用旧设备
      if (micChanged && cfg.on) {
        log('电话：换麦克风，重开通路')
        send('call-ctl', { action: 'stop' })
        setTimeout(() => send('call-ctl', { action: 'start' }), 350)
      }
    }
  }
  setInterval(sync, 500)

  async function onAudio(_e, d) {
    const pcm = d && d.pcm
    if (!pcm || !pcm.length) return { ok: false, message: '没有音频' }
    if (!cfg.on || cfg.muted || (cfg.owner || '') !== (d.owner || '')) return { ok: false, message: '电话未开启收音' }
    const ms = Number(d.ms) || 0
    const wav = encodeWav(pcm, 16000)
    // 排查口：默认留一份「最后一句」的录音（覆盖同一个文件，永远只占几百 KB）。
    // 「电话里全是没听清」这类问题的第一现场是音频本身 —— 光看日志猜不出来。
    // 不想留就设环境变量 PET_CALL_DUMP=0。
    if (!cfg.owner && process.env.PET_CALL_DUMP === '1') {
      try {
        const dir = require('node:path').join(require('./resources.cjs').stateRoot, 'diagnostics')
        require('node:fs').mkdirSync(dir, { recursive: true })
        require('node:fs').writeFileSync(require('node:path').join(dir, 'last-call.wav'), wav)
      } catch {}
    }
    total++
    // 只记前几句 + 每 10 句一条：一次通话几十句，全打日志会把有用的东西淹掉
    if (total <= 3 || total % 10 === 0) {
      log(`电话：第 ${total} 句（${(ms / 1000).toFixed(1)}s / ${(wav.length / 1024).toFixed(0)}KB）`)
    }
    const t0 = Date.now()
    try {
      const r = await post('/ext/live2d/call', { wav: Buffer.from(wav).toString('base64'), ms, mhubOwner: d.owner || '' }, 60000)
      const dt = Date.now() - t0
      if (r && r.heard) log(`电话：听到「${String(r.heard).slice(0, 40)}」（${dt}ms）`)
      else if (r && r.message) log(`电话：${r.message}（${dt}ms）`)
      lastLogAt = Date.now()
      return r
    } catch (e) {
      log('电话：上送失败', String((e && e.message) || e))
      return { ok: false }
    }
  }

  const on = () => cfg.on
  const poke = () => sync() // 右键菜单点完立刻生效，不等 2 秒轮询
  send('call-config', publicCfg())
  return { onAudio, publicCfg, report, isOn: on, poke, stats: () => ({ on: cfg.on, total, lastLogAt }) }
}

module.exports = { initCall, readCallSettings }
