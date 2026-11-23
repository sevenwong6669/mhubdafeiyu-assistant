// 耳朵 · 渲染页半边：采音
//
// 为什么采音必须在这里：Electron 的主进程没有 getUserMedia，麦克风只能在渲染进程拿。
// 采到的 PCM 交给主进程编码 WAV 再上送（见 app/ear.js）。
//
// 这个文件与 index.html 的主逻辑**完全解耦**：不碰 model、不碰动作、不碰气泡，
// 只用一个自己创建的浮层做「正在听」的提示。这样即使耳朵出问题，桌宠本体也照常跑。
;(() => {
  const P = window.petBridge
  if (!P || !P.onPtt) return

  let ctx = null
  let stream = null
  let node = null
  let chunks = []
  let total = 0
  let recording = false
  let opening = false
  let attempt = 0
  let startedAt = 0
  let cfg = { on: true, mic: '', minMs: 300 }

  const MAX_SECONDS = 60 // 再长就是误触或忘了松手，截断保护内存

  // ---- 「正在听」浮层：自己建，不动 index.html 的结构 ----
  const hint = document.createElement('div')
  hint.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
    'display:none', 'align-items:center', 'gap:8px',
    'padding:7px 14px', 'border-radius:999px',
    'background:rgba(28,28,32,.82)', 'color:#fff',
    'font:13px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
    'white-space:nowrap', 'pointer-events:none', 'z-index:99',
    'box-shadow:0 2px 10px rgba(0,0,0,.25)',
  ].join(';')
  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#ff5a5a;flex:0 0 auto'
  const label = document.createElement('span')
  hint.appendChild(dot)
  hint.appendChild(label)
  document.body.appendChild(hint)

  // 红点呼吸：录音中要让人一眼看出「她在听」，静止的红点看起来像卡住了
  let blink = null
  function startBlink() {
    let on = true
    stopBlink()
    blink = setInterval(() => { on = !on; dot.style.opacity = on ? '1' : '.25' }, 520)
  }
  function stopBlink() { if (blink) { clearInterval(blink); blink = null } ; dot.style.opacity = '1' }

  function showHint(text) {
    label.textContent = text
    hint.style.display = 'flex'
  }
  function hideHint() {
    hint.style.display = 'none'
    stopBlink()
  }

  // ---- 采音 ----
  async function start(withShot) {
    if (recording || opening) return
    const id = ++attempt
    opening = true
    showHint('正在打开麦克风…')
    try {
      const audio = {
        // 回声消除用的是 Chromium 的 WebRTC AEC：她自己说话时不会把自己的声音录回去。
        // 这是第 3 期「电话」能不能边播边听的关键，现在就按能用的最严档配。
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      }
      const selectedInput=await window.petAudioDevices.inputConstraint(cfg)
      if(id!==attempt)return
      if(selectedInput)audio.deviceId=selectedInput
      const opened = await navigator.mediaDevices.getUserMedia({ audio })
      if (id !== attempt) {
        opened.getTracks().forEach((track) => track.stop())
        return
      }
      stream = opened
      // 采样率直接要 16k：Chromium 会把设备的 48k 流重采样过来，
      // 省掉自己写重采样（也避免插值引入的失真）。sherpa/SenseVoice 要的就是 16k 单声道。
      ctx = new AudioContext({ sampleRate: 16000 })
      const src = ctx.createMediaStreamSource(stream)
      node = ctx.createScriptProcessor(4096, 1, 1)
      chunks = []
      total = 0
      node.onaudioprocess = (ev) => {
        if (!recording) return
        const d = ev.inputBuffer.getChannelData(0)
        if (total >= 16000 * MAX_SECONDS) return
        chunks.push(new Float32Array(d))
        total += d.length
      }
      src.connect(node)
      node.connect(ctx.destination) // ScriptProcessor 不接 destination 在部分版本里不回调
      recording = true
      startedAt = Date.now()
      startBlink()
      // 带图键要说清楚「会截屏」，否则按错了会把桌面内容发出去自己还不知道
      showHint(withShot ? '正在听…（说话；这一屏会一起给她看）' : '正在听…')
      P.log && P.log('耳朵：开始采音' + (cfg.mic || cfg.inputName ? '（指定设备）' : '（默认设备）') + (withShot ? '＋截图' : ''))
    } catch (e) {
      if (id !== attempt) return
      cleanup()
      showError(id, '麦克风打不开：' + String((e && e.message) || e).slice(0, 40))
      P.log && P.log('耳朵：麦克风打开失败', String((e && e.message) || e))
    } finally {
      if (id === attempt) opening = false
    }
  }

  function showError(id, text) {
    stopBlink()
    showHint(text)
    setTimeout(() => { if (id === attempt) hideHint() }, 2600)
  }

  function cleanup() {
    recording = false
    try { node && node.disconnect() } catch {}
    try { ctx && ctx.close() } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()) } catch {}
    node = null
    ctx = null
    stream = null
  }

  async function stop(withShot, msHint) {
    if (opening) {
      cancel()
      showError(attempt, '麦克风尚未就绪，请再按住说话')
      return
    }
    if (!recording) return
    const id = attempt
    const ms = Date.now() - startedAt
    recording = false
    cleanup()
    const pcm = merge(chunks)
    chunks = []
    if (!pcm.length || ms < (cfg.minMs || 300)) {
      hideHint()
      P.log && P.log('耳朵：太短，丢弃（' + ms + 'ms / ' + pcm.length + ' 样本）')
      return
    }
    showHint(withShot ? '听到了，正在看图想…' : '听到了，正在想…')
    startBlink()
    try {
      const result = await P.earAudio({ pcm, sampleRate: 16000, ms: msHint || ms, withShot: Boolean(withShot) })
      if (id !== attempt) return
      if (result?.ok === false) showError(id, String(result.message || '语音未能送达').slice(0, 60))
      else hideHint()
    } catch (e) {
      if (id === attempt) showError(id, '语音未能送达，请再试一次')
      P.log && P.log('耳朵：上送失败', String((e && e.message) || e))
    }
  }

  function cancel() {
    attempt++
    opening = false
    cleanup()
    chunks = []
    hideHint()
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

  P.onPtt((d) => {
    const a = String((d && d.action) || '')
    if (a === 'start') start(d.withShot)
    else if (a === 'stop') stop(d.withShot, d.ms)
    else if (a === 'cancel') cancel()
  })
  P.onEarState && P.onEarState((d) => {
    if (d && d.message) showError(attempt, String(d.message).slice(0, 60))
  })
  P.onEarConfig && P.onEarConfig((d) => { if (d) cfg = { ...cfg, ...d } })
  P.earConfig && P.earConfig().then((d) => { if (d) cfg = { ...cfg, ...d } }).catch(() => {})

  // 调试钩子：不按键也能跑一遍完整采音（脚本测试用）
  window.__ear = {
    start,
    stop,
    cancel,   // 唤醒中点 F1 时要能用一下（wake.js 调用），确保这一下不采音、不上送
    state: () => ({ recording, samples: total, cfg }),
  }
  P.log && P.log('耳朵（渲染页）已就绪')
})()
