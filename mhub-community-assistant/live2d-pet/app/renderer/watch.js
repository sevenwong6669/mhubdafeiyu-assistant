// 陪看（第 4 期）· 渲染页半边：抓屏 → 按变化量筛帧 → 拼成一张图 → 交给主进程
//
// 这是 dsh-see-now 那套省 token 思路的本机版，动机很具体：
//   「每 15 秒截一张全屏发过去」一秒 30 张里 29 张是重复画面，token 直接烧穿；
//   「每 30 秒截一张」中间发生了什么全丢了，她只会说"你在用电脑"。
// 所以这里先判「这一帧值不值得看」，再决定传不传；留下来的几帧拼进同一张图，
// 一张图的固定成本（≈222 token / 798×450）摊到 2~4 帧上 —— 多留一帧几乎免费，漏一帧才贵。
//
// 三个刻意的设计：
//   1) 不用 desktopCapturer 每帧现抓（实测 420ms/次，一秒钟一次就吃掉半个核），
//      而是 getDisplayMedia 拿一条流，之后每帧只是 drawImage（<1ms）。
//   2) 算变化分前先把**桌宠自己那块矩形**挖掉：她在画面角落里点头、气泡一张一合，
//      不挖掉就会"自己触发自己"，一句接一句停不下来。
//   3) 画面没变就一张都不交 —— 交给模块就意味着一轮完整的思考，那才是真正花钱的地方。
;(() => {
  const P = window.petBridge
  if (!P || !P.onWatchCtl) return

  const SAMPLE_MS = 500          // 0.5 秒采一个样：够快看清切场景，又不至于空转烧 CPU
  const GW = 64, GH = 36         // 变化分算在这张 64×36 的网格上（和 see-now 同一套口径）
  const CUT = 55                 // 单帧变化分 ≥ 这个 = 画面「突然换了一张」（硬切/切窗口）
  const MOTION = 6               // 单帧 ≥ 这个算"在动"，攒进积分
  const MOTION_SUM = 220         // 积分攒够 = 一直在动（运镜、打斗），值得留一帧
  const KEEP_MIN_GAP = 700       // 两次留帧至少隔这么久，免得连切三次全留下来
  const MAX_KEEP = 4             // 一张图最多装 4 帧（2×2）
  const SHEET_W = 1596, SHEET_H = 900   // 798 是 42 的整数倍：DeepSeek 的 patch 网格正好 19 列，不浪费

  let cfg = { on: false, mode: 'auto', pace: 'normal', paceSec: 15, listen: true, proactive: false, chatMin: 45, chatMax: 120, callOn: false }
  let stream = null, video = null
  let scoreCv = null, scoreCx = null
  let tileCv = null, tileCx = null
  let prev = null               // 上一帧的 64×36 像素
  let mask = null               // 桌宠窗口在画面里的占比（挖掉不算）
  let running = false, starting = false
  let wantOn = false
  let generation = 0, retryTimer = null, retries = 0, stage = 'capture'
  let snapshotTimer=null,snapshotBusy=false,backend='video'
  let phase = 'stopped', lastFrameAt = 0, lastMediaTime = -1, lastReportAt = 0
  let lastError = null
  function report(next = phase, error = lastError) {
    phase = next; lastError = error
    P.watchStatus?.({phase, desired:wantOn, sessionVersion:cfg.sessionVersion,
      lastFrameAt, width:video?.videoWidth || 0, height:video?.videoHeight || 0,
      backend,retryCount:retries, error, at:Date.now()})
  }
  function fail(error, token = generation) {
    if(token !== generation || !wantOn) return
    const failedWidth=video?.videoWidth||0,failedHeight=video?.videoHeight||0
    const epoch=++generation;starting=false;delivering=false
    running=false; releaseCapture()
    const name=String(error?.name || 'CaptureError')
    const blocked=['NotAllowedError','SecurityError','DisplayMissingError'].includes(name)
    const details={stage, name, message:String(error?.message || error).slice(0,200)}
    P.log?.('陪看采集诊断', JSON.stringify({stage,name,width:failedWidth,height:failedHeight,retry:retries}))
    if(blocked || retries>=5){report('failed',details);badgeSet('陪看失败 · 请检查屏幕或权限','#f87171');return}
    const delay=[1000,2000,5000,10000,20000][retries++]
    report('retrying',details);badgeSet('抓屏重试中','#fbbf24')
    clearTimeout(retryTimer)
    retryTimer=setTimeout(()=>{retryTimer=null;if(wantOn&&epoch===generation)start(true)},delay)
  }
  function fit(cx,img,x,y,w,h) {
    const iw=img.videoWidth||img.naturalWidth||img.width, ih=img.videoHeight||img.naturalHeight||img.height
    const k=Math.min(w/iw,h/ih)
    cx.fillStyle='#0b0d10';cx.fillRect(x,y,w,h)
    cx.drawImage(img,x+(w-iw*k)/2,y+(h-ih*k)/2,iw*k,ih*k)
  }
  let acc = 0                   // 运动积分
  let kept = []                 // [{url, t}]
  let lastKeepAt = 0
  let lastDeliverAt = 0
  let lastChangeAt = Date.now()
  let delivered = 0
  let idleLoggedAt = 0
  let sampleTimer = null
  let delivering = false        // 上一张还在拼/在送：绝不让两张图抢着交付（顺序一乱她会看到"倒放"）
  let nextChatAt = 0            // 主动搭话下一个时间点：每次都重新摇一个区间内的随机值

  // 主动搭话的间隔：每轮现摇，不用固定值 —— 固定值会让「她开口」变成可预测的节拍器，
  // 听久了比不说话还难受。区间两端都钳在 20–180 秒（和面板、模块同一口径）。
  function pickChatGap() {
    const lo = Math.max(20, Math.min(180, Number(cfg.chatMin) || 45))
    const hi = Math.max(lo, Math.min(180, Number(cfg.chatMax) || 120))
    return (lo + Math.random() * (hi - lo)) * 1000
  }
  function resetChatTimer() { nextChatAt = Date.now() + pickChatGap() }

  // ---- 徽标（和电话那个一左一右，互相不打架） ----
  const badge = document.createElement('div')
  badge.style.cssText = [
    'position:absolute', 'left:12px', 'top:10px',
    'display:none', 'align-items:center', 'gap:6px',
    'padding:5px 11px', 'border-radius:999px',
    'background:rgba(28,28,32,.78)', 'color:#fff',
    'font:12px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
    'white-space:nowrap', 'pointer-events:none', 'z-index:99',
    'box-shadow:0 2px 10px rgba(0,0,0,.25)',
  ].join(';')
  const dot = document.createElement('span')
  dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#7dd3fc;flex:0 0 auto'
  const txt = document.createElement('span')
  txt.textContent = '陪看中'
  badge.appendChild(dot); badge.appendChild(txt)
  document.body.appendChild(badge)

  function badgeSet(s, color) {
    if (s == null) { badge.style.display = 'none'; return }
    txt.textContent = s
    dot.style.background = color || '#7dd3fc'
    badge.style.display = 'flex'
  }

  // ---- 变化分 ----
  function makeCanvas(w, h) {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    return [c, c.getContext('2d', { willReadFrequently: true })]
  }

  // 这一格要不要参与算分：桌宠窗口盖住的地方不算
  function masked(gx, gy) {
    if (!mask) return false
    const fx = (gx + 0.5) / GW, fy = (gy + 0.5) / GH
    return fx >= mask.x0 && fx <= mask.x1 && fy >= mask.y0 && fy <= mask.y1
  }

  function scoreOf(cur) {
    if (!prev) return 255
    let sum = 0, n = 0
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        if (masked(gx, gy)) continue
        const i = (gy * GW + gx) * 4
        const r = cur[i], g = cur[i + 1], b = cur[i + 2]
        const r2 = prev[i], g2 = prev[i + 1], b2 = prev[i + 2]
        const dy = Math.abs(0.299 * (r - r2) + 0.587 * (g - g2) + 0.114 * (b - b2))
        const dc = (Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2)) / 3
        sum += dy * 0.6 + dc * 0.4
        n++
      }
    }
    return n ? (sum / n) * (255 / 255) * 1 : 0
  }

  function keepFrame(score) {
    const now = Date.now()
    if (now - lastKeepAt < KEEP_MIN_GAP) return
    lastKeepAt = now
    lastChangeAt = now
    badgeSet('陪看中 · 有变化', '#7dd3fc')
    if (!tileCx) return
    // 一批最多 4 帧，满了就**不再往里塞**（以前是满了立刻交付 → 节奏形同虚设：
    // 看视频时画面一直在动，3 秒就攒满 4 帧、3 秒交一张，先生 21:28 说「频率有点高」就是它）。
    // 现在攒满就停手，等 pace 那个时间点把这一批整个交出去。
    if (kept.length >= MAX_KEEP) return
    // 每帧先存成整张尺寸（798×450）：只留 1 帧时铺满也不糊，4 帧时再缩进格子也清楚
    fit(tileCx, video, 0, 0, SHEET_W, SHEET_H)
    kept.push({ url: tileCv.toDataURL('image/jpeg', 0.82), t: now, score: Math.round(score) })
  }

  // 主动模式到点时**现抓**一张当前画面（不看变化分）。
  // 不抓的话她手里只有一张「上一次变化时」的旧图，或者根本没图、只能靠提示词说「别猜画面」——
  // 那就不叫陪看了，叫按闹钟说话。
  function grabNow() {
    if (!video || video.readyState < 2 || !tileCx) return false
    fit(tileCx, video, 0, 0, SHEET_W, SHEET_H)
    kept.push({ url: tileCv.toDataURL('image/jpeg', 0.82), t: Date.now(), score: 0 })
    while (kept.length > MAX_KEEP) kept.shift()
    return true
  }

  function sample() {
    if (!running || !video) return
    const now=Date.now()
    if(video.readyState>=2 && video.videoWidth>0 && video.videoHeight>0 && video.currentTime!==lastMediaTime){
      lastMediaTime=video.currentTime;lastFrameAt=now
      if(retries && now-lastDeliverAt>10000)retries=0
      if(phase!=='running'||now-lastReportAt>=5000){lastReportAt=now;report('running',null)}
    }
    if(now-lastFrameAt>15000){stage='frame-stall';fail(Error('连续 15 秒没有有效视频帧'));return}
    if(video.readyState<2)return
    try { scoreCx.drawImage(video, 0, 0, GW, GH)
    const cur = scoreCx.getImageData(0, 0, GW, GH).data
    const s = scoreOf(cur)
    prev = cur
    if (s >= CUT) {
      acc = 0
      keepFrame(s)
    } else if (s >= MOTION) {
      acc += s
      if (acc >= MOTION_SUM) { acc = 0; keepFrame(s) }
    } else {
      acc = Math.max(0, acc - 4)   // 慢慢泄掉，免得隔很久的零碎动作攒成一帧
    }
    } catch(error){stage='frame-read';fail(error);return}
    // ---- 从这里开始，两套模式彻底分开，任何时刻只有一路在驱动 ----
    // 主动模式（鱼搭子那套）：不看变化分，纯按随机间隔自己开口。
    //   到点就现抓一张「现在的屏幕」交出去；电话通着时不开口（跟电话节奏走），图只攒着。
    if(cfg.callOn){
      if(Date.now()-lastDeliverAt>=5000){kept=[];grabNow();deliver('frames')}
      return
    }
    if (cfg.mode === 'active') {
      if (!cfg.callOn && Date.now() >= nextChatAt) {
        kept=[];grabNow()
        deliver(kept.length ? 'frames' : 'idle')
      }
      return
    }
    // 自动模式：只有 pace 这一个闸门。到点、且有帧，就交；没到点就继续攒（最多 4 帧）。
    const due = Date.now() - lastDeliverAt >= cfg.paceSec * 1000
    if (kept.length && due) {
      deliver('frames')
    } else if (!kept.length && Date.now() - idleLoggedAt > 120000) {
      idleLoggedAt = Date.now()
      P.log && P.log(`陪看：画面没变化，这 ${Math.round((Date.now() - lastChangeAt) / 1000)}s 一张都没交（不花 token）`)
    }
  }

  // 拼图：一帧就铺满，两帧上下排，三四帧 2×2
  // ⚠ 必须把这一批帧**当参数传进来**：deliver() 里是先把 kept 清空再拼的，
  // 拼图函数若去读模块级的 kept，拿到的永远是空数组 —— 交付出去就是一张纯背景（实测栽过）。
  async function compose(list, now) {
    const n = list.length
    const [cv, cx] = makeCanvas(SHEET_W, SHEET_H)
    cx.fillStyle = '#0b0d10'
    cx.fillRect(0, 0, SHEET_W, SHEET_H)
    if (!n) return { url: cv.toDataURL('image/jpeg', 0.8), n: 0, tw: SHEET_W, th: SHEET_H }
    const cols = n === 1 ? 1 : 2
    const rows = n === 1 ? 1 : Math.ceil(n / 2)
    const tw = Math.floor(SHEET_W / cols), th = Math.floor(SHEET_H / rows)
    for (let i = 0; i < n; i++) {
      const img = new Image()
      img.src = list[i].url
      try { await img.decode() } catch (e) {
        P.log && P.log('陪看：这一帧解不开（' + ((e && e.message) || e) + '，url ' + String(list[i].url).length + ' 字节）')
        continue
      }
      const cx0 = (i % cols) * tw, cy0 = Math.floor(i / cols) * th
      fit(cx, img, cx0, cy0, tw, th)
      // 时间码：相对"现在"往前多少秒。模型靠它把一句话对到某一格画面上
      const ago = Math.round((now - list[i].t) / 1000)
      const label = ago <= 0 ? '现在' : ('-' + ago + 's')
      cx.font = '600 15px -apple-system,"Microsoft YaHei",sans-serif'
      const w = cx.measureText(label).width + 12
      cx.fillStyle = 'rgba(0,0,0,.62)'
      cx.fillRect(cx0 + 6, cy0 + th - 26, w, 20)
      cx.fillStyle = '#fff'
      cx.fillText(label, cx0 + 12, cy0 + th - 11)
    }
    return { url: cv.toDataURL('image/jpeg', 0.8), n, tw, th }
  }

  // kind = 'frames'（有画面要给她看）| 'idle'（主动搭话，画面没变、不带图）
  // 两条路都走这一个函数，共用 delivering 锁 —— 这就是"撞车时合并成一次"的落点：
  // 上一轮还在路上时，主动搭话这一步会被直接跳过，等下一轮；绝不开第二条通道。
  async function deliver(kind) {
    if (delivering) return
    const idle = kind === 'idle'
    if (!idle && !kept.length) return
    delivering = true
    const token=generation
    const batch = idle ? [] : kept
    kept = []
    const now = Date.now()
    lastDeliverAt = now
    resetChatTimer()          // 无论哪种唤醒，都把主动搭话的倒计时重新摇一次
    const spanSec = batch.length ? Math.round((now - batch[0].t) / 1000) : 0
    let sheet = null
    if (!idle) {
      const r = await compose(batch, now).catch((e) => { P.log && P.log('陪看：拼图失败 ' + e.message); return null })
      if (!r) { delivering = false; return }
      sheet = r.url
    }
    if(token!==generation||!wantOn){return}
    delivered++
    badgeSet('陪看中 · 她在看', '#a5b4fc')
    P.watchSheet({
      sheet, sessionVersion:cfg.sessionVersion, capturedAt:batch.at(-1)?.t || now,
      textOnly: idle,
      // 主动模式：这张图是「刚刚现抓的现在」，不是「画面变化的几个瞬间」——
      // 模块要靠这个标记换一套提示词（不然她会把一张现抓的静态图当成变化拼图去解说）
      active: cfg.mode === 'active',
      tiles: batch.map((x) => ({ ago: Math.round((now - x.t) / 1000), score: x.score })),
      spanSec,
      level: batch.length ? batch.reduce((a, x) => a + x.score, 0) / batch.length : 0,
      quiet: spanSec > cfg.paceSec * 3,
    }).then((res) => {
      if(token!==generation||!wantOn)return
      if(res?.ok===false&&!res.busy)badgeSet(res.visionUnsupported?'模型不支持看图':'画面提交失败','#f87171')
    }).catch((e) => { P.log && P.log('陪看：交付失败 ' + ((e && e.message) || e)) })
      .finally(() => {
        if(token===generation)delivering = false
      })
  }

  // ---- 台词（第 4b 期）：抓「电脑正在放什么」，不是麦克风 ----
  // 图只能说明画面，说明不了他们在说什么。这一路专门收系统声音，切成句，
  // 转成文字后存到模块那边；下一张图交付时把这段时间的台词一并带上。
  // 阈值比电话高得多：视频里有 BGM，整段都"响"，按电话那套门限会切出一堆碎块。
  let actx = null, anode = null
  let lphase = 'idle', lbuf = [], llen = 0, lnoise = 0.002, lquiet = 0, lprev = null
  let linesSent = 0

  function rms(d) {
    let s = 0
    for (let i = 0; i < d.length; i++) s += d[i] * d[i]
    return Math.sqrt(s / d.length)
  }
  function merge(list) {
    let n = 0
    for (const c of list) n += c.length
    const out = new Float32Array(n)
    let o = 0
    for (const c of list) { out.set(c, o); o += c.length }
    return out
  }
  const petPlaying = () => !!(window.petAudio && window.petAudio.playing && window.petAudio.playing())

  function onLoud(d) {
    if (!running) return
    const r = rms(d)
    // 她自己说话时扬声器在响，回环会把她的话收回来当成"视频里说的" —— 整段丢弃。
    if (petPlaying()) { lphase = 'idle'; lbuf = []; llen = 0; lprev = null; return }
    const gate = Math.max(0.012, lnoise * 2.5)
    if (lphase === 'idle') {
      if (r < gate) lnoise = lnoise * 0.98 + r * 0.02
      const keep = lprev
      lprev = new Float32Array(d)
      if (r >= gate) {
        lbuf = keep ? [keep, lprev] : [lprev]   // 补回一帧，别吃掉第一个字
        llen = lbuf.reduce((n, x) => n + x.length, 0)
        lphase = 'speech'
        lquiet = 0
        lprev = null
      }
      return
    }
    lbuf.push(new Float32Array(d))
    llen += d.length
    lquiet = r < gate * 0.6 ? lquiet + 1 : 0
    // 说完 3 帧（约 0.4 秒）就断句；连续说话最长 5 秒硬切，免得一整段 BGM 攒成一句
    if (lquiet >= 3 || llen >= 16000 * 5) flushLine()
  }

  function flushLine() {
    const pcm = merge(lbuf)
    lbuf = []; llen = 0; lphase = 'idle'; lquiet = 0
    const ms = Math.round(pcm.length / 16)
    if (!running || ms < 900) return
    linesSent++
    P.watchLine({ pcm, ms,sessionVersion:cfg.sessionVersion }).catch(() => {})
  }

  function startListen(track) {
    if (!track || cfg.listen === false) return
    try {
      actx = new AudioContext({ sampleRate: 16000 })
      const src = actx.createMediaStreamSource(new MediaStream([track]))
      anode = actx.createScriptProcessor(2048, 1, 1)
      anode.onaudioprocess = (ev) => onLoud(ev.inputBuffer.getChannelData(0))
      src.connect(anode)
      anode.connect(actx.destination)
      P.log && P.log('陪看：系统声音已接上（听得见视频里在说什么）')
    } catch (e) {
      P.log && P.log('陪看：系统声音没接上（只陪看画面）' + ((e && e.message) || e))
    }
  }
  function stopListen() {
    try { anode && (anode.onaudioprocess = null) } catch {}
    try { anode && anode.disconnect() } catch {}
    try { actx && actx.close() } catch {}
    anode = null; actx = null; lbuf = []; llen = 0; lphase = 'idle'; lprev = null
  }

  // ---- 开关 ----
  async function start(isRetry = false) {
    wantOn = true
    if (running || starting) return {ok:true, phase}
    if(!isRetry){retries=0;clearTimeout(retryTimer);retryTimer=null}
    const token=generation
    starting=true;stage='capture-audio-video';report('preparing',null)
    let acquired=null, element=null
    const current=()=>wantOn&&token===generation
    const discard=()=>{try{acquired?.getTracks().forEach(t=>t.stop());element?.remove()}catch{}}
    try {
      if(isRetry&&retries>=2&&P.watchSnapshot){await startSnapshots(token);return {ok:true,phase:'running',backend:'snapshot'}}
      backend='video'
      const constraints={frameRate:{ideal:10}}
      try{acquired=await navigator.mediaDevices.getDisplayMedia({video:constraints,audio:cfg.listen!==false})}
      catch(error){
        if(!current())return {ok:false,cancelled:true}
        const recoverable=['NotReadableError','AbortError'].includes(error.name)||/Could not start audio source/i.test(error.message)
        if(cfg.listen===false||!recoverable)throw error
        P.log?.('陪看：回环采集未启动，尝试仅画面',JSON.stringify({name:error.name,stage}))
        stage='capture-video-only'
        acquired=await navigator.mediaDevices.getDisplayMedia({video:constraints,audio:false})
      }
      if(!current()){discard();return {ok:false,cancelled:true}}
      element=document.createElement('video');element.srcObject=acquired;element.muted=true
      element.setAttribute('playsinline','')
      element.style.cssText='position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1'
      document.body.appendChild(element)
      stage='video-play';await element.play()
      for(let i=0;i<60&&current()&&(element.readyState<2||!element.videoWidth||!element.videoHeight);i++)await new Promise(r=>setTimeout(r,50))
      if(!current()){discard();return {ok:false,cancelled:true}}
      if(element.readyState<2||!element.videoWidth||!element.videoHeight)throw Error('等待有效视频帧超时')
      stream=acquired;video=element
      ;[scoreCv,scoreCx]=makeCanvas(GW,GH)
      ;[tileCv,tileCx]=makeCanvas(SHEET_W,SHEET_H)
      stage='first-frame';scoreCx.drawImage(video,0,0,GW,GH);scoreCx.getImageData(0,0,GW,GH)
      mask=await refreshMask()
      if(!current()){discard();return {ok:false,cancelled:true}}
      prev=null;acc=0;kept=[];lastMediaTime=video.currentTime;lastFrameAt=Date.now()
      lastDeliverAt=Date.now();lastChangeAt=Date.now();idleLoggedAt=Date.now();resetChatTimer()
      running=true
      const track=stream.getVideoTracks()[0]
      if(!track)throw Error('没有视频轨道')
      track.addEventListener('ended',()=>{if(current()){stage='video-track-ended';fail(Error('视频轨道已结束'),token)}},{once:true})
      const audio=stream.getAudioTracks();if(audio.length)startListen(audio[0])
      report('running',null);badgeSet('陪看中','#7dd3fc')
      P.log?.('陪看采集就绪',JSON.stringify({width:video.videoWidth,height:video.videoHeight,audio:audio.length,mode:cfg.mode}))
      sampleTimer=setInterval(sample,SAMPLE_MS)
      return {ok:true,phase:'running'}
    }catch(error){discard();if(current())fail(error,token);return {ok:false,message:String(error.message)}}
    finally{if(token===generation)starting=false}
  }

  async function snapshot(token) {
    if(snapshotBusy || token!==generation || !wantOn)return
    snapshotBusy=true
    try{
      const frame=await P.watchSnapshot({sessionVersion:cfg.sessionVersion})
      if(token!==generation||!wantOn)return
      if(!frame?.ok||!frame.base64)throw Object.assign(Error(frame?.message||'单帧抓屏失败'),{name:frame?.name||'CaptureError'})
      const image=new Image();image.src='data:'+frame.mediaType+';base64,'+frame.base64
      await image.decode()
      if(token!==generation||!wantOn)return
      image.videoWidth=frame.w;image.videoHeight=frame.h;image.currentTime=Date.now();image.readyState=3
      video=image;lastFrameAt=Date.now()
      if(!running){
        ;[scoreCv,scoreCx]=makeCanvas(GW,GH);[tileCv,tileCx]=makeCanvas(SHEET_W,SHEET_H)
        scoreCx.drawImage(video,0,0,GW,GH);scoreCx.getImageData(0,0,GW,GH)
        running=true;prev=null;kept=[];lastDeliverAt=Date.now();resetChatTimer()
        sampleTimer=setInterval(sample,SAMPLE_MS)
      }
      report('running',null);badgeSet('陪看中 · 纯画面','#7dd3fc')
    }finally{if(token===generation)snapshotBusy=false}
  }
  async function startSnapshots(token){
    backend='snapshot';stage='snapshot';releaseCapture()
    await snapshot(token)
    if(token!==generation||!wantOn)return
    P.log?.('陪看：视频流未启动，使用已有单次截图通道，每 1.5 秒更新，仅画面')
    snapshotTimer=setInterval(()=>snapshot(token).catch(error=>{stage='snapshot';fail(error,token)}),1500)
  }
  function releaseCapture() {
    clearInterval(snapshotTimer);snapshotTimer=null;snapshotBusy=false
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null }
    stopListen()
    try { stream && stream.getTracks().forEach((t) => t.stop()) } catch {}
    try { video && video.remove() } catch {}
    stream = null; video = null; kept = []; prev = null
    badgeSet(null)
  }

  function stop() {
    wantOn=false;generation++;starting=false;running=false;delivering=false
    clearTimeout(retryTimer);retryTimer=null
    releaseCapture();lastFrameAt=0
    window.petAudio?.cancelWatch?.()
    report('stopped',null)

    return { ok: true }
  }

  // 桌宠自己那块矩形：算变化分时挖掉，不然气泡一开一合就是一次"变化"
  async function refreshMask() {
    try {
      const m = await P.watchMask()
      if (!m || !m.screen || !m.screen.w) return null
      const r = m.rect || {}
      return {
        x0: (r.x || 0) / m.screen.w,
        y0: (r.y || 0) / m.screen.h,
        x1: ((r.x || 0) + (r.w || 0)) / m.screen.w,
        y1: ((r.y || 0) + (r.h || 0)) / m.screen.h,
      }
    } catch { return null }
  }
  setInterval(() => { if (running) refreshMask().then((m) => { mask = m }) }, 5000)

  P.onWatchCtl((d) => {
    const a = String((d && d.action) || '')
    if (a === 'start') start()
    else if (a === 'stop') stop()
  })
  P.onWatchConfig && P.onWatchConfig((d) => {
    if (!d) return
    const changed = cfg.sessionVersion !== d.sessionVersion
    const prevCall = !!cfg.callOn
    const prevPro = !!cfg.proactive
    if(changed)stop()
    cfg = { ...cfg, ...d }
    if(changed&&cfg.on)start()
    // 电话刚接通 / 刚挂断、或刚打开主动搭话：重新摇倒计时。
    // 不然会出现「挂断那一刻正好到点」→ 她立刻没头没脑说一句。
    if (prevCall !== !!cfg.callOn || prevPro !== !!cfg.proactive) resetChatTimer()
  })
  P.watchConfig && P.watchConfig().then((d) => {
    if (!d) return
    cfg = { ...cfg, ...d }
    resetChatTimer()
    if (d.on) start()   // 开机时电话/陪看是开着的，页面加载完要自己接通
  }).catch(() => {})

  window.__watch = {
    start, stop,
    state: () => ({ running, phase, lastFrameAt, retries, generation, kept: kept.length, acc: Math.round(acc), delivered, mask, nextChatIn: Math.round((nextChatAt - Date.now()) / 1000), callOn: !!cfg.callOn }),
    tick: () => sample(),                          // 调试：不用等定时器
    idle: () => deliver('idle'),                   // 调试：手动触发一次「主动搭话」（不等随机区间）
    fake: () => { kept.push({ url: tileCv.toDataURL('image/jpeg', 0.8), t: Date.now(), score: 99 }); deliver() },
  }
  window.addEventListener('beforeunload',stop)
  P.log && P.log('陪看（渲染页）已就绪')
})()
