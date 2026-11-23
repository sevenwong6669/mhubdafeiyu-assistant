// 电话 · 渲染页半边：一直听、自己断句、能插话（第 3 期）
//
// 和「耳朵（按住说话）」是两套东西：
//   耳朵 = 按住才采音，松手才上送，一句话一件事；
//   电话 = 一直采音，靠能量自己切句，说完一句就自己发出去，不用任何键。
//
// 为什么断句放在渲染页：PCM 就在手上（ScriptProcessor 回调里），
// 每 128ms 判一次能量最省事；切好一句再走一次 IPC，比每帧都传 PCM 划算。
//
// 回声：她说话时扬声器会把声音送回麦克风。getUserMedia 开了 echoCancellation 之后
// 实测（.frames/aecho.cjs）残留只有 -61dB，和静音底噪一样 —— 也就是**她说话时我也能说话**，
// 这就是插话的物理基础。但绝不能不设阈值兜底：AEC 在某些声卡/外放音量下会变差，
// 万一它失效，没有阈值就是她跟自己聊到天荒地老。
// 所以所有阈值都按「底噪自适应 + 播放中抬高」算，且模块那边还有一道文本相似度闸。
;(() => {
  const P = window.petBridge
  if (!P || !P.onCallCtl) return

  const FRAME_MS = 128          // ScriptProcessor 2048 @ 16k
  const ONSET_FRAMES = 3        // 连续 384ms 超阈值算「开始说话」
  const QUIET_FRAMES = 7        // 连续 896ms 低于半数阈值算「说完了」
  const BARGE_FRAMES = 4        // 她说话时连续 512ms 超过高阈值 = 插话

  let cfg = { on: false, mic: '', thr: 0.006, minMs: 400, maxSec: 12 }
  const report = (phase, error) => P.reportCall?.({owner: cfg.owner, phase, error})
  let stream = null
  let ctx = null
  let node = null
  let running = false

  // ---- VAD 状态 ----
  let phase = 'idle'            // idle | speech
  let buf = []
  let bufLen = 0
  let pre = []                  // 起说前的几帧，补回来免得吃掉第一个字
  let noise = 0.002             // 底噪（EMA）
  let onsetRun = 0
  let quietRun = 0
  let bargeRun = 0
  let lastSubmitAt = 0
  let lastMs = 0                // 上一句的长度，用来判断「是不是她自己的残留」

  // ---- 「通话中」小徽标：自己建，不动 index.html 的结构 ----
  const badge = document.createElement('div')
  badge.style.cssText = [
    'position:absolute', 'right:12px', 'top:10px',
    'display:none', 'align-items:center', 'gap:6px',
    'padding:5px 11px', 'border-radius:999px',
    'background:rgba(28,28,32,.78)', 'color:#fff',
    'font:12px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
    'white-space:nowrap', 'pointer-events:none', 'z-index:99',
    'box-shadow:0 2px 10px rgba(0,0,0,.25)',
  ].join(';')
  const cdot = document.createElement('span')
  cdot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#4ade80;flex:0 0 auto'
  const ctext = document.createElement('span')
  ctext.textContent = '通话中'
  badge.appendChild(cdot); badge.appendChild(ctext)
  document.body.appendChild(badge)

  let pulse = null
  function pulseOn() {
    if (pulse) return
    let t = true
    pulse = setInterval(() => { t = !t; cdot.style.opacity = t ? '1' : '.3' }, 700)
  }
  function pulseOff() { if (pulse) { clearInterval(pulse); pulse = null } }
  function badgeText(s, color) {
    ctext.textContent = s
    cdot.style.background = color
  }

  function rms(d) {
    let s = 0
    for (let i = 0; i < d.length; i++) s += d[i] * d[i]
    return Math.sqrt(s / d.length)
  }
  function merge(list) {
    if (!list.length) return new Float32Array(0)
    let n = 0
    for (const c of list) n += c.length
    const out = new Float32Array(n)
    let o = 0
    for (const c of list) { out.set(c, o); o += c.length }
    return out
  }
  const petPlaying = () => !!(window.petAudio && window.petAudio.playing && window.petAudio.playing())

  // 一帧的能量判定
  let dbgN = 0
  let dbgMax = 0
  let dbgSum = 0
  let dbgLastAt = 0
  function onFrame(d) {
    if (!running || cfg.muted) return
    const r = rms(d)
    dbgN++
    dbgSum += r
    if (r > dbgMax) dbgMax = r
    if (dbgN % 40 === 0) {
      // 平时 30 秒才写一行；一旦进入说话状态就每 5 秒记 —— 调阈值时唯一的依据。
      // 没有这个只能瞎猜「是不是底噪太高」，但每秒一行会把 pet.log 刷爆。
      const due = phase !== 'idle' || Date.now() - dbgLastAt > 30000
      if (due) {
        dbgLastAt = Date.now()
        P.log && P.log(`电话·电平 max=${dbgMax.toFixed(4)} avg=${(dbgSum / dbgN).toFixed(4)}`
          + ` 门限=${Math.max(cfg.thr || 0.006, noise * 3).toFixed(4)} 底噪=${noise.toFixed(4)} ${phase}`)
      }
      dbgMax = 0; dbgSum = 0; dbgN = 0
    }
    const playing = petPlaying()
    const thr = Math.max(cfg.thr || 0.006, noise * 3)
    const thrPlay = thr * 2.4        // 她正在出声：门限抬高，只有明显是人在说才认
    const gate = playing ? thrPlay : thr

    if (phase === 'idle') {
      // 只在明显安静时更新底噪，否则她的声音会被算成「环境噪音」，阈值一路飙上去
      if (r < thr * 0.8) noise = noise * 0.97 + r * 0.03
      // ⚠ 必须复制：ScriptProcessor 的 inputBuffer 是**复用的同一块内存**，
      // 直接 push(d) 存进去的只是视图 —— 下一帧就把上一帧覆盖掉，
      // 最后整句都是「最后一次回调」的内容（听起来就是全静音，实测识别恒为「没听清」）。
      pre.push(new Float32Array(d))
      if (pre.length > ONSET_FRAMES + 2) pre.shift()

      if (playing) {
        // 插话：她自己说话时，只有真人开口才会连续几帧冲过高门限
        bargeRun = r > gate ? bargeRun + 1 : 0
        if (bargeRun >= BARGE_FRAMES) {
          bargeRun = 0
          try { window.petAudio.stop() } catch {}
          P.log && P.log('电话：插话，打断她的语音')
          badgeText('通话中', '#facc15')
        }
      } else {
        bargeRun = 0
      }

      onsetRun = r > gate ? onsetRun + 1 : 0
      if (onsetRun >= ONSET_FRAMES) {
        phase = 'speech'
        buf = pre.slice()
        bufLen = buf.reduce((n, x) => n + x.length, 0)
        pre = []
        onsetRun = 0
        quietRun = 0
        badgeText('在听你说', '#4ade80')
      }
      return
    }

    // ---- speech：攒着，等他说完 ----
    buf.push(new Float32Array(d)) // 复制，理由同上：inputBuffer 复用同一块内存
    bufLen += d.length
    quietRun = r < thr * 0.55 ? quietRun + 1 : 0
    const quietFrames = cfg.silenceMs ? Math.ceil(cfg.silenceMs / FRAME_MS) : QUIET_FRAMES
    if (quietRun >= quietFrames) { submit('说完'); return }
    if (bufLen >= 16000 * (cfg.maxSec || 12)) submit('太长')
  }

  function submit(why) {
    const pcm = merge(buf)
    buf = []
    bufLen = 0
    phase = 'idle'
    quietRun = 0
    pre = []
    const ms = Math.round((pcm.length / 16000) * 1000)
    lastMs = ms
    if (ms < (cfg.minMs || 400)) {
      P.log && P.log(`电话：${why}，但只有 ${ms}ms，丢弃`)
      badgeText('通话中', '#4ade80')
      return
    }
    // 两句之间留 240ms 缝：刚提交完的余音不该立刻触发下一句
    if (Date.now() - lastSubmitAt < 240) { badgeText('通话中', '#4ade80'); return }
    lastSubmitAt = Date.now()
    badgeText('她在想…', '#93c5fd')
    P.log && P.log(`电话：一句 ${(ms / 1000).toFixed(1)}s（${why}）→ 上送`)
    P.callAudio({ pcm, ms, owner: cfg.owner }).catch((e) => {
      P.log && P.log('电话：上送失败', String((e && e.message) || e))
      badgeText('通话中', '#4ade80')
    })
    setTimeout(() => { if (phase === 'idle' && running) badgeText('通话中', '#4ade80') }, 6000)
  }

  // ---- 开关 ----
  // 必须防并发：面板切换（主进程推 call-ctl）和页面加载末尾的「读配置自动接通」
  // 会在同一瞬间各调一次 start，两次都在 await getUserMedia 时 running 还是 false，
  // 结果开了两条流、挂两个回调 —— 同一段音被算两遍，VAD 灵敏度和句长都翻倍。
  let starting = false
  let wantOn = false
  async function openMic(audio) {
    for (const delay of [350, 900]) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio })
      } catch (e) {
        if (!wantOn || audio.deviceId || !['NotFoundError', 'NotReadableError'].includes(e.name)) throw e
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (!wantOn) return null
    }
    return navigator.mediaDevices.getUserMedia({ audio })
  }

  async function start() {
    wantOn = true
    if (running || starting) return { ok: true }
    starting = true
    try {
      const audio = {
        echoCancellation: true,   // 没有它就没法边播边听（实测能消 18dB 以上）
        noiseSuppression: true,
        autoGainControl: true,    // 离麦克风远一点也听得到，代价是底噪跟着涨
        channelCount: 1,
      }
      const selectedInput=await window.petAudioDevices.inputConstraint(cfg)
      if(!wantOn)return {ok:false,message:"刚挂断"}
      if(selectedInput)audio.deviceId=selectedInput
      stream = await openMic(audio)
      if (!wantOn) {
        cleanup()
        return { ok: false, message: '刚挂断' }
      }
      ctx = new AudioContext({ sampleRate: 16000 })
      const src = ctx.createMediaStreamSource(stream)
      node = ctx.createScriptProcessor(2048, 1, 1)
      node.onaudioprocess = (ev) => onFrame(ev.inputBuffer.getChannelData(0))
      src.connect(node)
      node.connect(ctx.destination)
      running = true
      for (const track of stream.getAudioTracks()) {
        track.enabled = !cfg.muted
        track.addEventListener('ended', () => {
          if (!running) return
          running = false
          cleanup()
          pulseOff()
          badgeText('麦克风已断开', '#f87171')
          report('failed', '麦克风已断开')
        })
      }
      phase = 'idle'
      buf = []; bufLen = 0; pre = []; noise = 0.002
      onsetRun = 0; quietRun = 0; bargeRun = 0
      badge.style.display = 'flex'
      badgeText('通话中', '#4ade80')
      pulseOn()
      P.log && P.log('电话：已接通（一直听，自动断句）' + (cfg.mic || cfg.inputName ? '（指定设备）' : '（默认设备）'))
      report('connected')
      return { ok: true }
    } catch (e) {
      running = false
      cleanup()
      if (!wantOn) return { ok: false, message: '刚挂断' }
      const msg = String((e && e.message) || e)
      P.log && P.log('电话：麦克风打不开', msg)
      report('failed', msg)
      badge.style.display = 'flex'
      badgeText('麦克风打不开', '#f87171')
      pulseOff()
      setTimeout(() => { if (!running) badge.style.display = 'none' }, 3200)
      return { ok: false, message: msg }
    } finally {
      starting = false
    }
  }

  function stop() {
    wantOn = false
    report('ended')
    if (!running) return { ok: true }
    if (cfg.owner) window.petAudio?.stop?.()
    running = false
    cleanup()
    badge.style.display = 'none'
    pulseOff()
    P.log && P.log('电话：已挂断')
    return { ok: true }
  }

  function cleanup() {
    try { node && (node.onaudioprocess = null) } catch {}
    try { node && node.disconnect() } catch {}
    try { ctx && ctx.close() } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()) } catch {}
    node = null; ctx = null; stream = null
  }

  P.onCallCtl((d) => {
    const a = String((d && d.action) || '')
    if (a === 'start') start()
    else if (a === 'stop') stop()
  })
  function applyConfig(d) {
    if (!d) return
    if (running && (cfg.owner || '') !== (d.owner || '')) stop()
    const changedMute = !!cfg.muted !== !!d.muted
    cfg = { ...cfg, ...d }
    if (!running || !changedMute) return
    for (const track of stream.getAudioTracks()) track.enabled = !cfg.muted
    phase = 'idle'; buf = []; bufLen = 0; pre = []
    onsetRun = 0; quietRun = 0; bargeRun = 0
    badgeText(cfg.muted ? '麦克风已静音' : '通话中', '#4ade80')
  }
  P.onCallConfig?.(applyConfig)

  // 她在想的时候让徽标有个明确说法，别一直「通话中」看着像卡了
  P.onThink && P.onThink((d) => {
    if (!running) return
    if (d && d.on) badgeText('她在想…', '#93c5fd')
    else if (phase === 'idle') badgeText('通话中', '#4ade80')
  })

  window.__call = {
    start,
    stop,
    state: () => ({ running, phase, noise: +noise.toFixed(5), lastMs, bufLen }),
    feed: (pcm) => onFrame(pcm), // 调试：不用麦克风也能喂 PCM 进来
  }
  P.log && P.log('电话（渲染页）已就绪')

  // 主进程可能在页面就绪前就推过 start（开机自启电话），这里补一次
  P.callConfig && P.callConfig().then((d) => {
    applyConfig(d)
    if (d && d.on) start()
  }).catch(() => {})
})()
