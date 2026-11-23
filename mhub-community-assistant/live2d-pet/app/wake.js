// 唤醒词：叫「小鱼小鱼」就开始听（第 5 期，主进程半边）
//
// 引擎用 sherpa-onnx 的 KeywordSpotter（中文 KWS 模型，int8 一共 4.6MB）。
// 为什么选它：Apache-2.0、全离线、中文有现成模型；而且 sherpa-onnx-node 是 N-API 原生模块，
// 在 Electron 45 里直接 require 就能用，**不用 electron-rebuild**（2026-11-07 实测）。
// 所以唤醒不开新进程 —— 就长在桌宠自己的主进程里。
//
// 职责边界：这个文件只做三件事
//   1. 吃 PCM（渲染页推过来的 16k 单声道），喂给 KWS
//   2. 命中关键词 → 通知渲染页「该开工了」
//   3. 冷却管理（唤醒后两秒内不再触发，免得一句话叫醒两次）
// 录音、断句、上送全在渲染页和 ear.js 里，这里一概不管。
//
// 失败容忍：模型加载不了（文件缺了、dll 被杀软拦）只记一行日志、自己降级成关闭态，
// 绝不让桌宠本体跟着挂 —— 和耳朵、电话、陪看一个规矩。

const fs = require('node:fs')
const {readAudioConfig}=require('./resources.cjs')
const path = require('node:path')

const MODEL_DIR = process.env.LIVE2D_WAKE_MODEL_DIR || path.join(require('./resources.cjs').assetsRoot, 'models', 'kws')

// 词表只放长词。实测（2026-11-07）：把「小鱼」和「小鱼小鱼」同时写进词表时，
// 短词会抢走解码路径，两句都只能命中「小鱼」。所以这里只留一条，别贪心加简称。
const DEFAULT_KEYWORD = 'x iǎo y ú x iǎo y ú @小鱼小鱼'

const DEFAULTS = {
  on: false,            // 新安装不自动开启麦克风
  ack: true,            // 唤醒后先应一声
  ackMode: 'voice',     // voice = 三句台词随机；chime = 一声铃；off = 不出声
  coolingMs: 2000,      // 唤醒后冷却
  blanks: 4,            // numTrailingBlanks：关键词末尾要有几帧空白才确认
  score: 2.0,           // keywordsScore：越大越「执着」
  thr: 0.15,            // keywordsThreshold：越小越容易叫醒
}

function pickAckMode(w) {
  if (['voice', 'chime', 'off'].includes(w.ackMode)) return w.ackMode
  // 兼容只有 ack 布尔值的老配置
  return w.ack === false ? 'off' : 'voice'
}

function readWakeSettings(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const w = (j && j.wake) || {}
    const ackMode = pickAckMode(w)
    return {
      on: w.on === true,
      mic:typeof w.mic==='string'?w.mic:'', inputName:w.mic?'':readAudioConfig().inputName,
      ack: ackMode !== 'off',
      ackMode,
      // 自定义唤醒词：允许面板写中文，这里现算拼音 token（见 buildKeywordLine）
      word: typeof w.word === 'string' && w.word.trim() ? w.word.trim() : '小鱼小鱼',
      blanks: Number(w.blanks) >= 0 ? Number(w.blanks) : DEFAULTS.blanks,
      score: Number(w.score) > 0 ? Number(w.score) : DEFAULTS.score,
      thr: Number(w.thr) > 0 ? Number(w.thr) : DEFAULTS.thr,
    }
  } catch {
    return { ...DEFAULTS, mic:'',inputName:readAudioConfig().inputName,word: '小鱼小鱼' }
  }
}

let sherpa = null
function loadSherpa() {
  if (sherpa !== null) return sherpa
  try {
    // Windows 上 onnxruntime.dll 和 sherpa 的 dll 都在平台包里，
    // 必须先把那个目录塞进 PATH，否则 require 会报「找不到模块」而不是缺 dll，很难查。
    const plat = process.platform === 'win32' ? 'win' : process.platform
    const dir = path.join(__dirname, '..', 'node_modules', `sherpa-onnx-${plat}-${process.arch}`)
    if (fs.existsSync(dir)) process.env.PATH = dir + path.delimiter + process.env.PATH
    sherpa = require('sherpa-onnx-node')
    return sherpa
  } catch (e) {
    sherpa = false
    throw e
  }
}

// 拼音切分：声母 + 韵母，切出来的每一段都必须在该模型的 tokens.txt 里。
// 不这么做就得让面板用户自己写带声调的拼音（xiǎo yú），太反人类。
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']

// 中文 → 带声调拼音。模型只认带声调的 token，所以这里要自己转。
// 覆盖不了多音字（「行」「重」这类）——唤醒词一般不会踩到，真踩到了就在 pet.json 里
// 直接写拼音（word 字段填 "xiǎo yú" 这种，下面会原样当拼音用）。
const PINYIN = {
  小: 'xiǎo', 鱼: 'yú', 爱: 'ài', 同: 'tóng', 学: 'xué', 你: 'nǐ', 好: 'hǎo',
  军: 'jūn', 哥: 'gē', 蛋: 'dàn', 问: 'wèn', 艺: 'yì', 米: 'mǐ', 林: 'lín',
  美: 'měi', 丽: 'lì', 西: 'xī', 肥: 'féi', 大: 'dà', 头: 'tóu', 猫: 'māo',
  精: 'jīng', 灵: 'líng', 度: 'dù', 豆: 'dòu', 包: 'bāo', 智: 'zhì', 天: 'tiān',
  阿: 'ā', 里: 'lǐ', 深: 'shēn', 鱼: 'yú', 崽: 'zǎi', 宝: 'bǎo',
}

function buildKeywordLine(word, tokenSet, log) {
  // 已经是拼音（含空格或带声调字母）就原样用
  const isPinyin = /[a-zǎàáǎāēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(word) && !/[\u4e00-\u9fa5]/.test(word)
  let pinyin
  if (isPinyin) {
    pinyin = word
  } else {
    const parts = []
    for (const ch of word) {
      if (/[\u4e00-\u9fa5]/.test(ch)) {
        const p = PINYIN[ch]
        if (!p) { log && log('唤醒：字「' + ch + '」还没有拼音映射，请在 pet.json 的 wake.word 里直接写拼音'); return null }
        parts.push(p)
      } else if (/[a-z\s]/i.test(ch)) {
        parts.push(ch)
      }
    }
    pinyin = parts.join(' ')
  }

  const toks = []
  for (const syl of pinyin.trim().split(/\s+/)) {
    let done = false
    for (const ini of INITIALS) {
      if (syl.startsWith(ini) && syl.length > ini.length) {
        const fin = syl.slice(ini.length)
        if (tokenSet.has(ini) && tokenSet.has(fin)) { toks.push(ini, fin); done = true; break }
      }
    }
    if (!done) {
      if (tokenSet.has(syl)) toks.push(syl)
      else { log && log('唤醒：拼音「' + syl + '」切不出词表里的 token'); return null }
    }
  }
  return { line: toks.join(' ') + ' @' + word, tokens: toks }
}

/**
 * @param {object} o
 * @param {(file:string)=>object} o.readWake  每 2 秒读一次设置
 * @param {(ch:string, data:any)=>void} o.send  推给渲染页
 * @param {(...a:any)=>void} o.log
 */
function initWake({ readWake, send, log }) {
  let cfg = readWake()
  let kws = null
  let stream = null
  let loading = false
  let broken = false
  let lastHitAt = 0
  let hitCount = 0
  let feedCount = 0

  const publicCfg = () => ({ on: isOn(),mic:cfg.mic,inputName:cfg.inputName,word: cfg.word, ack: cfg.ack, ackMode: cfg.ackMode, ready: !!kws, broken })

  function isOn() { return cfg.on && !!kws }

  // ---- 载入引擎（同步，326ms 实测；只在第一次开启时付一次）----
  function ensureEngine() {
    if (kws || broken || loading) return !!kws
    loading = true
    const t0 = Date.now()
    try {
      const s = loadSherpa()
      const enc = path.join(MODEL_DIR, 'encoder.int8.onnx')
      const dec = path.join(MODEL_DIR, 'decoder.onnx')
      const joi = path.join(MODEL_DIR, 'joiner.int8.onnx')
      const tokFile = path.join(MODEL_DIR, 'tokens.txt')
      for (const f of [enc, dec, joi, tokFile]) {
        if (!fs.existsSync(f)) throw new Error('缺模型文件：' + path.basename(f))
      }
      const tokenSet = new Set(
        fs.readFileSync(tokFile, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
      )
      const kw = buildKeywordLine(cfg.word, tokenSet, log)
      if (!kw) throw new Error('唤醒词「' + cfg.word + '」转不成词表 token')
      const kwFile = path.join(MODEL_DIR, '_active.txt')
      fs.writeFileSync(kwFile, kw.line + '\n', 'utf8')

      kws = new s.KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: enc, decoder: dec, joiner: joi },
          tokens: tokFile,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        maxActivePaths: 4,
        numTrailingBlanks: cfg.blanks,
        keywordsScore: cfg.score,
        keywordsThreshold: cfg.thr,
        keywordsFile: kwFile,
      })
      stream = kws.createStream()
      log(`唤醒已就绪：「${cfg.word}」 加载 ${Date.now() - t0}ms`)
      return true
    } catch (e) {
      broken = true
      kws = null
      log('唤醒：引擎起不来（叫不醒她，其他功能不受影响）：' + String((e && e.message) || e))
      return false
    } finally {
      loading = false
    }
  }

  function dropEngine() {
    try { kws = null } catch {}
    stream = null
  }

  // ---- 吃 PCM：渲染页每 128ms 推一帧（2048 个 Float32 @16k）----
  function feed(pcm) {
    if (broken) return
    if (!cfg.on) return
    if (!kws && !ensureEngine()) return
    if (!stream) return
    feedCount++
    try {
      stream.acceptWaveform({ samples: pcm, sampleRate: 16000 })
      while (kws.isReady(stream)) kws.decode(stream)
      const r = kws.getResult(stream)
      if (r && r.keyword) {
        kws.reset(stream)
        onHit(r.keyword)
      }
    } catch (e) {
      broken = true
      log('唤醒：解码出错，已停用：' + String((e && e.message) || e))
    }
  }

  function onHit(keyword) {
    const now = Date.now()
    if (now - lastHitAt < cfg.coolingMs) return
    lastHitAt = now
    hitCount++
    log(`唤醒：听到「${keyword}」（第 ${hitCount} 次）`)
    send('wake-hit', { keyword, ack: cfg.ack, ackMode: cfg.ackMode, at: now })
  }

  // ---- 设置热刷新：面板改完不用重启 ----
  let poll = setInterval(() => {
    const next = readWake()
    const changed = next.mic !== cfg.mic || next.inputName !== cfg.inputName || next.on !== cfg.on || next.word !== cfg.word || next.ack !== cfg.ack
      || next.ackMode !== cfg.ackMode
      || next.thr !== cfg.thr || next.score !== cfg.score || next.blanks !== cfg.blanks
    cfg = next
    if (!changed) return
    log('唤醒设置 →', JSON.stringify({ on: cfg.on, word: cfg.word, ack: cfg.ack, ackMode: cfg.ackMode, thr: cfg.thr, score: cfg.score, blanks: cfg.blanks }))
    // 词或阈值变了必须重建成引擎，不然新参数不生效
    dropEngine()
    broken = false
    if (cfg.on) ensureEngine()
    send('wake-config', publicCfg())
  }, 2000)
  if (poll.unref) poll.unref()

  if (cfg.on) ensureEngine()
  send('wake-config', publicCfg())

  return {
    feed,
    publicCfg,
    isOn,
    poke: () => { cfg = readWake(); dropEngine(); broken = false; if (cfg.on) ensureEngine(); send('wake-config', publicCfg()) },
    state: () => ({ on: cfg.on, word: cfg.word, ready: !!kws, broken, hitCount, feedCount, lastHitAt }),
  }
}

module.exports = { initWake, readWakeSettings, DEFAULT_KEYWORD }
