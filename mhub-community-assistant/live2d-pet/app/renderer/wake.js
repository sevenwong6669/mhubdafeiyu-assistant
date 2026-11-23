// 唤醒 · 渲染页半边：一直听「小鱼小鱼」，叫醒了就录一句
//
// 和 ear.js（按住说话）、call.js（电话）是三套东西，但采音手法同源：
//   ear.js  = 按键才开麦
//   call.js = 一直开麦、自己断句、连续对话
//   wake.js = 一直开麦、只在听到唤醒词之后才录一句（就是本文件）
//
// 为什么自己开一条流，不蹭 ear.js 的：ear.js 是「按下才开麦」，唤醒需要「一直开麦」，
// 生命周期完全不同。硬合到一起会让按住说话在没按键时也占着麦克风，坏了还互相牵连。
// 代价是两条流可能同时存在（先生按 F1 时），所以下面有主动让路：F1 一按下就暂停推流。
//
// 一句话流程：
//   常驻流 → 每 128ms 一帧 → 推给主进程做唤醒词识别
//   命中 → 播应答音（「怎么啦？」「我在」「你说」随机一句）→ 等他开口（最多 4 秒）→ 静音 896ms 收句 → 走 earAudio 上送
//   上送之后完全复用耳朵那条链路，识别和回答都在那边，这里一概不管。

;(() => {
  const P = window.petBridge
  if (!P || !P.onWakeHit) return

  const FRAME = 2048              // ScriptProcessor 2048 @ 16k = 128ms 一帧
  const ONSET_FRAMES = 3          // 连续 384ms 超过门限算「开始说话」
  const QUIET_FRAMES = 7          // 连续 896ms 静音算「说完了」
  const ARM_TIMEOUT = 4000        // 叫醒了却一直不说话，4 秒后放弃
  const DROP_AFTER_HIT = 150      // 唤醒词自己的尾音，别录进去
  const MAX_SEC = 20              // 单句上限

  let cfg = { on: true, word: '小鱼小鱼', ack: true, ackMode: 'voice', ready: false }
  let stream = null
  let ctx = null
  let node = null
  let running = false
  let starting = false
  let wantOn = false

  let phase = 'idle'              // idle | acking | arming | speech | submitting
  let buf = []
  let bufLen = 0
  let pre = []
  let noise = 0.002
  let onsetRun = 0
  let quietRun = 0
  let armUntil = 0
  let dropUntil = 0
  let lastHitAt = 0
  let hitCount = 0

  // ---- 浮层：唤醒后在屏幕下方给个状态，别让他对着空气说话 ----
  const hint = document.createElement('div')
  hint.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:56px', 'transform:translateX(-50%)',
    'display:none', 'align-items:center', 'gap:8px',
    'padding:7px 14px', 'border-radius:999px',
    'background:rgba(28,28,32,.82)', 'color:#fff',
    'font:13px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
    'white-space:nowrap', 'pointer-events:none', 'z-index:99',
    'box-shadow:0 2px 10px rgba(0,0,0,.25)',
  ].join(';')
  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#4ade80;flex:0 0 auto'
  const label = document.createElement('span')
  hint.appendChild(dot); hint.appendChild(label)
  document.body.appendChild(hint)

  let blink = null
  function showHint(text, color) {
    label.textContent = text
    dot.style.background = color || '#4ade80'
    hint.style.display = 'flex'
    if (!blink) {
      let t = true
      blink = setInterval(() => { t = !t; dot.style.opacity = t ? '1' : '.25' }, 520)
    }
  }
  function hideHint() {
    hint.style.display = 'none'
    if (blink) { clearInterval(blink); blink = null }
    dot.style.opacity = '1'
  }

  const rms = (d) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length) }
  const merge = (list) => {
    if (!list.length) return new Float32Array(0)
    let n = 0; for (const c of list) n += c.length
    const out = new Float32Array(n); let o = 0
    for (const c of list) { out.set(c, o); o += c.length }
    return out
  }
  const petPlaying = () => !!(window.petAudio && window.petAudio.playing && window.petAudio.playing())
  const earRecording = () => {
    try { return !!(window.__ear && window.__ear.state().recording) } catch { return false }
  }

  // ---- 应答音：本地文件，几十毫秒就响，不用等模型 ----
  // 两种应答方式，先生嫌台词「机械 + 失真」时可以直接切音效：
  //   voice = 三句台词随机（「怎么啦」「我在」「你说」），音色就是她说话那套 edge zh-CN-XiaoyiNeural
  //   chime = 两声柔和铃音，纯正弦合成，没有任何编码/重采样环节，绝不可能有音色问题
  //   off   = 不出声
  //
  // 2026-11-07 修「机械 + 失真」，两处根因：
  //  1) 之前是 16k。她的语音是 edge 的 24k mp3，播放时 Chromium 重采样到 48k；我先把 24k 压成 16k
  //     （8k 以上高频被 Nyquist 一刀切掉，实测 8k+ 能量 0%），再被抬回 48k —— 两次重采样 + 插值噪声。
  //     现在文件是 48k，且音量原样不动（之前把峰值 0.37 硬拉到 0.80，等于把噪声一起放大）。
  //  2) 之前用 `new Audio()` 播，走的是 media element 那条通道；她说话走的是 Web Audio
  //     （decodeAudioData → BufferSource → destination，见 index.html 的 playVoice）。
  //     两条通道的音量、重采样细节都不一样，同一段台词听着就会「不像同一个人」。
  //     现在应答音也走 Web Audio，链路和她完全一致。
  const ACK_FILES = ['wake-ack-1.wav', 'wake-ack-2.wav', 'wake-ack-3.wav']
  const ACK_WORDS = ['怎么啦', '我在', '你说']   // 只用于日志，方便对着听到的那句核对
  const CHIME_FILE = 'wake-chime.wav'
  let ackCtx = null
  const ackCache = new Map()   // file → Promise<AudioBuffer|null>
  const ackDur = {}            // file → 秒
  let ackSrc = null
  let lastAckIdx = -1

  function ackCtxGet() {
    if (!ackCtx) ackCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (ackCtx.state === 'suspended') ackCtx.resume().catch(() => {})
    return ackCtx
  }

  function loadAck(file) {
    if (!ackCache.has(file)) {
      ackCache.set(file, fetch(file)
        .then((r) => r.arrayBuffer())
        .then((b) => ackCtxGet().decodeAudioData(b))
        .then((buf) => { ackDur[file] = buf.duration; return buf })
        .catch((e) => {
          P.log && P.log(`唤醒：应答音加载失败 ${file} ${String((e && e.message) || e)}`)
          return null
        }))
    }
    return ackCache.get(file)
  }

  // 预热：启动就把四个文件解好，第一次叫醒也能立刻响，时长也早知道
  function warmAcks() {
    try { ackCtxGet(); [...ACK_FILES, CHIME_FILE].forEach((f) => { loadAck(f) }) } catch {}
  }

  function playAck() {
    const mode = cfg.ack === false ? 'off' : (cfg.ackMode || 'voice')
    if (mode === 'off') return 0
    let file, tag
    if (mode === 'chime') {
      file = CHIME_FILE; tag = '铃音'
    } else {
      // 随机但避开上一次那句 —— 连着叫两回听到同一句会显得很呆
      let i = Math.floor(Math.random() * ACK_FILES.length)
      if (i === lastAckIdx) i = (i + 1) % ACK_FILES.length
      lastAckIdx = i
      file = ACK_FILES[i]; tag = ACK_WORDS[i]
    }
    loadAck(file).then(async(buf) => {
      if (!buf) return
      stopAck()
      try {
        const ctx = ackCtxGet()
        await window.petAudioDevices.routeOutput(ctx)
        if(!wantOn)return
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(ctx.destination)
        src.onended = () => { if (ackSrc === src) ackSrc = null }
        ackSrc = src
        src.start()
        P.log && P.log(`唤醒：应答「${tag}」${buf.duration.toFixed(2)}s`)
      } catch (e) {
        P.log && P.log('唤醒：应答音放不出来 ' + String((e && e.message) || e))
      }
    })
    // 时长按真实音频算：几段长短不一（0.4~0.58s），写死一个值会让短的多等、长的被切。
    // 还没解出来时给 600ms 兜底（start() 里已预热，正常情况下这里一定是准的）。
    return ackDur[file] ? Math.round(ackDur[file] * 1000) : 600
  }

  function stopAck() {
    try { if (ackSrc) ackSrc.stop() } catch {}
    ackSrc = null
  }

  // ---- 每帧 ----
  function onFrame(d) {
    if (!running) return

    // 1) 待机：推给主进程做唤醒词识别
    if (phase === 'idle') {
      // 她自己正在出声时不喂 —— 她的回复里万一念到唤醒词，就会自己把自己叫醒
      if (cfg.on && !petPlaying() && !earRecording()) {
        P.wakePcm(new Float32Array(d)) // 必须复制：inputBuffer 是复用内存（call.js 踩过这个坑）
      }
      return
    }

    const r = rms(d)
    const thr = Math.max(0.006, noise * 3)
    if (r < thr * 0.8) noise = noise * 0.97 + r * 0.03

    // 2) 应答音还在放：不判 onset，但音频要先攒下来
    // 实测（2026-11-07）：应答音那 450ms 整段丢掉的话，他要是接着就说话，
    // 开头第一个字会被吃掉（「今天天气怎么样」识别成「天天气怎么样」）。
    // 所以这里往 pre 里存着，等真开口时一起带进句子。
    if (phase === 'acking') {
      if (Date.now() < armUntil) {
        if (Date.now() >= dropUntil) {
          pre.push(new Float32Array(d))
          if (pre.length > 8) pre.shift()
        }
        return
      }
      phase = 'arming'
      // armUntil 在这里换意思：前面是「应答音放完的时刻」，往后是「等他开口的截止时刻」。
      // 不重新赋值的话它还是过去的时刻，下一帧就会被判超时、立刻放弃（实测踩过）。
      armUntil = Date.now() + ARM_TIMEOUT
      showHint('在听，你说', '#4ade80')
      return
    }

    // 3) 唤醒词尾音：吃掉
    if (Date.now() < dropUntil) return

    // 4) 等他开口
    if (phase === 'arming') {
      // 这一帧先存下来再判断 —— 光在 else 里存的话，真正开口的那 384ms 就丢了
      pre.push(new Float32Array(d))
      if (pre.length > ONSET_FRAMES + 2) pre.shift()
      onsetRun = r > thr ? onsetRun + 1 : 0
      if (onsetRun >= ONSET_FRAMES) {
        phase = 'speech'
        buf = pre.slice()
        bufLen = buf.reduce((n, x) => n + x.length, 0)
        pre = []
        onsetRun = 0
        quietRun = 0
        showHint('在听，你说', '#4ade80')
      } else if (Date.now() > armUntil) {
        P.log && P.log(`唤醒：叫醒了但没说话，放弃（门限 ${thr.toFixed(4)} 底噪 ${noise.toFixed(4)}）`)
        reset()
        showHint('叫我了？', '#facc15')
        setTimeout(hideHint, 1600)
      }
      return
    }

    // 5) 攒着，等他说完
    if (phase === 'speech') {
      buf.push(new Float32Array(d))
      bufLen += d.length
      quietRun = r < thr * 0.55 ? quietRun + 1 : 0
      if (quietRun >= QUIET_FRAMES) submit('说完')
      else if (bufLen >= 16000 * MAX_SEC) submit('太长')
    }
  }

  function reset() {
    phase = 'idle'
    buf = []; bufLen = 0; pre = []
    onsetRun = 0; quietRun = 0
  }

  function submit(why) {
    const pcm = merge(buf)
    const ms = Math.round((pcm.length / 16000) * 1000)
    reset()
    if (ms < 300) {
      P.log && P.log(`唤醒：${why}，但只有 ${ms}ms，丢弃`)
      hideHint()
      return
    }
    phase = 'submitting'
    showHint('听到了，正在想…', '#93c5fd')
    P.log && P.log(`唤醒：一句 ${(ms / 1000).toFixed(1)}s（${why}）→ 上送`)
    Promise.resolve()
      .then(() => P.earAudio({ pcm, sampleRate: 16000, ms, withShot: false }))
      .catch((e) => P.log && P.log('唤醒：上送失败', String((e && e.message) || e)))
      .finally(() => { if (phase === 'submitting') reset(); hideHint() })
  }

  // ---- 收到唤醒 ----
  P.onWakeHit((d) => {
    if (!running) return
    if (phase !== 'idle') return
    if (earRecording()) { P.log && P.log('唤醒：F1 正在录，这次唤醒忽略'); return }
    const now = Date.now()
    if (now - lastHitAt < 1500) return
    lastHitAt = now
    hitCount++
    P.log && P.log(`唤醒：命中「${(d && d.keyword) || cfg.word}」，开始听`)
    const ackMs = playAck()
    phase = ackMs > 0 ? 'acking' : 'arming'
    // acking 时这个变量是「应答音放完的时刻」；转进 arming 时才改成截止时刻
    armUntil = now + ackMs
    if (ackMs <= 0) armUntil = now + ARM_TIMEOUT
    // 从命中那一刻算，不叠加应答音时长 —— 唤醒词在命中时早就说完了，
    // 叠上 450ms 的话他直接连着说时开头会被吃掉（实测吞了「今」字）
    dropUntil = now + DROP_AFTER_HIT
    buf = []; bufLen = 0; pre = []
    onsetRun = 0; quietRun = 0
    showHint('叫我了？', '#facc15')
  })

  // ---- 唤醒中点一下 F1 = 反悔 ----
  // 为什么要在 wake 里也听 ptt：唤醒之后麦克风是我这条流在收，F1 是耳朵那条流，
  // 两条流互不相干。先生按 F1 的意图很清楚 —— 「别听了」，所以这里直接撤掉这次唤醒，
  // 并且把耳朵这一下也按掉（window.__ear.cancel），不许有任何音频被送去识别。
  // 想看「短按到底多短」就不用管：取消跟按多久无关，按下即取消；想正常说话再按一次就行。
  function cancelWake(why) {
    const was = phase
    stopAck()
    reset()
    hideHint()
    showHint('已取消', '#f87171')
    setTimeout(() => { if (phase === 'idle') hideHint() }, 900)
    P.log && P.log(`唤醒：已取消（${why}，当时在 ${was}）`)
  }

  // 按下 F1 时走这里（从 onPtt 进来的）。单独抽成函数是为了能用调试钩子直接跑一遍，
  // 不必真按键盘 —— 这段逻辑的成败是「有没有东西被送去识别」，必须能验证。
  function onPttStart() {
    if (phase === 'idle') return false   // 平时按 F1：照常说话，不拦
    const ear = window.__ear
    if (ear && ear.cancel) { try { ear.cancel() } catch {} }
    cancelWake('按了 F1')
    return true
  }

  if (P.onPtt) {
    P.onPtt((d) => {
      if (String((d && d.action) || '') !== 'start') return
      onPttStart()
    })
  }

  // ---- 开关 ----
  async function start() {
    if (running || starting) return { ok: true }
    starting = true
    wantOn = true
    try {
      const audio = {
        echoCancellation: true,   // 她自己说话时别把自己的声音当唤醒词
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      }
      const selectedInput=await window.petAudioDevices.inputConstraint(cfg)
      if(!wantOn)return {ok:false,message:"刚关闭"}
      if(selectedInput)audio.deviceId=selectedInput
      stream = await navigator.mediaDevices.getUserMedia({ audio })
      ctx = new AudioContext({ sampleRate: 16000 })
      const src = ctx.createMediaStreamSource(stream)
      node = ctx.createScriptProcessor(FRAME, 1, 1)
      node.onaudioprocess = (ev) => onFrame(ev.inputBuffer.getChannelData(0))
      src.connect(node)
      node.connect(ctx.destination)
      running = true
      if (!wantOn) { running = false; cleanup(); return { ok: false, message: '刚关掉' } }
      reset()
      // 先把应答音预热，免得第一次唤醒时还没解码完、时长也不准
      try { warmAcks() } catch {}
      P.log && P.log(`唤醒：已开始监听「${cfg.word}」（一直开麦，只在叫醒后录音）`)
      return { ok: true }
    } catch (e) {
      running = false
      cleanup()
      const msg = String((e && e.message) || e)
      P.log && P.log('唤醒：麦克风打不开', msg)
      return { ok: false, message: msg }
    } finally {
      starting = false
    }
  }

  function stop() {
    wantOn = false
    if (!running) return { ok: true }
    running = false
    reset()
    cleanup()
    hideHint()
    P.log && P.log('唤醒：已停止监听')
    return { ok: true }
  }

  function cleanup() {
    try { node && (node.onaudioprocess = null) } catch {}
    try { node && node.disconnect() } catch {}
    try { ctx && ctx.close() } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()) } catch {}
    node = null; ctx = null; stream = null
  }

  function applyCfg(next) {
    const wasOn = cfg.on
    const micChanged=cfg.mic!==next.mic || cfg.inputName!==next.inputName
    cfg = { ...cfg, ...next }
    if(cfg.on && running && micChanged){stop();start()}
    else if (cfg.on && !running) start()
    else if (!cfg.on && running) stop()
    else if (cfg.on !== wasOn) P.log && P.log(`唤醒：${cfg.on ? '开' : '关'}`)
  }

  P.onWakeConfig && P.onWakeConfig((d) => { if (d) applyCfg(d) })
  P.wakeConfig && P.wakeConfig().then((d) => { if (d) applyCfg(d) }).catch(() => {})

  window.__wake = {
    start, stop,
    state: () => ({ running, phase, noise: +noise.toFixed(5), bufLen, hitCount, cfg }),
    feed: (pcm) => onFrame(pcm),
    pttStart: onPttStart,   // 调试钩子：等价于「按了一下 F1」
  }
  P.log && P.log('唤醒（渲染页）已就绪')
})()
