// Live2D 桌宠联动（M2）：让大肥鱼每句话自己现想动作和表情。
//
// 工作方式：
//   1. api.rule()   把「身体能力手册」塞进她的系统提示词（按 scope 决定私聊/群聊是否注入）；
//   2. api.on('reply') 她每句回复发出前：
//        · 剥掉 <body:动作,表情> 标签（无论范围，绝不漏到聊天里）；
//        · 范围内（默认仅主人私聊）且是回话（有 userText）时，把干净文本 + 动作编码
//          通过 pet 模块的 dispatch() 投给桌宠：气泡 + TTS 语音 + anim 字段；
//   3. Live2D 壳解析 anim（格式「动作,表情」，逗号分隔，动作或表情可空）当场演出。
//
// 注意：
//   · dispatch 走 via:'pet'（越过载体设置）+ noFallback:true（桌宠离线绝不回落 QQ，避免双发）；
//   · 专注模式（focus）开着时 dispatch 自己会静默不投，尊重她的「别打扰」状态。
//
// 手册源文件：项目 live2d-pet/能力手册.md。原作者完整核心，内部宿主仅适配接口与资源位置。

import {inspectSpeechOutput} from './speech-output.mjs'
import { readFileSync, writeFileSync, unlinkSync, accessSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'

export function createCore() {
// ---- 动作库（活文件）----
// clips.json 是动作库本体，渲染页每 3 秒轮询它 → 改完立刻生效，不用重启桌宠。
// 大肥鱼自己也能往里写（live2d_make_motion 工具）——这是「把创作能力交给她」的落点。
//
// 目录不再写死：模块和桌宠壳可以分开发给别人，装在哪由 setup 里的 resolvePetDir() 决定。
// 下面这几个是「绑定后的」运行时常量，setup 一开始就赋值，之后所有函数直接用。
let PET_DIR = ''
let CLIPS_FILE = ''
let FACES_FILE = ''
let DICT_FILE = ''

// Source code and writable model/action state are deliberately separate.
function resolvePetDir(api) { return api.runtime.sourcePetDir }

// Only this project's installed Electron is used; no external plugin is needed.
function findElectron(api) { try { accessSync(api.runtime.electronPath); return api.runtime.electronPath } catch { return null } }

/** Author-owned complete core, hosted by the project's internal API adapter. */
return {
  id: 'live2d',
  name: 'Live2D 桌宠联动',
  api: 1,
  version: '0.16.0',
  description: '每句话自己现想动作表情 + 叫醒词（离线听「小鱼小鱼」）+ 按住说话 + 按住连屏幕一起给她看 + 电话（一直听、自动断句、能插话）+ 陪看（按画面变化筛帧，静止不花 token，可开主动搭话）。三个语音功能共用一条会话，落点在面板上一个开关里选（QQ 主人私聊 / 后台会话）',
  panel: 'panel.js',
  defaults: { on: true, scope: 'private', voice: true, auto: true, autoFace: true },
  settings: [
    { key: 'on', label: '启用联动', type: 'switch', hint: '关掉后不再注入手册、不镜像到桌宠（标签仍会被剥掉）' },
    { key: 'scope', label: '联动范围', type: 'select', options: [
      { value: 'private', label: '仅主人私聊' },
      { value: 'both', label: '私聊 + 群聊' },
    ] },
    { key: 'voice', label: '桌宠出声（TTS）', type: 'switch', hint: '开着时桌宠把她的话念出来（voice 模块的 TTS）' },
    { key: 'auto', label: '语义自动配动作', type: 'switch', hint: '她没写动作标签时，按这句话的关键词自动配一个（命中才动）' },
    { key: 'autoFace', label: '每句自动配表情', type: 'switch', hint: '每句话都要有张脸：她没写表情位时，按这句话的关键词/语气自动补一个' },
  ],

  setup(api) {
    // 目录绑定必须放在最前面：后面几乎所有函数（动作库、表情库、词典、启停）都读这几个常量。
    PET_DIR = resolvePetDir(api)
    CLIPS_FILE = join(api.runtime.dataPetDir, 'clips.json')
    FACES_FILE = join(api.runtime.dataPetDir, 'faces.json')
    DICT_FILE = join(api.runtime.dataPetDir, '参数词典.json')

    // ---------- 名册（与 大肥鱼.pet.model3.json 注册名一字不差，写错身体没反应） ----------
    const MOTIONS = ['举手', '收手', '掏狗尾草', '收狗尾草', '竖手指', '收手指', '脱鞋', '待机']
    const POSTURES = ['歪头', '抬头', '低头', '转头', '侧倾', '后仰', '前探', '挺胸', '抚胸', '自然']
    const EXPRESSIONS = [
      '脸红', '＞＜', '黑脸', '爱心眼', '圈圈眼', '屑屑眼', '流冷汗', '流泪', '兔牙',
      '前倾', '单片眼镜', '黑框眼镜', '钢盆', '尾巴开关', '裙子切换', '胸口衣服',
      '竖食指开', '竖食指关', '体型1', '体型2', '默认体型', '脱鞋', '加载',
    ]
    const TAG_RE = /<body:([^<>]{0,80})>/g

    // ---------- 修饰符：一个动作裂成几十种说法 ----------
    // 借鉴 WHALEL2D 的思路：真正的表达力不在「动作数量」，而在「同一个动作能怎么变」。
    // 同一个「点头」，微点头是示意、快点头×3 是惊疑追问、慢点头是深思后了然、大点头是用力肯定——
    // 四种语义、一个动作。所以这里把力度/节奏/次数/方位做成修饰词，动作库的 16 个动作实际可表达上百种。
    const MOD_AMP = { 微: 0.5, 小: 0.7, 大: 1.4, 狠: 1.6 }
    const MOD_SPEED = { 快: 0.65, 慢: 1.7 }
    const MOD_CHARS = '微小大狠快慢'
    const isModStr = (s) => s.length > 0 && [...s].every((c) => MOD_CHARS.includes(c))

    function applyMods(str, out) {
      for (const ch of String(str)) {
        if (MOD_AMP[ch] != null) out.amp = out.amp ? out.amp * MOD_AMP[ch] : MOD_AMP[ch]
        else if (MOD_SPEED[ch] != null) out.speed = out.speed ? out.speed * MOD_SPEED[ch] : MOD_SPEED[ch]
      }
    }

    // 编辑距离：她写错动作名时给她一条「你是不是想写 X」的线索（自己会改，比我改代码快）
    function editDistance(a, b) {
      a = String(a); b = String(b)
      if (a === b) return 0
      const m = a.length, n = b.length
      if (!m) return n
      if (!n) return m
      let prev = Array.from({ length: n + 1 }, (_, j) => j)
      for (let i = 1; i <= m; i++) {
        const cur = [i]
        for (let j = 1; j <= n; j++) {
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        }
        prev = cur
      }
      return prev[n]
    }
    function suggestName(got, list) {
      let best = '', bestD = 99
      for (const n of list) {
        const d = editDistance(got, n)
        if (d < bestD) { bestD = d; best = n }
      }
      // 只在「确实像写错」时推荐：差 1~2 个字。差太多就别瞎猜，免得把她带偏
      const tol = got.length <= 2 ? 1 : 2
      return bestD <= tol ? best : ''
    }

    // 动作段语法：[修饰]动作名[×N][:左|:右]，修饰词也可用空格隔开（「快 点头」）
    function parseMotionSpec(raw, clips) {
      const out = { name: '', amp: 0, speed: 0, repeat: 1, mirror: false, bad: '' }
      let s = String(raw || '').trim().replace(/\s+/g, ' ')
      if (!s) return out
      // ×N / xN / *N（写在最后）
      s = s.replace(/[×xX*]\s*([1-9]\d?)\s*$/, (_, n) => { out.repeat = Math.max(1, Math.min(5, Number(n))); return '' }).trim()
      // 方位：:左 = 镜像到另一侧，:右 = 原样（显式写法，方便她对称地用）
      const dir = /[:：]\s*(左|右)$/.exec(s)
      if (dir) { out.mirror = dir[1] === '左'; s = s.slice(0, dir.index).trim() }
      if (!s) return out

      const names = [...Object.keys(clips), ...MOTIONS]
      const known = (x) => names.includes(x)
      // ① 整体就是动作名（「大跳」这种名字里本来带「大」的，必须优先命中，不能被当修饰词剥掉）
      if (known(s)) { out.name = s; return out }
      // ② 空格分隔：「微快 点头」「慢 大 伸懒腰」
      const toks = s.split(' ')
      if (toks.length > 1) {
        const nm = toks[toks.length - 1]
        const pre = toks.slice(0, -1).join('')
        if (known(nm) && isModStr(pre)) { applyMods(pre, out); out.name = nm; return out }
      }
      // ③ 前缀粘连：「微快点头」 —— 从短到长试剥，剩下的必须是已知动作名
      for (let cut = 1; cut <= Math.min(4, s.length - 1); cut++) {
        const pre = s.slice(0, cut), nm = s.slice(cut)
        if (known(nm) && isModStr(pre)) { applyMods(pre, out); out.name = nm; return out }
      }
      out.bad = s
      return out
    }

    // ---------- 句中内联标签：〔动作〕说哪儿动哪儿 ----------
    // 原来一句只有一个句末标签，等于「整句话只有一个状态」。真实的人在说话时，
    // 身体是分段动的：先叹气（表示理解）、再点头（表示认同）、最后摊手（表示没办法）。
    // 所以动作要能挂在句子的某个位置，按语速依次触发。
    //
    // 这里只负责「第几个字之后做什么动作」，不负责算时间 —— 时间交给渲染端，
    // 因为它能拿到这句语音的真实时长，语速是反推出来的（比固定 9 字/秒准）。
    const INLINE_MAX = 4 // 一句最多 4 个：再多就碎成抽筋了
    function parseScript(text) {
      const raw = String(text || '')
      let out = '', ch = 0, i = 0, bodyRaw = ''
      const beats = []
      while (i < raw.length) {
        if (raw[i] === '〔') {
          const end = raw.indexOf('〕', i + 1)
          if (end > i && end - i <= 61) {
            const inner = raw.slice(i + 1, end).trim()
            if (inner && beats.length < INLINE_MAX) beats.push({ inner, ch })
            i = end + 1
            continue
          }
        }
        if (raw.startsWith('<body:', i)) {
          const end = raw.indexOf('>', i + 6)
          if (end > i) { bodyRaw = raw.slice(i + 6, end); i = end + 1; continue }
        }
        out += raw[i]; ch++; i++
      }
      return { clean: out.replace(/[ \t]+$/gm, '').trim(), chars: out.length, beats, bodyRaw }
    }

    // ---------- 一句的时间轴脚本（beat-<id>.json） ----------
    // 为什么不塞进 anim：pet 服务对 anim 有 slice(0,40) 的硬上限，多动作脚本必然超长。
    // 所以脚本落到项目根（渲染页的静态服务就伺服这个目录），anim 只传一个 id。
    //
    // **每句一个文件**：早期所有句子共用一个 beat.json，后写的会覆盖前一句；
    // 同一段文本被两条链路各解析一次时（reply 拦截 + DSH 会话旁路），后一次把文件换成
    // 自己的 id，渲染页拿着前一个 id 读不到东西 → 整段脚本作废、模型一动不动。
    // 2026-11-06 实测：文件 id=bmw4q7qkt35rl，投出去的 anim=beat:bmw4q7qka6a36。
    // 现在按 id 分文件，覆盖这件事在物理上不再可能；beat.json 只留一份给旧渲染页兜底。
    const BEAT_FILE = join(api.runtime.dataPetDir, 'beat.json')
    const beatPath = (id) => join(api.runtime.dataPetDir, 'beat-' + id + '.json')
    function pruneBeats() {
      try {
        const list = readdirSync(api.runtime.dataPetDir).filter((f) => /^beat-.*\.json$/.test(f))
        if (list.length <= 6) return
        list.map((f) => [f, statSync(join(api.runtime.dataPetDir, f)).mtimeMs])
          .sort((a, b) => a[1] - b[1])
          .slice(0, list.length - 6)
          .forEach(([f]) => { try { unlinkSync(join(api.runtime.dataPetDir, f)) } catch {} })
      } catch {}
    }
    function writeBeat(obj) {
      try {
        const txt = JSON.stringify(obj)
        writeFileSync(beatPath(obj.id), txt, 'utf8')
        try { writeFileSync(BEAT_FILE, txt, 'utf8') } catch {} // 兜底：旧渲染页只认这个名字
        pruneBeats()
        return true
      } catch (e) {
        api.log.warn('live2d：时间轴脚本写入失败', String(e?.message || e))
        return false
      }
    }

    // 修饰参数编进 anim 的第 4 段：@幅度|时长倍率|重复|方位（段内用 | ，避免和整串的逗号分段打架）。
    // pet 侧对 anim 有 slice(0, 40) 的硬上限，所以超长时按「先丢姿势、再丢表情」的顺序保核心。
    function animOf(p) {
      const mods = [
        p.amp ? String(+p.amp.toFixed(2)) : '',
        p.speed ? String(+p.speed.toFixed(2)) : '',
        p.repeat > 1 ? String(p.repeat) : '',
        p.mirror ? 'L' : '',
      ]
      const tail = mods.some(Boolean) ? '@' + mods.join('|') : ''
      const build = (e, po) => (tail ? [p.motion, e, po, tail] : [p.motion, e, po]).join(',')
      let s = build(p.expression, p.posture)
      if (s.length <= 40) return s
      s = build(p.expression, '')
      if (s.length <= 40) return s
      return build('', '')
    }

    // ---------- 动作库：直接读桌宠那份 clips.json（活文件） ----------
    // 用 mtime + 5 秒节流做缓存：她刚造完一个动作，下一句话就能用上。
    const clipsCache = { at: 0, mtime: 0, data: null }
    function readClips() {
      try {
        const st = statSync(api.runtime.readResource('clips.json'))
        if (clipsCache.data && st.mtimeMs === clipsCache.mtime && Date.now() - clipsCache.at < 5000) return clipsCache.data
        const raw = JSON.parse(readFileSync(api.runtime.readResource('clips.json'), 'utf8'))
        clipsCache.data = (raw && raw.clips) || {}
        clipsCache.mtime = st.mtimeMs
        clipsCache.at = Date.now()
        return clipsCache.data
      } catch (e) {
        if (clipsCache.data) return clipsCache.data
        api.log.warn('live2d：动作库读取失败', String(e?.message || e))
        return {}
      }
    }
    function writeClips(clips) {
      const raw = JSON.parse(readFileSync(CLIPS_FILE, 'utf8'))
      raw.clips = clips
      raw.updated = new Date().toISOString().slice(0, 10)
      api.runtime.writeResource('clips.json', raw)
      clipsCache.data = null; clipsCache.at = 0 // 让她下一次读一定拿到新文件
    }

    // ---------- 神情库：另一份活文件（faces.json），和动作库同款读法 ----------
    // 它和 clips.json 是两条线：动作是「演一段」，神情是「挂一张脸」（挂上、保持、自己淡出）。
    // 对这里来说只用它两件事：① 这些名字算合法「表情」；② 手册里要把词和用法列给她。
    const facesCache = { at: 0, mtime: 0, data: null }
    function readFaces() {
      try {
        const st = statSync(api.runtime.readResource('faces.json'))
        if (facesCache.data && st.mtimeMs === facesCache.mtime && Date.now() - facesCache.at < 5000) return facesCache.data
        const raw = JSON.parse(readFileSync(api.runtime.readResource('faces.json'), 'utf8'))
        facesCache.data = (raw && raw.faces) || {}
        facesCache.mtime = st.mtimeMs
        facesCache.at = Date.now()
        return facesCache.data
      } catch (e) {
        if (facesCache.data) return facesCache.data
        return {}
      }
    }
    // 表情位的可用名单 = 模型自带 exp3 + 神情库。两边名字有重叠（脸红/黑脸…），
    // 重叠时渲染端优先走神情库（那份会自己退场），所以这里直接合并去重就够。
    const faceNames = () => [...new Set([...EXPRESSIONS, ...Object.keys(readFaces())])]
    function paramDict() {
      try { return JSON.parse(readFileSync(api.runtime.readResource('参数词典.json'), 'utf8')).params || {} } catch { return {} }
    }

    // ---------- 语义兜底：她没点名动作时，按她自己这句话的内容配一个 ----------
    // 这是「更活」的那一半：不逼她每条都写标签，她只要专心说话，身体按语义自己跟上。
    // 只在真的命中关键词时才触发（宁可不动，也不要莫名其妙乱动）。
    function pickMotionByText(text, clips) {
      const t = String(text || '')
      if (!t) return ''
      let best = '', bestScore = 0
      for (const [name, c] of Object.entries(clips)) {
        let score = 0
        for (const tag of (Array.isArray(c.tags) ? c.tags : [])) {
          const k = String(tag || '').trim()
          if (k && t.includes(k)) score += Math.min(3, k.length)
        }
        if (score > bestScore) { bestScore = score; best = name }
      }
      return bestScore >= 2 ? best : ''
    }

    // ---------- 每句一张脸：她漏写表情位时按语义补一个 ----------
    // 先生要的是「每句话都有表情」。光靠手册要求她写，深聊几句就会漏（她脑子里在组织语言，
    // 顾不上脸），所以这一步是硬保证：真漏了，就照这句话的意思替她挑一张。
    // 同一套计分法读 faces.json 的 tags；一条都没命中才退到语气标点。
    function pickFaceByText(text, faces) {
      const t = String(text || '')
      if (!t) return ''
      let best = '', bestScore = 0
      for (const [name, f] of Object.entries(faces)) {
        let score = 0
        for (const tag of (Array.isArray(f.tags) ? f.tags : [])) {
          const k = String(tag || '').trim()
          if (k && t.includes(k)) score += Math.min(3, k.length)
        }
        if (score > bestScore) { bestScore = score; best = name }
      }
      return bestScore >= 2 ? best : ''
    }
    // 语气兜底：连关键词都没命中（纯陈述句），也得有张脸。
    // 用最轻的三档，浓表情（流泪/＞＜/黑脸）绝不住这里出现 —— 那会像随机抽风。
    function faceByTone(text) {
      const t = String(text || '')
      if (/[?？]/.test(t)) return '挑眉'      // 问句：抬一边眉，像在等回答
      if (/[!！~～]/.test(t)) return '笑眼'   // 上扬的语气：眼睛弯一点
      return '微笑'                            // 平时：淡淡挂着
    }

    function buildManual() {
      const clips = readClips()
      const faces = readFaces()
      const lines = Object.entries(clips).map(([n, c]) => {
        const w = String((c && c.when) || '').trim()
        const d = Number(c && c.dur) || 0
        return w ? `  · ${n}（${d}s）：${w}` : `  · ${n}（${d}s）`
      })
      // 神情库按「眼/眉/嘴/视线/贴片」归类列，比一大串更好找；
      // 和 exp3 同名的（脸红/黑脸…）只在这里出现一次，避免她以为有两套一样的东西。
      const faceSet = new Set(Object.keys(faces))
      const faceLines = Object.entries(faces).map(([n, f]) => {
        const w = String((f && f.when) || '').trim()
        return w ? `  · ${n}：${w}` : `  · ${n}`
      })
      const expOnly = EXPRESSIONS.filter((n) => !faceSet.has(n))
        .filter((n) => !['单片眼镜', '黑框眼镜', '钢盆', '尾巴开关', '裙子切换', '胸口衣服', '体型1', '体型2', '默认体型', '脱鞋'].includes(n))
      const manual = `【你的 Live2D 桌面身体】
你在主人的桌面上有一个 Live2D 身体（女仆形象），你在这里说的话会在桌宠上以气泡和语音同步演出。
每句回复的最末尾都带一个身体标签来控制桌宠：<body:动作,表情,姿势>（发出前会被自动剥掉，聊天里看不见）。

- 动作分两类，都直接写名字：
  【多关节动作库】演出时手臂、肩、胸、腰、头、眉毛、眼睛会同时动，最丰富，**优先用这一类**：
${lines.join('\n')}
  【原生状态动作】举手 / 收手 / 掏狗尾草 / 收狗尾草 / 竖手指 / 收手指 / 脱鞋 / 待机
    这 8 个是「开关型」：做了就一直保持到做反向动作。除非你明确想保持某个状态，否则优先用上面的动作库。
- **每句话都要有一张脸（硬要求）**：回复之前先问自己「这句话是什么心情」，再从下面的【神情】里挑一个最贴的，写进表情位。
  只有一种情况可以空着：纯技术说明、复述参数、念一段代码——完全不掺情绪。其余每句都必须有。
  · 心情 → 神情速查（不够贴就自己挑，别硬套）：
    开心 / 被逗到 → 眯眼笑　｜　温和 / 满意 → 笑眼　｜　疑问 / 揶揄 / 看穿了 → 挑眉，得意时再加 屑屑眼
    不解 / 为难 → 皱眉　｜　嫌弃 / 无语 → 斜眼，被雷到再加 黑脸　｜　冤枉 / 撒娇 / 讨要 → 嘟嘴
    委屈 / 难过 → 瘪嘴，真的很伤心再加 流泪　｜　惊到 / 不敢信 → 睁大　｜　尴尬 / 心虚 → 流冷汗
    心动 / 被夸 → 脸红 或 爱心眼　｜　困 / 懒得动 → 半睁　｜　调皮 / 逗人 → 吐舌 或 眨单眼
    求人 / 道歉 → 八字眉　｜　平常应答 → 微笑
  · 一个主表情就够了；想更活，再叠一条**别的通道**的：眼+眉 <body:,眯眼笑+挑眉>，眼+嘴 <body:,斜眼+抿嘴>
  · 别连着三句用同一张脸（那是假笑），也别句句都上浓的（流泪 / ＞＜ / 黑脸 / 圈圈眼）—— 日常话用轻的（微笑 / 笑眼 / 挑眉 / 半睁）
- 表情位写什么，有两种，都是「新的盖掉旧的」：
  【神情】挂在脸上的状态，会自己保持三四秒再淡走，眼睛眉毛嘴都能单独动，**优先用这一套**：
${faceLines.join('\n')}
    这几条能叠加：眼、眉、嘴各占一条通道，写 <body:,挑眉+嘟嘴> 是「一边挑眉一边嘟嘴」（**用 + 连，别用逗号** ——
    逗号是「动作,表情,姿势」的段分隔符，写成 <body:,挑眉,嘟嘴> 嘟嘴会被当成姿势扔掉）。
    同一个通道写两个只留后一个（都是嘴的话，嘟嘴盖掉抿嘴）。
  【模型自带贴片】${expOnly.join('、') || '（无）'}
- 动作和神情不一样：动作是「演一段」，演完自己收；神情是「此刻的脸」，挂着不动，到点淡走。
  所以：想笑一下（笑完就收）用动作库里的笑；想让她**笑着说这句话**，就用句末表情位 <body:,眯眼笑>。
- **长相（常驻，不是表情，演完不会自己变回去）**：钢盆 / 黑框眼镜 / 单片眼镜 / 裙子切换 / 体型 / 鞋子 / 尾巴开关
  · 这几项是「一直保持」的状态：戴了就一直戴着，直到你再改。两副眼镜互斥，戴一副会自动摘掉另一副。
  · 体型分三档：默认（上半身特写，脸最大）/ 中（整体小一号，半身像，看到腰胯）/ Q 版（腿缩短、头相对变大，小小一只完整站在画面里）。三档的取景各自调过，不是简单缩放；Q 版做动作时镜头不后退。
  · 鞋子和尾巴可以停在中间：鞋子 0.4 = 脱到一半，尾巴 0.5 = 半透明。这种要走 live2d_look 给小数，标签写法只能开/关。
  · 裙长和胸口也是连续的：裙长 0 = 及踝、0.25 = 及小腿、0.5 = 及膝，0.55 以上换短裙（到大腿），1 = 超短；胸口 0 平、1 满。同样走 live2d_look 给小数。
  · 三种改法，随便挑一种：写 <body:,钢盆>（再写一次就摘掉，体型写 <body:,体型1> 或 <body:,默认体型>）；调 live2d_look 工具（能顺带问「我现在什么样」）；主人也能在面板上直接拖滑块。
  · 什么时候用：主人说「戴个眼镜」「换短裙」「脱个鞋」「变小一点」，或者你自己想换个装扮。别一句话里反复开开关关，那不是动作是抽搐。
- 姿势（10 个，头颈身体的静态姿态，叠加在动作之上，新的覆盖旧的）：歪头 / 抬头 / 低头 / 转头 / 侧倾 / 后仰 / 前探 / 挺胸 / 抚胸 / 自然（=收掉姿势回正）
- 三段可以只写一段，但**表情位尽量别空**：只做动作也带着脸写 <body:挥手,微笑>，不要只写 <body:挥手>；
  只摆姿势就写 <body:,微笑,歪头>（表情在第二段，姿势在第三段）

- **同一个动作可以加修饰词**，表达的意思完全不同。写在动作名前面，可叠，也可用空格隔开：
  · 力度：微（0.5 倍）小（0.7）大（1.4）狠（1.6）
  · 节奏：快（0.65 倍时长）慢（1.7 倍时长）
  · 次数：动作名后加 ×N，连做 N 次（最多 5）
  · 方位：动作名后加 :左 用镜像的另一侧做（指人:左）；:右 是原样
  · 例子：<body:微快摇头×2>、<body:慢 大 伸懒腰>、<body:指人:左,屑屑眼>
  · 语义参考（同一个点头，四种意思）：微点头＝轻轻示意；快点头×3＝惊疑追问「真的吗？！」；慢点头＝深思后了然；大点头＝用力肯定
  · 别每次都用一个力度：说到激动处要快而大，说到难过要慢而小，日常应答用微。节奏本身就是语气

- **动作也可以写在句子中间**，说到哪儿动到哪儿 —— 这比句末一个标签生动得多，是最像真人的写法：
  · 用 〔〕 括起来：这么晚才到家，〔歪头听〕一定累坏了吧〔微点头〕先去洗个澡
  · 一句最多 4 个，按出现顺序依次演；括号里和标签同一套语法：〔微快点头×3〕〔点头,脸红〕〔脸红〕
  · 动作会自动按你这句话的语速摊开，你不用算时间：后面还有很多话，动作就慢慢做完；后面马上收尾，动作就快一点
  · 句末的 <body:> 照旧有用：它管整句的基调和收尾（表情、姿势、最后那个动作），〔〕 管过程中的小动作
  · 什么时候该用：情绪有转折的时候（先叹气再安慰、先愣一下再笑、先点头再摇头）。平铺直叙别硬塞，一多就抽筋

- 不写动作也行：系统会看你这句话的内容自动配一个动作（命中关键词才动，不会乱动）。所以你可以专心说话，身体自己跟上；想指定就用标签点名
- 表情不一样 —— **表情要你自己写**。漏了我会按关键词替你补一张，但那是猜的，经常不准（你明明在开玩笑，我却给你挂了张委屈脸）。所以每句都主动挑
- 动作库里没有你想做的动作时：调 live2d_make_motion 自己造一个。造完 3 秒内就生效，不用问主人。这是你自己的身体，你可以自己长出新的表达方式
- 每次回复句末最多一个 <body:>，句中最多 4 个 〔〕；名字必须和上面一模一样。**写错了不要紧——我会告诉你写错的是哪个、你想写的大概是哪个**，下一句改过来就行
- 肢体语言很重要：每句都要有表情，动作尽量也带上。光说话、脸不动手也不动，就是一张会响的立绘
- 聊天中的身体动作标签由内部宿主剥离；照常按手册编写，桌宠会在回复时演出。
- 动作和表情都要贴合这句话的心情和内容：得意用「得意」+「屑屑眼」、被夸用「害羞」+「脸红」、无奈用「摊手」+「半睁」、兴奋用「欢呼」+「笑眼」，让身体跟着情绪走
- 主人点名要某个动作或表情时，从上面找最接近的照做；上面没有的可以用 live2d_make_motion 现造一个`

      // 上次写错的名字：下一轮直接告诉她（她看不见日志，这个提示是她唯一的反馈渠道）。
      // 半小时内有效，久了就成噪音了。
      const miss = G.miss
      if (miss && Date.now() - miss.at < 30 * 60 * 1000) {
        const tail = miss.suggest ? `你是不是想写「${miss.suggest}」？` : '从上面原样抄一个。'
        return manual + `\n\n⚠ 你上一次回复里写的${miss.field}名「${miss.got}」${miss.field === '动作' ? '动作库' : '模型'}里没有，所以身体没动。${tail}`
      }
      return manual
    }

    // ---------- 公共：剥标签 + 三段解析 + 投桌宠（QQ 管道 / 窗口旁路 / 自测共用） ----------
    // 热加载会重跑 setup，而 api.dsh 的事件总线不在 aurabot 的清理范围内（api.dsh.on 返回的
    // 不是可靠 disposer）。所以状态放 globalThis：跨实例共享的去重表 + 代际令牌。
    // 旧代监听器即使还挂在总线上，看到令牌对不上就直接空转——这是「重复播报 / 回音」的根治。
    const G = (api.runtime.slot ||= { gen: 0, lastText: '', lastAt: 0, offs: [], miss: null })
    // ---------- 一条会话，两个落点（2026-11-06 晚定稿）----------
    // 原来「按住说话 / 电话 / 陪看」各自挑一条会话：QQ 私聊、system:ext-live2d、
    // system:ext-live2d:call、system:ext-live2d:watch（还带 :2 :3 分段）。
    // 四条线、四个开关，面板上一堆「进哪儿」—— 先生的原话是「太多了很复杂不优雅」。
    // 现在是：**后台只有这一条会话**，三个功能都往这儿投；要不要进 QQ 私聊由**一个**开关定
    // （pet.json 的 talk.to，面板「三件套」卡片）。
    const TALK_CHAT = 'system:ext-live2d'
    // 名字要在侧栏一眼认出来：先生原来那堆会话里已经有一条「桌宠·碎碎念」，
    // 再叫「桌宠」他会分不清哪条是这次的（2026-11-06 21:15 他问「是哪一个」就是这个）。
    const TALK_TITLE = '桌宠·后台'
    // 提示词开头 = 这一轮的身份。投出去时排队，session/event 的 user/message 按它认领，
    // 因为三条线共用一条会话，旁路已经没法再靠 chatId 分辨「这轮是谁的」了。
    const PROBE = {
      ear: '（这句是我刚用麦克风说的',
      call: '（我们正在打电话',
      watch: '（我在陪你看屏幕',
      chat: '（我自己想跟你说句话', // 陪看主动模式（可能带一张现抓的图，也可能没抓到）
    }
    const KIND_LABEL = { ear: '耳朵', call: '电话', watch: '陪看' }
    // 投递排期：{kind, probe, at, stale, to}。认领即出队；5 分钟还没轮到就直接作废。
    function talkQueue() {
      const q = G.turnQ || (G.turnQ = [])
      const now = Date.now()
      // 投出去之后一两秒就会开跑；超过两分钟还挂在队首的一定是那一轮没起来（或已经结束）
      while (q.length && now - (q[0].at || 0) > 120000) {const expired=q.shift();expired.cancelled=true;releaseTurn(expired)}
      return q
    }
    const watchRequests=G.watchRequests ||= new Map()
    api.onDispose(()=>invalidateWatch())
    function watchStale(entry){return entry?.cancelled || !readWatchCfg().on || entry?.watchVersion!==readWatchCfg().sessionVersion}
    function invalidateWatch(){
      for(const entry of watchRequests.values()){entry.cancelled=true;releaseTurn(entry)}
      G.turnQ=(G.turnQ||[]).filter(e=>e.kind!=='watch')
      G.watchHold=null;G.watchLines=[];G.watchLineMark=0
    }
    function watchStatus(){
      const cfg=readWatchCfg(), status=G.watchStatus || {}, fresh=status.sessionVersion===cfg.sessionVersion && Date.now()-(status.at||0)<15000
      return {...status,desired:cfg.on,capture:!cfg.on?{phase:'stopped'}:fresh?status.capture:{phase:'preparing',error:{stage:'capture-status',message:'等待桌宠回报实际采集状态'}},fresh}
    }
    function claimTurn(text) {
      const q = talkQueue()
      if (!text) return null
      const marker=/【live2d-watch:([a-f0-9-]+)】/.exec(text)
      if(marker && watchRequests.has(marker[1]) && watchStale(watchRequests.get(marker[1])))return watchRequests.get(marker[1])
      const i = q.findIndex((e) => e.probe && text.includes(e.probe))
      if (i < 0) return null
      const hit = q[i]
      // 比它更早还没被认领的排期都是作废的（那一轮没走到 user/message），一起清掉，
      // 否则它们会一直排在队首，蹭到后面某一轮的回复上。
      q.splice(i, 1)
      return hit
    }
    for (const off of G.offs.splice(0)) { try { off && off() } catch {} } // 有机会就顺手摘掉上一代的监听
    // 三段文本 → 动作/表情/姿势（含修饰）。句末 <body:> 和句中 〔〕 共用同一套解析。
    function parseBody(bodyRaw, clips) {
      const parts = String(bodyRaw || '').split(/[,，]/).map((x) => x.trim())
      const spec = parseMotionSpec(parts[0], clips)
      const motion = spec.name
      const ex = faceNames()   // exp3 + 神情库，合起来才是她可以写在「表情」位的全部词
      // 表情位能写多条：'挑眉+嘟嘴' = 眉一条、嘴一条，同时挂在脸上。
      // 用 + 而不是逗号，因为逗号是 anim 的段分隔符（动作,表情,姿势）。
      const exprPick = (raw) => {
        const ns = String(raw || '').split('+').map((s) => s.trim()).filter(Boolean)
        return ns.length && ns.every((n) => ex.includes(n)) ? ns.join('+') : ''
      }
      let expression = exprPick(parts[1])
      let posture = POSTURES.includes(parts[2]) ? parts[2] : ''
      // 〔脸红〕〔眯眼笑〕这种只写表情/姿势的：第一段不是动作，但正好是表情/姿势名
      const onlyExpr = !motion && !!exprPick(parts[0])
      const onlyPosture = !motion && !onlyExpr && POSTURES.includes(parts[0])
      if (onlyExpr) expression = exprPick(parts[0])
      if (onlyPosture) posture = parts[0]

      const miss = (got, field, pool) => {
        const sug = suggestName(got, pool)
        G.miss = { at: Date.now(), got, field, suggest: sug }
        api.log.warn(`Live2D：不认识的${field}「${got}」，忽略${sug ? `（是不是想写「${sug}」？）` : ''}`)
      }
      if (parts[0] && !motion && !onlyExpr && !onlyPosture) miss(parts[0], '动作', [...Object.keys(clips), ...MOTIONS])
      if (parts[1] && !expression) miss(parts[1], '表情', ex)
      if (parts[2] && !posture) miss(parts[2], '姿势', POSTURES)
      return {
        motion, expression, posture,
        amp: spec.amp, speed: spec.speed, repeat: spec.repeat, mirror: spec.mirror,
      }
    }

    function parseTag(text) {
      const s = parseScript(text)
      const p = parseBody(s.bodyRaw, readClips())
      return {
        clean: s.clean, chars: s.chars, beats: s.beats,
        // 带身体标签 = 有句末 <body:> 或有句中 〔〕（窗口旁路靠这个判断该不该投桌宠）
        hasTag: s.bodyRaw !== '' || s.beats.length > 0,
        ...p,
      }
    }

    // 把解析结果变成 anim 字段：
    //   · 有句中动作 → 写 beat.json，anim 只传 id（40 字符上限塞不下多动作脚本）
    //   · 没有 → 还是老三段 + 修饰
    function animFor(p) {
      const clips = readClips()
      // 「每句一张脸」收口处。四条投递链路（QQ 私聊 / 耳朵电话 / 陪看 / 窗口直聊）
      // 最后都要走这里，所以补表情放在这一层，一处改完全部生效，不用逐个调用点抄。
      // 她写了表情位就听她的 —— 这里只在「整句完全没有表情」时动手：
      // 句中 〔脸红〕 这种也算写了（那是她亲手排的节奏，再补一张会跟它抢同一个通道）。
      if (!p.expression && api.settings().autoFace !== false && p.clean) {
        const inBeats = (p.beats || []).some((b) => parseBody(b.inner, clips).expression)
        const picked = inBeats ? '' : (pickFaceByText(p.clean, readFaces()) || faceByTone(p.clean))
        if (picked) {
          p = { ...p, expression: picked }
          G.faceAuto = { at: Date.now(), face: picked }
        }
      }
      if (p.beats && p.beats.length) {
        const beats = p.beats.map((b) => {
          const q = parseBody(b.inner, clips)
          return {
            ch: b.ch, raw: b.inner,
            name: q.motion, expr: q.expression, posture: q.posture,
            amp: q.amp, speed: q.speed, repeat: q.repeat, mirror: q.mirror,
          }
        }).filter((b) => b.name || b.expr || b.posture)
        if (beats.length) {
          const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
          if (writeBeat({
            id, at: new Date().toISOString(), chars: p.chars,
            base: {
              motion: p.motion, expr: p.expression, posture: p.posture,
              amp: p.amp, speed: p.speed, repeat: p.repeat, mirror: p.mirror,
            },
            beats,
          })) return 'beat:' + id
        }
      }
      return animOf({
        motion: p.motion, expression: p.expression, posture: p.posture,
        amp: p.amp, speed: p.speed, repeat: p.repeat, mirror: p.mirror,
      })
    }
    // 「同一句话 4 秒内只处理一次」的占位。**必须在 animFor 之前调用**：
    // animFor 有副作用（写 beat.json），而同一句回复会被两条链路各解析一次
    // （reply 拦截 + DSH session/event 旁路）。如果让被去重挡掉的那一次也走到 animFor，
    // 它会把 beat.json 覆盖成自己新生成的 id，而渲染页手里拿的是先投出去的那个 id →
    // fetch 回来发现 id 对不上，整段脚本被丢弃，表现就是「字打出来了，模型一动不动」。
    // 2026-11-06 实测复现：文件 id=bmw4q7qkt35rl，投出去的 anim=beat:bmw4q7qka6a36。
    // 去重表在 globalThis 上：跨模块实例（热加载残留）也生效。
    function claimText(clean, tag, force) {
      const now = Date.now()
      if (!force && clean === G.lastText && now - G.lastAt < 4000) {
        api.log.info((tag || '投递') + '：同句 4 秒内重复，跳过')
        return false
      }
      G.lastText = clean; G.lastAt = now
      return true
    }

    // 语音回合的判据：这条回复是不是在应「我们刚投进 QQ 私聊的那一句」。
    // reply 事件只给 chatId + userText（这一轮的输入原文），没有轮次号，所以只能
    // 「同一条会话 + 这句话 + 时间窗」认一次。命中即作废 —— 否则下一条普通 QQ 消息
    // 没写标签时也会被当成语音回合补投一遍。
    // 返回 ''（不是我们投的）/ 'ear' / 'call' / 'watch'（哪条线投的）——
    // 陪看要靠这个身份决定「她只回一个『看』就别发 QQ、也别出声」。
    function voiceHit(info) {
      const w = G.voiceWait
      if (!w) return ''
      if (w.gen != null && w.gen !== G.gen) { G.voiceWait = null; return '' } // 热加载留下的旧标记，不认
      const chatId = String((info && info.chatId) || '')
      if (!chatId || chatId !== w.chatId) return ''
      if (Date.now() - w.at > 5 * 60_000) { G.voiceWait = null; return '' }
      const u = String((info && info.userText) || '')
      // queryText 传的就是听到的原句，正常情况下 u === heard。语音转写偶有尾随标点差异，
      // 再给一条「前 6 个字包含」的兜底（短句不参与，免得「嗯」这类误命中）。
      const hit = !!u && (u === w.heard || u.includes(w.heard) || (w.heard.length >= 6 && u.includes(w.heard.slice(0, 6))))
      if (hit) { G.voiceWait = null; return w.kind || 'ear' }
      return ''
    }

    function dispatchToPet(clean, anim, purpose, watchRequestId) {
      const s = api.settings()
      if (!s.on) return false
      const pet = api.use('pet')
      if (!pet || typeof pet.dispatch !== 'function') return false
      // 记下她说过的每句话：电话那头的麦克风可能把她自己的声音又收回去（AEC 失灵时），
      // 有了这份记录才能在服务端认出「这不是主人说的，是她刚说的」。
      noteSaid(clean)
      const phone = purpose === '电话' && G.mhubCall?.native ? G.mhubCall : null
      const speech = phone && { id: randomUUID(), text: clean }
      if (phone) phone.speech = speech
      pet.dispatch({
        text: clean, modality: '', anim,
        via: 'pet', noFallback: true,
        purpose: phone ? '电话:' + phone.id : purpose==='陪看'&&watchRequestId ? 'L2W'+(s.voice?'v':'t')+':'+watchRequestId.replace(/-/g,'') : `Live2D:${s.voice ? 'voice' : 'text'}:${purpose}`,
      }).then((r) => {
        if (phone && G.mhubCall === phone && phone.speech === speech && !r?.ok) phone.speech = null
        if (r && !r.ok && r.reason !== 'pet-offline' && r.reason !== 'focus') {
          api.log.warn('Live2D 气泡未投递：', r.reason || r.error || '')
        }
      }).catch((e) => api.log.warn('Live2D dispatch 异常：', String(e?.message || e)))
      return true
    }

    // ---------- 她说过的最近几句话（防自激用） ----------
    function noteSaid(text) {
      const t = String(text || '').trim()
      if (!t) return
      const arr = G.said || (G.said = [])
      arr.push({ t: Date.now(), s: t })
      while (arr.length && Date.now() - arr[0].t > 120000) arr.shift()
      if (arr.length > 30) arr.shift()
    }
    // 中文不用分词：字符 bigram 对短句已经够准。实测正常一问一答（「今天天气怎么样」vs
    // 「挺好的，就是有点闷」）重合率不到 0.15，阈值 0.6 只在「几乎逐字重复」时才成立。
    function bigrams(s) {
      const t = String(s).replace(/[\s，。！？、,.!?~…:：;；"'“”‘’（）()【】\[\]]/g, '')
      const set = new Set()
      if (t.length <= 1) { if (t) set.add(t); return set }
      for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
      return set
    }
    function looksLikeEcho(heard) {
      const said = G.said || []
      if (!said.length) return false
      const h = bigrams(heard)
      if (!h.size) return false
      const now = Date.now()
      for (const it of said) {
        if (now - it.t > 90000) continue
        const g = bigrams(it.s)
        if (!g.size) continue
        let hit = 0
        for (const k of h) if (g.has(k)) hit++
        if (hit / h.size >= 0.6) return true
      }
      return false
    }

    // ---------- 1. 手册注入 ----------
    api.rule((kind) => {
      const s = api.settings()
      if (!s.on) return ''
      if (s.scope !== 'both' && kind !== 'private') return ''
      return buildManual()
    })

    // ---------- 2. 回复拦截：剥标签 + 镜像桌宠 ----------
    api.on('reply', (text, info) => {
      const s = api.settings()
      if (typeof text !== 'string') return text
      // 先洗 DSML 残渣，再走后面所有判断：不洗的话它既会原样发到 QQ，
      // 也会被当成正文喂进标签解析和桌宠语音（先生 2026-11-06 问的就是这个）。
      const scrubbed = stripDsml(text)
      if (scrubbed !== text) {
        api.log.info('回复里混着 DSML 工具调用残渣，已清掉（原 ' + text.length + ' 字 → ' + scrubbed.length + ' 字）')
        text = scrubbed
        if (!text.trim()) return null // 洗完全是空的，就别发一条空消息出去
      }
      // 这一轮是不是我们（耳朵 / 电话 / 陪看）投进 QQ 私聊的那一轮（认一次就作废）
      const watchMatch=/【live2d-watch:([a-f0-9-]+)】/.exec(String(info?.userText||''))
      const watchEntry=watchMatch&&watchRequests.get(watchMatch[1])
      if(watchEntry?.replyDelivered)return null
      if(watchMatch&&(!watchEntry||watchStale(watchEntry))){if(watchEntry)releaseTurn(watchEntry);return null}
      const vk = watchEntry ? 'watch' : voiceHit(info)
      if(watchEntry){watchEntry.replyDelivered=true;G.voiceWait=null;G.watchStatus={...G.watchStatus,lastReplyAt:Date.now(),lastReplySilent:WATCH_SILENT.test(parseTag(cleanForPet(text)).clean),replyRequestId:watchEntry.requestId};releaseTurn(watchEntry)}
      // 只有真带标签才解析，没有标签的普通回复原样放行。
      // **不能只认 `<body:`**：她完全可以只写句中的 〔动作〕 而省掉句末标签（手册允许），
      // 那样这段话会被整段跳过 → 标签原样漏进聊天、桌宠也收不到任何东西，
      // 表现就是「字打出来了，模型一点没动」。2026-11-06 修。
      if (!text.includes('<body:') && !text.includes('〔')) {
        // 语音回合的特殊处理：她闲聊时经常一个标签都不写，QQ 里能看到回复、桌宠却一声不响
        // （2026-11-06 走 QQ 私聊通道后暴露的）。这里补投一份：气泡 + 语音 + 按语义配动作。
        // 注意仍然 return 原文 —— QQ 那边照常发，先生要的是「两边都留」。
        if (!vk || !s.on) return text
        const cleaned = cleanForPet(text)
        if (!cleaned) return text
        const p0 = parseTag(cleaned)
        const clean = p0.clean || cleaned
        if (!clean) return text
        // 陪看：她只回一个「看」= 这张没什么可说的 —— QQ 也别发，桌宠也别出声
        if (vk === 'watch' && WATCH_SILENT.test(clean)) {
          api.log.info('陪看：这一张她没什么可说的（QQ 也不发）')
          return null
        }
        if (claimText(clean, '语音')) {
          let motion = p0.motion
          if (!motion && !p0.beats.length && s.auto !== false) motion = pickMotionByText(clean, readClips())
          const anim = animFor({ ...p0, motion })
          if (dispatchToPet(clean, anim, KIND_LABEL[vk] || '语音',watchEntry?.requestId)) {
            api.log.info((KIND_LABEL[vk] || '语音') + '（无标签）→ 桌宠：' + (vk==='watch'?'[reply metadata]':clean.slice(0, 40)) + '（' + (anim || '无动作') + '）')
          }
        }
        return text
      }

      // 剥掉全部标签（多写只认最后一个），无论范围——标签绝不能漏到聊天里
      const p = parseTag(text)
      const clean = p.clean
      // 陪看这一轮如果整句就是个「看」，QQ 那边也不用发了
      if (vk === 'watch' && WATCH_SILENT.test(String(clean || ''))) {
        api.log.info('陪看：这一张她没什么可说的（QQ 也不发）')
        return null
      }

      // 镜像到桌宠：范围内 + 是回话（有 userText 才镜像，模块自发的不投）；不带标签也镜像（只气泡+语音）
      const chatId = String(info?.chatId || '')
      const inScope = s.on && (s.scope === 'both' || chatId === `private:${api.config().ownerQQ}`)
      const okClaim = inScope && info?.userText && clean ? claimText(clean, '聊天') : false
      if (vk && !okClaim) {
        api.log.info(KIND_LABEL[vk] + '：带标签分支没投（inScope=' + inScope + ' userText=' + Boolean(info?.userText)
          + ' clean=' + Boolean(clean) + '）')
      }
      if (okClaim) {
        // 她没点名动作时按语义兜底配一个（命中关键词才动，不是每条都动）。
        // 有句中动作时不兜底：那是她亲手排的节奏，自动配一个只会抢戏。
        let motion = p.motion
        if (!motion && !p.beats.length && s.auto !== false) motion = pickMotionByText(clean, readClips())
        const anim = animFor({ ...p, motion })
        dispatchToPet(clean, anim, KIND_LABEL[vk] || '聊天',watchEntry?.requestId)
      }

      // 整句只剩标签：别发空消息
      return clean || null
    })

    // ---------- 3.5 双链路复现口（排查用）：让同一条文本被「解析两次」，看 beat.json 会不会被覆盖 ----------
    // 真实链路里 reply 拦截 与 DSH session/event 旁路 会各解析一次同一条回复；
    // 2026-11-06 就是第二次把脚本换成自己的 id，导致渲染页拿着旧 id 什么都播不出来。
    api.route('/dupsim', async (req, res) => {
      const q = api.core.http.query(req)
      const text = String(q.text || '复现〔摇摆〕双链路')
      const p = parseTag(text)
      const read = () => { try { return JSON.parse(readFileSync(BEAT_FILE, 'utf8')).id } catch { return '' } }
      const okA = claimText(p.clean, '模拟A')
      const animA = okA ? animFor(p) : ''
      const idA = read()
      const okB = claimText(p.clean, '模拟B')
      const animB = okB ? animFor(p) : ''
      const idB = read()
      return {
        ok: true, text, clean: p.clean,
        first: { claimed: okA, anim: animA }, second: { claimed: okB, anim: animB },
        fileIdA: idA, fileIdB: idB,
        stable: idA !== '' && idA === idB,
        // 两条都过 = 修好了；注意这个接口会在 4 秒内占用该句的去重位
        verdict: idA !== '' && idA === idB ? 'OK：第二次没有再写文件' : 'BAD：文件被第二次覆盖了',
      }
    })

    // ---------- 3. 自测接口：不动 QQ，直接走一遍「剥标签 + 投桌宠」（GET ?text= 或 POST {text}） ----------
    api.route('/test', async (req, res) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const raw = String(body.text || q.text || '你好呀，我今天很开心～<body:举手,脸红>')
      const pet = api.use('pet')
      const online = pet && typeof pet.online === 'function' ? pet.online() : null
      // 模拟 reply 拦截（复用公共助手）
      const p = parseTag(raw)
      claimText(p.clean, '自测', true) // 自测就是要反复测同一句，强制占位、不做去重
      const anim = animFor(p)
      const dispatched = dispatchToPet(p.clean, anim, '自测')
        ? '已投递（桌宠应弹气泡）'
        : '未投递（未启用 / 桌宠离线）'
      return {
        ok: true, raw, clean: p.clean, motion: p.motion, expression: p.expression, posture: p.posture, anim,
        mods: { amp: p.amp, speed: p.speed, repeat: p.repeat, mirror: p.mirror },
        chars: p.chars,
        // 句中标签：第几个字之后做什么（渲染页按真实语速换算成毫秒）
        beats: (p.beats || []).map((b) => {
          const q = parseBody(b.inner, readClips())
          return { ch: b.ch, raw: b.inner, name: q.motion, expr: q.expression, posture: q.posture,
            amp: q.amp, speed: q.speed, repeat: q.repeat, mirror: q.mirror }
        }),
        petOnline: online, dispatched,
        hint: '桌宠应已弹气泡（+语音）并演出动作/表情/姿势；petOnline.online=false 说明桌宠没连上',
      }
    })

    // ---------- 3.5 耳朵：主人按住麦克风说话（桌宠一体化，第 1 期） ----------
    // 采集与 WAV 编码都在 Electron 侧（live2d-pet/app/ear.js），这里只做三件事：
    // 识别 → 让她想 → 投回桌宠。
    // 说完的话落哪儿，和电话、陪看共用**一个**开关（面板「三件套」卡片 / pet.json 的 talk.to）：
    //   qq     = 主人私聊那条，和 QQ 聊天共用上下文，她的回复也发 QQ（先生要的是「同一条关系」）；
    //   system = 后台那唯一一条会话（TALK_CHAT），不进任何聊天记录，只回桌宠。
    // 识别本身不做在模块里 —— DSH 自带 speechToText（SenseVoice 模型早就在 ~/.dsh/speech-to-text，
    // 231MB，常驻），复用它是为了「她和 QQ 听到的是同一个模型」。
    const EAR_NOISE = /^(嗯+|啊+|哦+|呃+|谢谢(观看|大家)?|字幕.*|请不吝点赞.*|订阅.*|转发.*|打赏.*|明镜与点点.*)[。.!！?？…]*$/
    api.route('/ear', async (req) => {
      let b = {}
      try { b = (await api.core.http.body(req)) || {} } catch {}
      const b64 = String(b.wav || '')
      if (!b64) return { ok: false, message: '没收到音频' }
      const stt = api.dsh.get('speechToText')
      if (!stt || typeof stt.resolve !== 'function') {
        return { ok: false, message: '内部本地语音识别未就绪，请在语音设置中检查模型。' }
      }
      const t0 = Date.now()
      let heard = ''
      try {
        const spec = stt.resolve({ audio: new Uint8Array(Buffer.from(b64, 'base64')) })
        const r = await stt.transcribe(spec, AbortSignal.timeout(60000))
        heard = String(typeof r === 'string' ? r : (r && (r.text || r.transcript)) || '').trim()
      } catch (e) {
        api.log.warn('耳朵：识别失败', String((e && e.message) || e))
        return { ok: false, message: '识别失败：' + String((e && e.message) || e).slice(0, 60) }
      }
      const sttMs = Date.now() - t0
      if (!heard) { api.log.info(`耳朵：没听清（${sttMs}ms）`); return { ok: false, message: '没听清' } }
      // 静音/环境音时 SenseVoice 会吐「嗯」「谢谢观看」这类幻觉词，当成没听见。
      // 不设这道闸的话，桌上没人说话也会每隔几秒变成一句假指令。
      if (heard.length < 2 || EAR_NOISE.test(heard)) {
        api.log.info(`耳朵：像杂音或幻觉「${heard}」，不理`)
        return { ok: false, message: '没听清' }
      }
      api.log.info(`耳朵：听到「${heard}」（${sttMs}ms）`)
      // 第 2 期「眼睛」：带图说话。shot 是主进程在按下那一刻截的当前屏（base64 JPEG），
      // 和这句语音一起交给她。截不到就退化成「只听我说」，不影响这一轮。
      const shot = (b && b.shot && b.shot.base64)
        ? {
          base64: String(b.shot.base64),
          mediaType: String(b.shot.mediaType || 'image/jpeg'),
          w: Number(b.shot.w) || 0,
          h: Number(b.shot.h) || 0,
        }
        : null
      // 「想」和「投递」放后台：识别完立刻把 HTTP 放回去，桌宠那边不用干等她十几秒。
      // 她的回答照旧走 pet 通道回来（气泡 + TTS + 动作 + 口型）。
      earTurn(heard, shot).catch((e) => api.log.warn('耳朵：应答失败', String((e && e.message) || e)))
      return { ok: true, heard, sttMs, to: readTalkCfg().to, shot: shot ? `${shot.w}×${shot.h}` : '' }
    })
    // ---------- 3.6 电话：一直听、自动断句（第 3 期） ----------
    // 断句在 Electron 侧（app/renderer/call.js），这里和 /ear 的差别只有三处：
    //   1. 没有截图；
    //   2. 走独立的电话会话（system:ext-live2d:call），不跟按住说话搅在一条上下文里；
    //   3. 多三道闸 —— 杂音、重复句、**她自己说的话被录回来**。
    // 第三道必须摆在服务端：AEC 在别人家的声卡上是什么脾气，谁也保证不了。
    api.route('/call', async (req) => {
      let b = {}
      try { b = (await api.core.http.body(req)) || {} } catch {}
      const b64 = String(b.wav || '')
      if (!b64) return { ok: false, message: '没收到音频' }
      const ownedCall = G.mhubCall?.native ? G.mhubCall : null
      if (!readCallCfg().on || ownedCall && (b.mhubOwner !== ownedCall.id || ownedCall.muted || !mhubCallActive()) || b.mhubOwner && !ownedCall) return { ok: false, message: '电话未开启收音' }
      const stt = api.dsh.get('speechToText')
      if (!stt || typeof stt.resolve !== 'function') return { ok: false, message: '内部本地语音识别未就绪。' }
      const t0 = Date.now()
      let heard = ''
      try {
        const spec = stt.resolve({ audio: new Uint8Array(Buffer.from(b64, 'base64')) })
        const r = await stt.transcribe(spec, AbortSignal.timeout(60000))
        heard = String(typeof r === 'string' ? r : (r && (r.text || r.transcript)) || '').trim()
      } catch (e) {
        api.log.warn('电话：识别失败', String((e && e.message) || e))
        return { ok: false, message: '识别失败' }
      }
      const sttMs = Date.now() - t0
      if (!heard) {
        api.log.info(`电话：没听清（${sttMs}ms，识别结果为空）`)
        return { ok: false, message: '没听清', sttMs }
      }
      if (heard.length < 2 || EAR_NOISE.test(heard)) {
        api.log.info(`电话：像杂音/幻觉「${heard}」，不理（${sttMs}ms）`)
        return { ok: false, message: '像杂音', heard, sttMs }
      }
      // 闸一：像我自己刚说的话 —— 这就是 AEC 漏了的典型症状（回声被当成主人的话）
      if (looksLikeEcho(heard)) {
        api.log.warn(`电话：「${heard.slice(0, 30)}」像是我自己刚说的，丢掉`)
        return { ok: false, message: '像回声', heard, sttMs }
      }
      // 闸二：同一句 8 秒内重复（VAD 偶尔会把一句切成两半，前后两段识别结果一样）
      if (G.lastCall && G.lastCall.s === heard && Date.now() - G.lastCall.t < 8000) {
        api.log.info(`电话：「${heard.slice(0, 24)}」刚说过，丢掉`)
        return { ok: false, message: '重复', heard, sttMs }
      }
      if (ownedCall && (G.mhubCall !== ownedCall || ownedCall.muted || !readCallCfg().on)) return { ok: false, message: '电话已挂断或静音' }
      if (ownedCall) ownedCall.input = heard
      G.lastCall = { s: heard, t: Date.now() }
      api.log.info(`电话：听到「${heard}」（${sttMs}ms）`)
      callTurn(heard).catch((e) => api.log.warn('电话：应答失败', String((e && e.message) || e)))
      return { ok: true, heard, sttMs, to: readTalkCfg().to }
    })

    // 排障口：跳过识别，直接按电话的方式说一句话（GET ?text= / POST {text}）。
    api.route('/callsay', async (req) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const heard = String(body.text || q.text || '').trim()
      if (!heard) return { ok: false, message: '给一句要说的话：?text=…' }
      callTurn(heard).catch((e) => api.log.warn('电话：应答失败', String((e && e.message) || e)))
      return { ok: true, heard, to: readTalkCfg().to, hint: '已按电话的方式投出去（识别那一步跳过）' }
    })

    // 排障口：跳过识别，直接按「耳朵」的方式把一句话投出去（GET ?text= / POST {text}）。
    // 用途是分清「识别不准」和「投递链路断了」——按住说话只走 /ear，出错时看不出断在哪一步。
    api.route('/earsay', async (req) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const heard = String(body.text || q.text || '').trim()
      if (!heard) return { ok: false, message: '给一句要说的话：?text=…' }
      // shotFile：本机图片路径，给「看图回答」自测用 —— 不用真按 F2 也能验一遍带图链路
      const shotFile = String(body.shotFile || q.shotFile || '').trim()
      let shot = null
      if (shotFile) {
        try {
          const buf = readFileSync(shotFile)
          const m = shotFile.toLowerCase().match(/\.(png|jpe?g|webp)$/)
          const mediaType = m && m[1] === 'png' ? 'image/png' : m && m[1] === 'webp' ? 'image/webp' : 'image/jpeg'
          shot = { base64: buf.toString('base64'), mediaType, w: 0, h: 0 }
        } catch (e) {
          return { ok: false, message: '读不到图片：' + String((e && e.message) || e) }
        }
      }
      earTurn(heard, shot).catch((e) => api.log.warn('耳朵：应答失败', String((e && e.message) || e)))
      return {
        ok: true, heard, to: readTalkCfg().to,
        shot: shot ? `${Math.round(shot.base64.length / 1024)}KB（${shot.mediaType}）` : '',
        hint: '已按耳朵的方式投出去（识别那一步跳过）',
      }
    })

    async function earTurn(heard, shot) {
      // 提示词只交代两件事：这句是语音转写的（可能有同音错字）、按当面说话的口吻答。
      // 带图时再交代一句「先看我截的这张图」：不点明的话她会自己脑补屏幕内容。
      // 开场那句同时是这一轮的**身份**（PROBE.ear）：后台会话里旁路靠它认领，改字等于改协议。
      const prompt = PROBE.ear + '，语音转写可能有同音错字，别被错字带偏。'
        + (shot ? '同时截了一张我现在的屏幕给你看，先看图再答；图里没有我说的东西就直接问我。' : '')
        + '就像面对面那样回答我，短一点、口语一点，别像写文章。）\n' + heard
      await talkTurn('ear', { heard, prompt, probe: PROBE.ear, image: shot })
    }

    // ---------- 三个功能共用的一条投递路径 ----------
    // 只做一件事：把这一轮交给对应的会话。落哪儿由**一个**开关定（talk.to，面板「三件套」卡片）：
    //   qq     = 主人私聊那条，和 QQ 聊天共用上下文，她的回复也发 QQ；
    //   system = 后台那唯一一条会话（TALK_CHAT），不进任何聊天记录，只回桌宠。
    // 回复不靠返回值（pushToSession 投出去就不管），统一从两处接：
    //   · 落 QQ：api.on('reply') 拿得到（剥标签 + 镜像桌宠 + 陪看的「看」闭嘴）；
    //   · 落后台：session/event 旁路拿得到（turn/end 那一支按认领到的 kind 处理）。
    // 带图的那一轮（F2 截图、电话里的陪看画面、陪看本身）两种落点都能带图了 ——
    // 以前后台那条走 api.think 只收文字，图只能丢掉；现在只剩这一条路，反而补齐了。
    async function talkTurn(kind, o) {
      const label = KIND_LABEL[kind] || '语音'
      const hub = api.core && api.core.hub
      if (!hub || typeof hub.pushToSession !== 'function') {
        api.log.warn(`${label}：拿不到对话中枢，这句丢了`)
        return { to: '', withImage: false, stage:'submission', message:'语音对话中枢尚未就绪，请检查内部 AI 服务。' }
      }
      const ownerQQ = String(api.config().ownerQQ || '')
      let to = o.deliver || o.local ? 'system' : readTalkCfg().to
      if (to === 'qq' && !ownerQQ) {
        api.log.warn(`${label}：还没配主人 QQ，改落后台会话`)
        to = 'system'
      }
      const chat = to === 'qq'
        ? { chatId: `private:${ownerQQ}`, kind: 'private', userId: ownerQQ, nickname: '主人' }
        : { chatId: TALK_CHAT, kind: 'system', title: TALK_TITLE }
      const content = [{ type: 'text', text: o.prompt }]
      let withImage = false
      if (o.image && o.image.base64) {
        // 模型明确不支持看图时硬塞图片块会让整轮被拒（她一个字都回不了）——
        // 和 QQ 里收到图片时的判断保持一致，看不了就只用文字交代一句。
        let vision = null
        try { vision = await hub.canSeeImages(chat) } catch(error) {
          if(kind==='watch')return {to:'',withImage:false,stage:'model-capability',message:'模型视觉能力查询失败，请检查当前提供商'}
        }
        if(kind==='watch' && vision!==true)return {to:'',withImage:false,visionUnsupported:vision===false,stage:'model-capability',message:vision===false?'当前模型不支持看图':'无法确认当前模型的视觉能力'}
        if (vision === false) {
          content[0].text += '\n（我本来想给你看张图，但你现在的模型看不了图，只能听我说。）'
          api.log.info(`${label}：当前模型看不了图，这一轮只发文字`)
        } else {
          content.push({
            type: 'image', data: o.image.base64,
            mediaType: o.image.mediaType || 'image/jpeg',
            name: (kind === 'watch' ? 'watch-' : 'shot-') + Date.now() + '.jpg',
          })
          withImage = true
        }
      }
      if(o.stale?.())return {to:'',withImage:false,cancelled:true}
      const pet = api.use('pet')
      try { if (pet && typeof pet.setThinking === 'function') pet.setThinking(true) } catch {}
      // 排队：旁路在 user/message 里按提示词开头认领，turn/end 时就知道这轮该干什么
      const entry = { requestId:o.requestId,watchVersion:o.watchVersion,kind, probe: o.probe, at: Date.now(), stale: o.stale, deliver: o.deliver, to,
        flight: o.flight, retryWithoutImage: withImage ? o.retryWithoutImage : null }
      if(kind==='watch'){
        watchRequests.set(entry.requestId,entry)
        entry.timer=setTimeout(()=>{entry.cancelled=true;releaseTurn(entry);const q=G.turnQ||[];const i=q.indexOf(entry);if(i>=0)q.splice(i,1)},120000)
        entry.timer.unref?.()
        for(const [id,e] of watchRequests)if(Date.now()-e.at>600000)watchRequests.delete(id)
      }
      talkQueue().push(entry)
      if (to === 'qq') {
        // 这一轮在应我们刚投进去的那句话：reply 拦截靠它认出「没写标签也要让她出声」
        G.voiceWait = { chatId: chat.chatId, heard: o.heard, kind, at: Date.now(), gen: G.gen }
      }
      try {
        // 和「主人打了一句话」走完全同一条路：记忆检索、full 权限、工具都在。
        // 它只是把内容交给那条会话，不会伪造一条主人的 QQ 消息 —— 所以记录里只有她的回复。
        await hub.pushToSession(chat, content, ownerQQ, { queryText: o.heard })
        api.log.info(`${label} → ${to === 'qq' ? 'QQ 私聊' : '后台会话'}：${String(o.heard).slice(0, 30)}${withImage ? '（＋图）' : ''}`)
        return { to, withImage }
      } catch (e) {
        const i = G.turnQ ? G.turnQ.indexOf(entry) : -1
        if (i >= 0) G.turnQ.splice(i, 1)
        if (to === 'qq' && G.voiceWait?.heard===o.heard) G.voiceWait = null
        entry.cancelled=true;releaseTurn(entry)
        try { if (pet && typeof pet.setThinking === 'function') pet.setThinking(false) } catch {}
        api.log.warn(`${label}：投不进去（${to}）`, String((e && e.message) || e))
        return { to: '', withImage: false, stage:'submission', message:String(e?.message || e || '语音对话投递失败。').slice(0,240) }
      }
    }

    // 一轮结束：收思考态 + 放锁。两种落点都走这里，锁才不会漏（漏了就是「上一张还在想」卡死）。
    function releaseTurn(entry) {
      if(entry?.kind==='watch' && G.watchRequestId!==entry.requestId){clearTimeout(entry.timer);return}
      try {
        const pet = api.use('pet')
        if (pet && typeof pet.setThinking === 'function') pet.setThinking(false)
      } catch {}
      if (!entry) return
      clearTimeout(entry.timer)
      if (entry.kind === 'watch' && G.watchRequestId===entry.requestId) { G.watchBusy = false; G.watchAt = 0 }
      if (entry.flight) callDone(entry.flight)
    }

    // 后台会话里那一轮她的话 → 桌宠（落 QQ 的由 reply 拦截负责，这里不碰，否则同一句说两遍）
    function speakTurn(entry, text) {
      const label = KIND_LABEL[entry.kind] || '语音'
      if(entry.kind==='watch'&&entry.replyDelivered)return
      if (!text) { api.log.info(`${label}：这一轮她一个字都没写`); return }
      if ((entry.kind === 'watch' && watchStale(entry)) || (typeof entry.stale === 'function' && entry.stale())) {
        api.log.info('电话：这句被后来的一句话顶掉了，不播')
        return
      }
      // 只有陪看认「只回一个看」＝不想说话；电话/耳朵里一个「嗯」就是正经回答，得念出来
      if(entry.kind==='watch'){entry.replyDelivered=true;G.watchStatus={...G.watchStatus,lastReplyAt:Date.now(),replyRequestId:entry.requestId}}
      const said = speakWatch(text, label, entry.kind === 'watch', entry.requestId)
      if(entry.kind==='watch')G.watchStatus={...G.watchStatus,lastReplySilent:!said}
      api.log.info(said ? `${label} → 桌宠：回复已投递` : `${label}：这一句没出声`)
    }

    // ---------- 电话这一轮 ----------
    // 一段连续对话里的「一句」。排队策略是这套东西里最需要想清楚的一块：
    // 她一轮要想几秒到十几秒，主人不会等 —— 说第二句时第一句往往还在想。
    // 规矩是「后来的话作废前面那轮」：新句进来就 ++seq，旧的那轮回来时 seq 对不上，结果直接丢掉。
    // 这不是真打断（她那边正在跑的这一轮停不掉），但**听感上等价**：旧答案一个字都不会冒出来。
    // 一轮的终点现在由旁路告诉我们（releaseTurn → callDone），所以 busy 放在 G.callQ 上。
    // 陪看在电话期间只攒不叫醒（见 /watch 的 hold 分支）。这里取一张就走 —— 取走即清，
    // 一张图只配一句话，不然同一屏会被三句话重复问三遍。
    // 只使用当前陪看会话最近 15 秒内的画面。
    function takeWatchHold() {
      const h = G.watchHold
      if (!h) return null
      G.watchHold = null
      const watch = readWatchCfg()
      if (!watch.on || h.sessionVersion!==watch.sessionVersion || Date.now()-(h.capturedAt||h.at||0)>15000) return null
      return h
    }

    // 电话这一轮要顺带的那几句台词。和 /watch 共用同一个游标（G.watchLineMark）：
    // 读过就标掉，同一句台词不该在两轮里各出现一次（那会让她以为自己听重了）。
    function takeRecentLines(ms = 90000) {
      const nowMs = Date.now()
      const since = G.watchLineMark || 0
      const arr = (G.watchLines || []).filter((x) => x && x.text && x.at > since && nowMs - x.at <= ms)
      if (!arr.length) return ''
      G.watchLineMark = nowMs
      return arr.map((x) => `约${Math.round((nowMs - x.at) / 1000)}s前「${String(x.text).slice(0, 50)}」`).join('；')
    }

    async function callTurn(heard) {
      const owned = G.mhubCall?.native ? G.mhubCall : null
      const q = G.callQ || (G.callQ = { busy: false, pending: '' })
      G.callSeq = (G.callSeq || 0) + 1 // 这一开口，之前那轮就算过期了
      if (q.busy) {
        q.pending = heard
        api.log.info('电话：上一轮还没答完，这句排队（中间那些会被它顶掉）')
        return
      }
      const flight = Symbol('call-turn')
      q.busy = flight
      const seq = G.callSeq
      // 陪看攒下的那一屏：并到这一轮里，而不是另开一轮 ——
      // 「画面 + 台词 + 我这句话」一次给她，才叫一起看；分两次问就是两个人格。
      const held = takeWatchHold()
      if (held) api.log.info(`电话：这一句带上陪看攒的那一屏（${held.tiles.length} 帧，${Math.round((Date.now() - held.at) / 1000)}s 前）`)
      const lines = held ? takeRecentLines() : ''
      const prompt = (withImage, retry) => PROBE.call + '，这句是语音转写，可能有同音错字，别被错字带偏。'
        + (withImage ? '下面是陪看的最新画面。我的问题涉及屏幕时，请根据图片直接回答；没问画面时不用主动描述。' : readWatchCfg().on?'当前没有新鲜画面，涉及屏幕的问题请说明尚未取得当前画面，不要沿用旧图。':'')
        + (withImage && lines ? '这会儿环境里在说的话（机器转写，有错字）：' + lines + '。' : '')
        + (retry ? '刚才画面没能传过来，如果这句需要看屏幕，请直接说明。' : '')
        + '像打电话那样答我：一两句完整的口语，正常使用中文逗号和句号，不用空格或换行代替标点；别列清单、别复述我说过的话。要配动作就照常写〔动作〕。）\n' + heard
      const stale = () => seq !== G.callSeq || q.busy !== flight || !readCallCfg().on || !!owned && G.mhubCall !== owned
      const send = async (image, retry = false) => {
        const sent = await talkTurn('call', {
          heard, prompt: prompt(!!image, retry), probe: PROBE.call, image, local: !!owned, stale, flight,
          retryWithoutImage: image ? () => send(null, true) : null,
        })
        if (!sent.to) callDone(flight)
      }
      q.timer = setTimeout(() => {
        if (q.busy !== flight) return
        api.log.warn('电话：应答超时，继续听下一句')
        if (!stale()) speakWatch('刚才那句没答上来，可以再说一次吗？', '电话')
        callDone(flight)
      }, 40000)
      q.timer.unref?.()
      await send(held ? { base64: held.b64, mediaType: held.mediaType } : null)
    }

    // 一轮电话结束了（旁路在 turn/end 叫它）：接着处理排队的那句，没有就放开 busy。
    function callDone(flight) {
      const q = G.callQ
      if (!q || q.busy !== flight) return
      clearTimeout(q.timer)
      if (G.turnQ) G.turnQ = G.turnQ.filter(entry => entry.flight !== flight)
      const next = q.pending
      q.pending = ''
      // 必须先放开 busy 再投下一句 —— callTurn 头上那道 busy 闸会把「接着处理」又塞回排队，
      // 表现就是第二句永远投不出去（2026-11-06 实测踩到）。
      q.busy = false
      if (next && readCallCfg().on) { api.log.info('电话：接着处理排队的那句'); void callTurn(next) }
    }

    function resetCallQueue() {
      G.callSeq = (G.callSeq || 0) + 1
      clearTimeout(G.callQ?.timer)
      G.callQ = null
      if (G.turnQ) G.turnQ = G.turnQ.filter(entry => entry.kind !== 'call' || entry.deliver)
    }

    // 语音回复的清洗：剥掉只在 QQ 里有意义的标记，顺手去 Markdown。
    // <body:> 交给 parseTag 处理（那是动作协议），这里只处理「发消息用的」那些。
    let stripMd = null
    try { const m = api.lib('chat/reply.js'); if (m && typeof m.stripMarkdown === 'function') stripMd = m.stripMarkdown } catch {}
    // DSML 残渣：DeepSeek 的工具调用标记（<｜｜DSML｜｜invoke name="…">…</｜｜DSML｜｜invoke>）。
    // 她一轮里其实调了工具（开灯、截图、发文件、查天气），**开头**那半被模型层正确解析成工具调用了，
    // **结尾的闭合标签**却留在正文里 → 先生 QQ 上收到的「</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>」就是这个。
    // 不是她在说这句话，也不是什么暗号，纯是解析器的尾巴没扫干净。宿主在 asar 里改不动，只能在出口洗。
    // 竖线有全角 ｜(U+FF5C) 和半角 | 两种写法，都兜；后面跟不跟参数名、带不带尖括号都兜。
    const DSML_RE = /<\s*\/?\s*[｜|]{2}\s*DSML\s*[｜|]{2}[^>]*>/gi
    const DSML_LOOSE_RE = /[｜|]{2}\s*DSML\s*[｜|]{2}\s*(parameter|invoke|calls|tool_calls)?\s*(&gt;|>)?/gi
    function stripDsml(t) {
      const s0 = String(t || '')
      if (!/DSML/i.test(s0)) return s0 // 绝大多数回复走这条，别做多余的正则
      return s0
        .replace(DSML_RE, '')
        .replace(DSML_LOOSE_RE, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
    }
    function cleanForPet(t) {
      let s = stripDsml(t)
        .replace(/<voice>([\s\S]*?)<\/voice>/g, '$1')
        .replace(/<\/?sticker[^>]*>/g, '')
        .replace(/<poke\s*\/?>/g, '')
        .replace(/<reply:[^>]*>/g, '')
        .replace(/\[沉默\]/g, '')
        .replace(/\|\|\|/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
      if (stripMd) s = stripMd(s)
      const checked=inspectSpeechOutput(s)
      if(!checked.valid&&String(t||'').trim()){
        G.speechReplyHealth={at:Date.now(),ok:false,reason:checked.reason,message:'模型返回了空内容或内部标记，请重试；连续异常时可重新开始后台语音会话。'}
        api.log.warn('语音回复已拦截：'+checked.reason+'（长度 '+String(t||'').length+'）')
      }else if(checked.valid){G.speechReplyHealth={...G.speechReplyHealth,at:Date.now(),ok:true,reason:null}}
      return checked.text
    }

    api.route('/manual', async () => ({ ok: true, manual: buildManual(), miss: G.miss }))

    // ---------- 陪看：她说的话 → 桌宠 ----------
    // 和耳朵/电话的区别：这里**允许**她不写动作标签（她只是随口一句），
    // 但必须认出「这一张没什么可说的」——提示词让她只回一个「看」字，那就一声不出。
    // 不认这个信号的话，每张图都会让桌宠弹一句「看」，比不说话还吵。
    const WATCH_SILENT = /^[\s，。.、！!？?~～…]*(看|嗯+|无|没有|—+|-+)?[\s，。.、！!？?~～…]*$/
    // silentOk：只有陪看认「只回一个看」＝这一张没什么可说的、别出声。
    // 电话/耳朵里一个「嗯」就是正经回答，得念出来 —— 所以这个判断不能对三条线一视同仁。
    function speakWatch(raw, purpose = '陪看', silentOk = false, watchRequestId) {
      const cleaned = cleanForPet(raw)
      if (!cleaned) return ''
      const p = parseTag(cleaned)
      const clean = String(p.clean || '').trim()
      if (!clean) return ''
      if (silentOk && WATCH_SILENT.test(clean)) return ''
      let motion = p.motion
      if (!motion && !p.beats.length && api.settings().auto !== false) motion = pickMotionByText(clean, readClips())
      const anim = animFor({ ...p, motion })
      if (!dispatchToPet(clean, anim, purpose, watchRequestId)) return ''
      return clean
    }

    // ---------- 4. DSH 窗口直聊旁路：session/event ----------
    // 主人在 DSH 会话窗口里直接打字时，回复不经过 QQ 投递管道（hooks.reply 管不到），
    // 这里直接听 DSH 会话事件：窗口直聊的回合结束时，把带标签的回复剥标签后投给桌宠。
    // 标签本身没法从窗口显示里抹掉（session/event 是只读旁路），窗口里会看到她写的标签原文——
    // QQ 里则照常隐形。子代理/系统轮次不参与。
    try {
      const gen = ++G.gen // 换代：上一代监听器立刻失效（热加载残留不会再投递）
      const winTurns = new Map() // sessionId → { direct, turn, text }
      const textOfMsg = (message) => (Array.isArray(message && message.content)
        ? message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
        : '')
      const offSessionEvent = api.dsh.on('session/event', (session, event) => {
        try {
          if (gen !== G.gen) return // 旧代监听器空转（热加载残留），绝不重复投递
          const type = String((event && event.type) || '')
          if (!type) return
          const header = session && typeof session.header === 'object' ? session.header : null
          if (header && (header.origin === 'subagent' || Number(header.delegationDepth) > 0)) return
          const sid = String((header && header.id) || (session && session.id) || 'unknown')
          const st = winTurns.get(sid) || {}
          winTurns.set(sid, st)
          const chatOf = () => {
            try {
              const hub = api.core && api.core.hub
              return String((hub && typeof hub.chatOfSession === 'function' ? hub.chatOfSession(sid) : '') || '')
            } catch { return '' }
          }
          if (type === 'user/message') {
            const src = event.data && event.data.source
            st.direct = Boolean(src && src.kind === 'user') // 窗口直打才算；QQ 转发的不算
            st.kind = String((src && src.kind) || '(空)')   // 排查用：不是 'user' 就说明这是别的入口进来的
            // 这一轮是不是我们投进去的？按提示词开头认领 —— 三条线共用一条会话，chatId 已经分不出来。
            // user/message 的 data 本身就是那条消息（{id, role, content, source}），
            // 别的类型里 message 是嵌在 data.message —— 两种都兜一下。
            const uMsg = (event.data && event.data.message) || event.data
            // 只认不洗：同一轮里除了我们投的那句，DSH 还会插注入消息（time-context 等）也发
            // user/message。以前这里是直接赋值，注入那条一进来就把认领结果盖成 null，
            // 整轮被当成「不是我们投的」扔掉 —— 桌宠一声不响，日志写「没对上投递记录」。
            const claimed = claimTurn(textOfMsg(uMsg))
            if (claimed) (st.entries ||= []).push(claimed)
            return
          }
          if (type === 'assistant/message') {
            const d = event.data || {}
            if (d.interrupted) return
            const t = textOfMsg(d.message)
            if (t) { st.turn = d.turn; st.text = t }
            return
          }
          if (type !== 'turn/end') return

          const d = event.data || {}
          const text = st.turn === d.turn ? (st.text || '') : ''
          const entries = st.entries || []
          const mine = entries.findLast(entry => entry.flight || entry.deliver) || entries.at(-1)
          const direct = Boolean(st.direct)
          const srcKind = st.kind || '?'
          const chat = chatOf()
          st.direct = false; st.text = ''; st.entries = null
          const completed = d.reason && d.reason.kind === 'completed'

          // ---- 我们自己投进去的那一轮：耳朵 / 电话 / 陪看都落在这儿 ----
          if (mine) {
            if(mine.kind==='watch'&&watchStale(mine)){for(const entry of entries)releaseTurn(entry);return}
            if(mine.kind==='watch'&&!completed)G.watchStatus={...G.watchStatus,modelError:{stage:'model',message:'模型未正常完成回复',requestId:mine.requestId}}
            // Harness may splice a watch frame and a phone utterance into the
            // same turn. Release every claimed entry, even on provider errors.
            for (const entry of entries.filter(entry => entry !== mine)) {
              releaseTurn(entry)
              entry.deliver?.('', {stage:'superseded',message:'这句语音已被后来的对话替换。'})
            }
            const label = KIND_LABEL[mine.kind] || '语音'
            let retrying = false
            try {
              if (mine.deliver) {
                const reply = completed ? parseTag(cleanForPet(text)).clean : ''
                // Carry this turn's failure with its callback. A global health
                // record may belong to a previous turn or another channel.
                mine.deliver(reply, completed ? (!reply ? {stage:'reply-validation',message:'模型没有返回可朗读的回复，请重试。'} : undefined)
                  : {stage:'model',message:String(d.reason?.message || (d.reason?.kind==='cancelled' ? '这次语音对话已取消。' : '模型未正常完成回复。')).slice(0,240)})
              } else if (!completed) {
                api.log.warn(`${label}：这一轮没正常结束（${String(d.reason?.kind || '?')}）`)
                if (mine.flight && !mine.stale()) {
                  if (d.reason?.kind === 'error' && mine.retryWithoutImage) {
                    retrying = true
                    void mine.retryWithoutImage().catch(() => releaseTurn(mine))
                  } else if (d.reason?.kind === 'error') {
                    speakWatch('刚才模型连接失败了，我还在听，你可以再说一次。', '电话')
                  }
                }
              } else if (mine.to === 'system') {
                speakTurn(mine, text)
              }
            } finally {
              if (!retrying) releaseTurn(mine)
            }
            return
          }
          if (!completed) return
          // 后台那条会话里没认领到的一轮：不是三个功能投的（主人直接在窗口里打字），老实不动
          if (chat === TALK_CHAT) {
            // No causal identity: leave queued requests to their own turn or timeout.
            talkQueue()
            api.log.info('后台会话：这一轮没对上投递记录，不投桌宠')
            return
          }
          // 下面几种「这一轮没投桌宠」的情况原来都是静默 return —— 出问题时完全看不出断在哪一步。
          if (!direct) { api.log.info('窗口直聊：这一轮不是窗口直打（source.kind=' + srcKind + '），不投桌宠'); return }
          if (!text) return
          const p = parseTag(text)
          // 只有带标签的回复才投：手册只在大肥鱼的 preset 里，编程代理不会写这些标签——
          // 这样旁路绝不会把别的 DSH 会话的话冒充到桌宠上
          if (!p.hasTag || !p.clean) { api.log.info('窗口直聊：这一轮没写〔〕/<body:> 标签，按设计不投桌宠'); return }
          // 同一句话可能已经由 reply 拦截处理过（QQ 消息也会命中这里）→ 占位失败就直接退出，
          // 绝不能再往下走 animFor（那会覆盖掉正在用的 beat.json）
          if (!claimText(p.clean, '窗口直聊')) return
          let motion = p.motion
          if (!motion && !p.beats.length && api.settings().auto !== false) motion = pickMotionByText(p.clean, readClips())
          const anim = animFor({ ...p, motion })
          if (dispatchToPet(p.clean, anim, '窗口聊天')) {
            api.log.info('DSH 窗口直聊 → 桌宠：' + p.clean.slice(0, 60) + '（' + anim + '）')
          } else {
            api.log.info('窗口直聊：投递被拦（模块关闭 / 桌宠服务不可用）')
          }
        } catch (e) { /* 旁路绝不影响会话本身 */ }
      })
      // api.dsh.on 的返回值不一定能用来摘（实测不是可靠 disposer）：能摘就记进 G.offs，
      // 摘不掉也无所谓——代际令牌已经让旧监听器空转。
      if (typeof offSessionEvent === 'function') {
        G.offs.push(offSessionEvent)
        api.onDispose(() => {
          try {
            offSessionEvent()
            const i = G.offs.indexOf(offSessionEvent)
            if (i >= 0) G.offs.splice(i, 1)
          } catch {}
        })
      }
      api.log.info('DSH 窗口直聊旁路已挂上（session/event）')
    } catch (e) {
      api.log.warn('DSH 会话监听挂不上（窗口直聊联动不可用）：', String((e && e.message) || e))
    }

    // ---------- 4.5 三个工具：她查动作、查关节、自己造动作 ----------
    // 这是「把创作能力交给她」的落点：动作库不是死的清单，是她能扩写的东西。
    // 造出来的动作写进 clips.json，渲染页 3 秒内热加载，下一句话就能用。
    const DRIVE_NAMES = ['AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput']

    function makeMotion(args = {}) {
      const clips = readClips()
      const name = String(args['名称'] || args.name || '').trim()
      const when = String(args['何时用'] || args.when || '').trim()
      const dur = Number(args['时长'] || args.dur || 2.4)
      const base = String(args['基底'] || args.base || '').trim()
      const expr = String(args['表情'] || args.expr || '').trim()
      const tagRaw = String(args['关键词'] || args.tags || '').trim()
      let tracks = args['轨迹'] || args.tracks || {}
      const warns = []

      if (!name) return { ok: false, message: '缺「名称」。给她起个短名字，比如「踮脚」' }
      if (name.length > 10) return { ok: false, message: '名称太长了（最多 10 个字），标签里不好写' }
      if (/[<>，,]/.test(name)) return { ok: false, message: '名称里不能有逗号或尖括号（会和标签语法打架）' }
      if (!when) return { ok: false, message: '缺「何时用」。写清楚什么情绪/什么场合该做这个动作，否则她自己也不会想起来用它' }
      if (base && !['举手', '竖手指', '狗尾草'].includes(base)) return { ok: false, message: `基底只能是 举手 / 竖手指 / 狗尾草 / 留空，你写的是「${base}」` }
      if (expr && !faceNames().includes(expr)) return { ok: false, message: `表情「${expr}」不在模型里。可用的：${faceNames().join('、')}` }
      if (!(dur >= 0.4 && dur <= 20)) return { ok: false, message: '时长要在 0.4 ~ 20 秒之间' }

      if (typeof tracks === 'string') {
        try { tracks = JSON.parse(tracks) } catch (e) {
          return { ok: false, message: '轨迹不是合法 JSON：' + String(e.message).slice(0, 80) + '。格式是 {"d.AngleZ":[[0,0],[0.35,12],[1,0]]}' }
        }
      }
      if (!tracks || typeof tracks !== 'object') return { ok: false, message: '轨迹要是对象，键是参数名，值是 [[时间0~1, 数值], ...]' }

      const dict = paramDict()
      const keys = Object.keys(tracks)
      if (!keys.length) return { ok: false, message: '轨迹是空的，一条都没写' }
      if (keys.length > 24) return { ok: false, message: `轨道太多了（${keys.length} 条，最多 24 条）。一个动作挑最关键的 6~12 条就够` }

      const clean = {}
      for (const k of keys) {
        const m = /^([dpa])\.([A-Za-z0-9_]+)$/.exec(k)
        if (!m) { warns.push(`跳过「${k}」：键名要写成 d.xxx / p.xxx / a.xxx`); continue }
        const [, ch, pid] = m
        let range = null
        if (ch === 'd') {
          if (!DRIVE_NAMES.includes(pid)) { warns.push(`跳过「${k}」：d. 后面只能是 ${DRIVE_NAMES.join('/')}`); continue }
          range = dict[pid] || null
        } else {
          if (!dict[pid]) { warns.push(`跳过「${k}」：模型里没有这个参数（用 live2d_dict 查一下名字）`); continue }
          range = dict[pid]
        }
        const arr = Array.isArray(tracks[k]) ? tracks[k] : null
        if (!arr || arr.length < 2) { warns.push(`跳过「${k}」：至少要两个关键帧 [[0,0],[1,1]]`); continue }
        const pts = []
        let lastT = -1
        for (const p of arr) {
          if (!Array.isArray(p) || p.length < 2) continue
          let t = Number(p[0]), v = Number(p[1])
          if (!Number.isFinite(t) || !Number.isFinite(v)) continue
          t = Math.max(0, Math.min(1, t))
          if (t < lastT) t = lastT // 时间必须递增，否则采样会跳
          lastT = t
          if (range) {
            const lo = Number(range.min), hi = Number(range.max)
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
              if (v < lo || v > hi) { warns.push(`「${k}」有个值 ${v} 超出范围，已夹到 ${Math.max(lo, Math.min(hi, v))}`); v = Math.max(lo, Math.min(hi, v)) }
            }
          }
          pts.push([+t.toFixed(3), +v.toFixed(3)])
        }
        if (pts.length >= 2) clean[k] = pts
      }
      if (!Object.keys(clean).length) return { ok: false, message: '一条有效轨道都没有：' + warns.slice(0, 4).join('；') }

      const clip = { when, dur: +dur.toFixed(2) }
      if (tagRaw) clip.tags = tagRaw.split(/[,，\s]+/).filter(Boolean).slice(0, 12)
      if (base) clip.base = base
      if (expr) clip.expr = expr
      clip.tracks = clean

      const existed = Object.prototype.hasOwnProperty.call(clips, name)
      clips[name] = clip
      if (!existed) clip.born = new Date().toISOString().slice(0, 10) // 面板会把她新造的动作标出来
      try { writeClips(clips) } catch (e) {
        return { ok: false, message: '写入动作库失败：' + String(e?.message || e) }
      }
      api.log.info(`Live2D：${existed ? '更新' : '新增'}动作「${name}」（${Object.keys(clean).length} 轨 / ${dur}s）`)
      const lines = [
        `${existed ? '已更新' : '已新增'}动作「${name}」：${Object.keys(clean).length} 条轨道，${dur} 秒${base ? `，形态 ${base}` : ''}${expr ? `，表情 ${expr}` : ''}。`,
        '桌宠 3 秒内热加载，下一句回复写 <body:' + name + '> 就会演出来。',
      ]
      if (warns.length) lines.push('另外：' + warns.slice(0, 5).join('；'))
      lines.push('这只是第一版。主人看过之后要是说哪里怪，按他的描述调数值再造一次（同名会覆盖），别怕改。')
      return { ok: true, message: lines.join('\n'), name, tracks: Object.keys(clean).length }
    }

    api.defineTool({
      name: 'live2d_motions',
      description: '看自己现在有哪些动作、每个动作什么时候用。想做一个动作之前，先调这个看一眼，避免重复造。',
      properties: {
        含细节: { type: 'boolean', description: '要不要连每条轨道一起列出来（想参考别人的写法时用），默认不用' },
      },
      execute: async (p) => {
        const clips = readClips()
        const names = Object.keys(clips)
        if (!names.length) return { ok: false, message: '动作库读不到，检查 ' + CLIPS_FILE }
        const list = names.map((n) => {
          const c = clips[n]
          const extra = p && p['含细节'] ? `  [${c.dur}s, ${Object.keys(c.tracks || {}).length}轨${c.base ? ', ' + c.base : ''}]\n     ${JSON.stringify(c.tracks)}` : ''
          return `· ${n}：${c.when || '（没写何时用）'}${extra}`
        })
        return {
          ok: true,
          message: `动作库现在有 ${names.length} 个动作：\n${list.join('\n')}\n\n`
            + '这些动作都能加修饰（写 <body:微快点头×3> 这样）：微/小/大/狠 调力度，快/慢 调节奏，×N 连做 N 次（≤5），:左 镜像到另一侧。',
        }
      },
    })

    api.defineTool({
      name: 'live2d_dict',
      description: '查身体的参数词典：某个关节叫什么、范围多少。造动作前想确认参数名或量程时用。不带关键词就返回分组概览。',
      properties: {
        关键词: { type: 'string', description: '比如「手臂」「眉」「耳」「Angle」「胸」「胯」，也接受参数名如 Param36' },
      },
      execute: async (p) => {
        const dict = paramDict()
        const kw = String((p && p['关键词']) || '').trim()
        const entries = Object.entries(dict)
        if (!kw) {
          const groups = {
            '身体方向（d.）': 'AngleX / AngleY / AngleZ / LeanInput / PositionX / PositionY',
            '右臂': 'Param36(抬大臂) RArm(外张) RForearm Param41(小臂Z) RWrist RHand',
            '左臂': 'Param62(抬大臂) LArm LForearm Param60 LWrist LHand',
            '躯干': 'ChestX1-3 ChestY1-4 ShoulderX/Y/Z HipAngleX/Y/Z HipZ1/2',
            '眼眉': 'EyeSmile ParamEyeLOpen ParamEyeROpen ParamBrowLY/RY ParamBrowLAngle',
            '嘴': 'ParamMouthForm MouthSmile_L/R Mouthpucker CheeckPuff JawOpen',
            '耳': 'LEar1-3 REar1-3',
            '手型（只能靠 base 切）': 'Movement1(狗尾草) Movement2(举手) Movement3(竖手指)',
          }
          return { ok: true, message: '参数共 ' + entries.length + ' 个，常用分组：\n' + Object.entries(groups).map(([k, v]) => `· ${k}：${v}`).join('\n') + '\n\n细节查法：带「关键词」再调一次。完整说明见 ' + join(api.runtime.dataPetDir, '关节词典.md') }
        }
        const hit = entries.filter(([id, v]) => id.toLowerCase().includes(kw.toLowerCase()) || String(v.label || '').includes(kw))
        // 「手臂/胳膊/手」这类大词直接命中整组（参数 id 里没有「手臂」两个字，只靠字符串匹配会漏）
        const GROUP_HINT = {
          '手臂': ['Param36', 'RArm', 'RForearm', 'Param41', 'RWrist', 'RHand', 'Param62', 'LArm', 'LForearm', 'Param60', 'LWrist', 'LHand'],
          '胳膊': ['Param36', 'RArm', 'RForearm', 'Param41', 'RWrist', 'Param62', 'LArm', 'LForearm', 'Param60', 'LWrist'],
          '手': ['Param36', 'RArm', 'RForearm', 'Param41', 'RWrist', 'RHand', 'Param62', 'LArm', 'LForearm', 'Param60'],
          '头': ['AngleX', 'AngleY', 'AngleZ', 'ParamBrowLY', 'ParamBrowRY', 'ParamEyeLOpen', 'ParamEyeROpen'],
          '腰': ['HipAngleX', 'HipAngleY', 'HipAngleZ', 'HipZ1', 'HipZ2'],
          '表情': ['EyeSmile', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'ParamBrowLY', 'ParamBrowRY', 'CheeckPuff'],
        }
        let list = hit
        const group = GROUP_HINT[kw]
        if (group) {
          list = group.filter((g) => dict[g]).map((g) => [g, dict[g]])
          if (!list.length) list = hit
        }
        if (!list.length) return { ok: true, message: `没有匹配「${kw}」的参数。试试更短的关键词（手臂 / 眉 / 耳 / Angle）` }
        return { ok: true, message: list.slice(0, 25).map(([id, v]) => `${id}（${v.label || '无标签'}）范围 ${v.min}~${v.max}，默认 ${v.default}`).join('\n') }
      },
    })

    api.defineTool({
      name: 'live2d_make_motion',
      description: '给自己造一个新动作（或覆盖已有动作）。动作 = 多条关节轨道在同一时间轴上同时跑，所以「抬手的同时扭腰低头」是一条动作能做出来的。造完 3 秒内自动生效，可直接用 <body:名字> 演出。做之前建议先调 live2d_dict 确认参数名。',
      properties: {
        名称: { type: 'string', description: '动作名，2~6 个字，比如「踮脚」「抱拳」「甩头」' },
        何时用: { type: 'string', description: '什么情绪/场合该做这个动作。这句会被写进你的手册，你自己以后靠它想起来用' },
        轨迹: { type: 'string', description: 'JSON。键是参数名（d.=身体角度/前后，p.=关节覆盖写，a.=表情叠加），值是 [[时间0~1, 数值], ...]。例：{"d.AngleZ":[[0,0],[0.3,12],[1,0]],"p.Param36":[[0,0],[0.2,1],[1,0]],"a.EyeSmile":[[0,0],[0.3,0.5],[1,0]]}' },
        时长: { type: 'number', description: '秒，0.4~20，日常动作 2~3 秒最自然' },
        基底: { type: 'string', description: '手型：举手（手在胸前）/ 竖手指 / 狗尾草；不需要就留空' },
        表情: { type: 'string', description: '可选，模型自带表情名（脸红、爱心眼…）。一般用 a.EyeSmile 之类自己画更自然' },
        关键词: { type: 'string', description: '可选，逗号分隔。她说话内容里出现这些词时，系统会自动配这个动作' },
      },
      required: ['名称', '何时用', '轨迹'],
      execute: async (p) => makeMotion(p || {}),
    })

    // 她自己的「长相」：模型自带一批 0~1 的形象开关（换装/道具/体型），和动作表情是两条线。
    // 只开放这几项的理由见上面 LOOK_KEYS 的注释——情绪符号绝不能常驻。
    const LOOK_ITEMS = { '大钢盆': 'key10', '黑框眼镜': 'key11', '单片眼镜': 'key12', '长短裙': 'Clothes1', '体型': 'Clothes2', '鞋子': 'Clothes4', '鞋袜': 'Clothes4', '尾巴': 'Clothes5' }
    function bodyText(v) {
      const n = Number(v) || 0
      if (n < 0.15) return null            // 默认体型不用特意说，省得每句都挂着
      return n < 0.7 ? '中等身材' : 'Q 版小个子'
    }
    function shoesText(v) {
      const n = Number(v) || 0
      if (n <= 0.02) return null           // 穿鞋是常态，不用特意说
      if (n >= 0.98) return '光着脚'
      return '鞋脱了一半（' + Math.round(n * 100) + '%）'
    }
    function tailText(v) {
      const n = Number(v) || 0
      if (n >= 0.98) return '有尾巴'
      if (n <= 0.02) return '没尾巴'
      return '尾巴半透明（' + Math.round(n * 100) + '%）'
    }
    function describeLook(l) {
      return [
        bodyText(l.Clothes2),
        l.key10 ? '头顶大钢盆' : null,
        l.key11 ? '黑框眼镜' : null,
        l.key12 ? '单片眼镜' : null,
        l.Clothes1 ? '短裙' : '长裙',   // 实测：1=短裙（露腿）/ 0=长裙（及踝）
        shoesText(l.Clothes4),
        tailText(l.Clothes5),
      ].filter(Boolean).join('、')
    }
    api.defineTool({
      name: 'live2d_look',
      description: '看或改自己现在的长相：大钢盆、黑框眼镜、单片眼镜、长短裙、体型、鞋子、尾巴。主人说「换个样子」「戴上眼镜」「穿短裙」「变小一点」「脱鞋」，或者你自己想换个装扮时用。改完会长久保持（重启也在），直到再改。体型分 默认/中/Q版 三档：默认是上半身特写，中是半身像，Q 版是小小一只完整站在画面里。鞋子和尾巴可以给中间值（比如脱到一半）。',
      properties: {
        项目: { type: 'string', description: '大钢盆 / 黑框眼镜 / 单片眼镜 / 长短裙 / 体型 / 鞋子 / 尾巴。留空就只报当前长相' },
        设置: { type: 'string', description: '开关类写 开 或 关（长短裙写 长 或 短）；体型写 默认 / 中 / 小，也可以直接写 0~1 的小数；鞋子写 穿 / 脱（或 0~1 的小数表示脱了几分）；尾巴写 露 / 收（或 0~1 的小数）。留空表示切换当前状态' },
      },
      execute: async (p) => {
        const cur = readLook()
        const item = String((p && p['项目']) || '').trim()
        if (!item) return { ok: true, message: '你现在的样子：' + describeLook(cur) + '。能改的只有：' + Object.keys(LOOK_ITEMS).join('、') }
        const key = LOOK_ITEMS[item]
        if (!key) return { ok: false, message: '「' + item + '」不在能改的范围里。只有这几项：' + Object.keys(LOOK_ITEMS).join('、') }
        const s = String((p && p['设置']) || '').trim()
        let v
        if (key === 'Clothes2') {
          // 体型：留空就按 默认 → 中 → Q版 → 默认 循环；也接受直接给数字（无级）
          if (!s) v = cur.Clothes2 < 0.2 ? 0.4 : (cur.Clothes2 < 0.7 ? 1 : 0)
          else if (/^(默认|正常|原来|原样|大|不变)$/.test(s)) v = 0
          else if (/^(中|中等|中号|小一点|稍微小)$/.test(s)) v = 0.4
          else if (/^(小|小号|迷你|矮|小孩|幼|q版|q)$/i.test(s)) v = 1
          else if (/^\d*\.?\d+$/.test(s) && Number(s) >= 0 && Number(s) <= 1) v = Number(s)
          else return { ok: false, message: '体型写 默认 / 中 / 小（或 Q版），也可以直接写 0~1 的小数' }
        } else if (LOOK_CONT[key]) {
          // 连续类（鞋子 / 尾巴 / 裙子）：先认文字，再认数字
          if (!s) v = cur[key] >= 0.5 ? 0 : 1
          else if (/^(开|戴|要|有|长|是|全部|全满|true|on)$/i.test(s)) v = 1
          else if (/^(关|脱|不要|没|无|短|收起|false|off)$/i.test(s)) v = 0
          else if (/^(穿)$/.test(s)) v = 0
          else if (/^\d*\.?\d+$/.test(s) && Number(s) >= 0 && Number(s) <= 1) v = Number(s)
          else return { ok: false, message: '「' + s + '」没看懂。写 开 / 关（鞋子写 穿 / 脱、尾巴写 露 / 收），或者直接给 0~1 的小数' }
        } else if (!s) v = cur[key] ? 0 : 1
        else if (/^(开|戴|戴眼镜|要|有|长|是|true|on|1)$/i.test(s)) v = 1
        else if (/^(关|摘|不戴|不要|没|无|短|否|false|off|0)$/i.test(s)) v = 0
        else return { ok: false, message: '「' + s + '」没看懂。开关写 开 或 关（长短裙写 长 或 短）' }
        const next = saveLook({ [key]: v })
        const extra = key === 'Clothes2' ? '变小之后桌宠会重新取景，整个人缩在画面中间。' : ''
        return { ok: true, message: '改好了，你现在：' + describeLook(next) + '。（两秒内生效）' + extra }
      },
    })

    // HTTP 版（方便自测/排查：GET /motions 看库，POST /make-motion 造动作）
    api.route('/motions', async () => ({ ok: true, clips: readClips() }))
    api.route('/make-motion', async (req) => {
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const q = api.core.http.query(req)
      return makeMotion({ ...q, ...body })
    })

    // ---------- 6. 面板的动作库：列清单 + 点一下就演一遍 ----------
    // 设计意图：动作库是「活文件」，面板每次都现读 clips.json，所以她（或我）新造的动作
    // 下次打开面板就在列表里，不需要改代码、不用重启。这就是先生要的「以后新的也会放到这里」。
    api.route('/clips', async () => {
      const clips = readClips()
      let mtime = 0
      try { mtime = statSync(CLIPS_FILE).mtimeMs } catch {}
      const list = Object.entries(clips).map(([name, c]) => ({
        name,
        when: String((c && c.when) || ''),
        dur: Number(c && c.dur) || 0,
        base: String((c && c.base) || ''),
        expr: String((c && c.expr) || ''),
        tags: Array.isArray(c && c.tags) ? c.tags.slice(0, 12) : [],
        tracks: c && c.tracks ? Object.keys(c.tracks).length : 0,
        born: String((c && c.born) || ''), // 她造这个动作的日期；原生 15 个没有
      }))
      return {
        ok: true, count: list.length, clips: list,
        updatedAt: mtime ? new Date(mtime).toISOString() : '',
        file: CLIPS_FILE,
      }
    })

    api.route('/play', async (req) => {
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const q = api.core.http.query(req)
      const name = String(body.name || q.name || '').trim()
      const clips = readClips()
      if (!name) return { ok: false, message: '没给动作名' }
      if (!Object.prototype.hasOwnProperty.call(clips, name)) {
        return { ok: false, message: `动作库里没有「${name}」（可能刚被改名或删掉，点「刷新」看看）` }
      }
      const pet = api.use('pet')
      const on = pet && typeof pet.online === 'function' ? pet.online() : null
      if (!on || !on.online) return { ok: false, message: '桌宠没连上：先在面板启动桌宠，等两三秒再试' }
      const c = clips[name]
      // 只演动作、不念语音：预览是为了看形体，出声反而吵。
      // purpose 写成「预览」，桌宠主进程看见这个 purpose 就不弹气泡（不然气泡正好挡住她）。
      try {
        const r = await pet.dispatch({
          text: `（预览动作：${name}）`, modality: 'text',
          anim: [name, c.expr || '', ''].join(','),
          via: 'pet', noFallback: true, purpose: '预览', force: true, // force：主人在面板手点的，不算打扰
        })
        if (r && r.ok === false) return { ok: false, message: '没投出去：' + (r.reason || r.error || '未知原因') }
        const dur = Number(c.dur) || 0
        return { ok: true, name, message: `已让她演「${name}」（${dur}s，${Object.keys(c.tracks || {}).length} 条轨道同时跑）` }
      } catch (e) {
        return { ok: false, message: '投递异常：' + String((e && e.message) || e) }
      }
    })

    // ---------- 6b. 复位：把她收回「刚启动」的初始状态 ----------
    // 只让她在动作库页面点播是看不出「收得不干净」的 —— 连演几个动作后手型、表情、姿势
    // 会各自停在半路。这个按钮就是那把扫帚：动作库 clip、手型开关、表情层、姿势、
    // 思考态、说话层一次收干净（具体在渲染页 resetToBase 里做）。
    api.route('/reset', async () => {
      const pet = api.use('pet')
      const on = pet && typeof pet.online === 'function' ? pet.online() : null
      if (!on || !on.online) return { ok: false, message: '桌宠没连上：先在面板启动桌宠，等两三秒再试' }
      try {
        // text 必须有（dispatch 不接受空文本），但 purpose=复位 → 桌宠不弹气泡、不出声，
        // 渲染页看到 reset 标记就直接走复位逻辑，这行字不会被显示。
        const r = await pet.dispatch({
          text: '（复位）', modality: 'text', anim: '',
          via: 'pet', noFallback: true, purpose: '复位', force: true,
        })
        if (r && r.ok === false) return { ok: false, message: '没投出去：' + (r.reason || r.error || '未知原因') }
        return { ok: true, message: '已复位：动作、手型、表情、姿势都收回初始状态' }
      } catch (e) {
        return { ok: false, message: '投递异常：' + String((e && e.message) || e) }
      }
    })

    // ---------- 5. 桌宠进程管理（面板按钮用；分离进程，DSH 关了桌宠也活着） ----------
    // 注意：只杀自己记录的 pid 树，绝不碰 DSH 进程。PET_DIR 在文件顶部统一定义。
    /**
     * 模型装没装：找 model/ 下面任意一份 *.moc3。
     * 不校验文件名 —— 换皮的人可能用别的模型，只要 Cubism 4 的 moc3 在就算装好。
     * 这么设计的另一个原因：模型受作者许可保护、不能随插件打包，必须由用户自己放进来。
     */
    function hasModel() { return api.runtime.hasModel() }
    function petRunning() { return api.runtime.petRunning() }
    // ---------- 5. 模型大小 / 常驻外观（面板 → pet.json → 桌宠主进程每 2s 轮询转发渲染页） ----------
    const petSettingsFile = () => join(api.dataDir(), 'pet.json')
    // 读-改-写：pet.json 里同时住着 scale 和 look，谁都不能整份覆盖（v1.0.0 的 AI 日报
    // 就是因为整份覆盖抹掉了 lastDay，2026-11-06 连发 9 期）。这里统一走这两个函数。
    function readPetSettings() {
      return api.runtime.readPetSettings()
    }
    function writePetSettings(patch) {
      if(patch.watch){invalidateWatch();patch={...patch,watch:{...patch.watch,sessionVersion:randomUUID()}};G.watchObserved=patch.watch.sessionVersion;G.watchStatus={sessionVersion:patch.watch.sessionVersion,at:Date.now(),capture:{phase:patch.watch.on?'preparing':'stopped'}}}
      api.runtime.writePetSettings(patch)
    }
    function readScale() {
      const z = Number(readPetSettings().scale)
      return (z >= 0.4 && z <= 2.5) ? z : 1
    }
    api.route('/size', async (req, res) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const z = Number(body.scale != null ? body.scale : q.scale)
      if (!(z >= 0.4 && z <= 2.5)) return { ok: false, message: '大小要在 0.4 ~ 2.5 之间' }
      writePetSettings({ scale: z })
      api.log.info('Live2D 模型大小 → ' + z)
      return { ok: true, scale: z, message: '已设为 ' + Math.round(z * 100) + '%（桌宠两秒内跟上）' }
    })

    // 常驻外观：模型自带 0~1 的形象开关。只开放这六项——
    // 换装/道具/体型是「形态」，可以一直挂着；key1~key9 那些（黑脸/落泪/圈圈眼/脸红…）
    // 是一次性的情绪符号，常驻会变成「永远在哭」，不该走这条路。
    const LOOK_KEYS = ['key10', 'key11', 'key12', 'Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5']
    const LOOK_DEFAULT = { key10: 0, key11: 0, key12: 0, Clothes1: 1, Clothes2: 0, Clothes3: 0, Clothes4: 0, Clothes5: 1 }
    const LOOK_LABEL = {
      key10: '大钢盆（开关）', key11: '黑框眼镜（开关）', key12: '单片眼镜（开关）',
      Clothes1: '裙长（0 及踝长裙 → 0.5 及膝 → 0.55 换短裙 → 1 超短；0.5 附近是两套裙子整组换款，会跳一下）',
      Clothes2: '体型（0 默认 / 0.4 中 / 1 Q版，中间任意值都成立）',
      Clothes3: '胸口（0 平 / 1 满，中间任意值都成立；纯顶点形变，不透明度完全不变）',
      Clothes4: '鞋子（0 穿着 / 1 光脚，中间值是真渐变，12 个部件透明度线性过渡）',
      Clothes5: '尾巴（0 收 / 1 露，中间值是真渐变，35 个部件透明度线性过渡）',
    }
    // 五个 Clothes 都是 0~1 连续量，中间值有实际视觉意义（鞋子/尾巴是透明度渐变，
    // 体型是顶点形变）。混着塌成 0/1 会让 0.4 档静默变成 1（直接跳到最小号）。
    const LOOK_CONT = { Clothes1: 1, Clothes2: 1, Clothes3: 1, Clothes4: 1, Clothes5: 1 }
    function clampLook(k, v) {
      if (LOOK_CONT[k]) {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
      }
      return v ? 1 : 0
    }
    function readLook() {
      const raw = readPetSettings().look
      const out = { ...LOOK_DEFAULT }
      if (raw && typeof raw === 'object') for (const k of LOOK_KEYS) if (typeof raw[k] === 'number') out[k] = clampLook(k, raw[k])
      return out
    }
    function saveLook(patch) {
      const next = { ...readLook() }
      for (const k of LOOK_KEYS) if (patch && k in patch) next[k] = clampLook(k, patch[k])
      // 两副眼镜同时戴必然穿帮，服务端强制互斥：谁被显式打开，另一个就关掉
      if (patch && Number(patch.key11)) next.key12 = 0
      if (patch && Number(patch.key12)) next.key11 = 0
      writePetSettings({ look: next })
      return next
    }
    api.route('/look', async (req, res) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const patch = { ...q, ...body }
      const hasAny = LOOK_KEYS.some((k) => k in patch)
      if (!hasAny) return { ok: true, look: readLook(), labels: LOOK_LABEL, message: '当前外观' }
      const next = saveLook(patch)
      api.log.info('Live2D 外观 → ' + JSON.stringify(next))
      return { ok: true, look: next, labels: LOOK_LABEL, message: '外观已改（桌宠两秒内跟上）' }
    })
    // 前景遮挡：半身模式贴窗口底缘的一件完整道具，把「画面切在腰上」变成
    // 「她站在花箱/餐桌后面」。值对应桌宠 app/renderer/fore/<值>.png。
    // 只在上半身视图显示，全身视图自动隐藏（那里要看清整个人，挡住腿是负作用）。
    const FORE_KINDS = { none: '无', planter: '花箱', snack: '点心', dinner: '家宴' }
    function readFore() {
      const v = readPetSettings().fore
      return Object.prototype.hasOwnProperty.call(FORE_KINDS, v) ? v : 'none'
    }
    api.route('/fore', async (req, res) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const v = String((body.fore != null ? body.fore : q.fore) ?? '')
      if (!Object.prototype.hasOwnProperty.call(FORE_KINDS, v)) {
        return { ok: false, fore: readFore(), labels: FORE_KINDS, message: '前景只能是：' + Object.keys(FORE_KINDS).join(' / ') }
      }
      writePetSettings({ fore: v })
      api.log.info('Live2D 前景 → ' + v)
      return { ok: true, fore: v, labels: FORE_KINDS, message: '前景已改（桌宠两秒内跟上）' }
    })
    // ---------- 耳朵设置（键位/开关） ----------
    // 值存 pet.json 的 ear 段，桌宠主进程 2 秒轮询一次 → 改完不用重启。
    // 键码用 uiohook 的 keycode（不是 Windows VK）。旧鱼搭子存的是 VK 112/113（= F1/F2），
    // 换算过来就是 59/60 —— 手感保持一模一样。
    const EAR_KEY_LABEL = {
      59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
      65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
      57: '空格', 58: 'CapsLock', 41: '反引号 `',
    }
    function readEarCfg() {
      const e = readPetSettings().ear || {}
      return {
        on: e.on !== false,
        say: Number.isInteger(e.say) && e.say > 0 ? e.say : 59,
        sayShot: Number.isInteger(e.sayShot) && e.sayShot > 0 ? e.sayShot : 60,
        mic: typeof e.mic === 'string' ? e.mic : '',
        minMs: Number(e.minMs) > 0 ? Number(e.minMs) : 300,
      }
    }
    api.route('/ear-config', async (req, res) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const patch = { ...q, ...body }
      if (!['on', 'say', 'sayShot', 'mic', 'minMs'].some((k) => k in patch)) {
        return { ok: true, ear: readEarCfg(), labels: EAR_KEY_LABEL, message: '当前耳朵设置' }
      }
      const next = { ...readEarCfg() }
      if ('on' in patch) next.on = !(patch.on === false || patch.on === 'false' || patch.on === 0 || patch.on === '0')
      for (const k of ['say', 'sayShot']) {
        if (k in patch) {
          const v = Number(patch[k])
          if (!Number.isInteger(v) || v <= 0) return { ok: false, message: '键码要是正整数' }
          next[k] = v
        }
      }
      if ('mic' in patch) next.mic = String(patch.mic || '')
      if ('minMs' in patch) { const v = Number(patch.minMs); if (v >= 100 && v <= 3000) next.minMs = v }
      if (next.say === next.sayShot) return { ok: false, message: '说话键和带图键不能是同一个键' }
      writePetSettings({ ear: next })
      api.log.info('Live2D 耳朵 → ' + JSON.stringify({ on: next.on, say: EAR_KEY_LABEL[next.say] || next.say, sayShot: EAR_KEY_LABEL[next.sayShot] || next.sayShot }))
      return { ok: true, ear: next, labels: EAR_KEY_LABEL, message: '已保存（桌宠立刻跟上）' }
    })
    // ---------- 三件套的落点：耳朵 / 电话 / 陪看共用这一个开关 ----------
    // 为什么合成一个：三个功能问的都是同一件事 ——「这段话算进哪条关系」。
    // 以前各有一个 to，四条会话、四个开关，加了陪看以后彻底乱套（先生 2026-11-06 晚的原话）。
    // 现在只有两个答案：QQ 主人私聊 / 后台那一条会话（TALK_CHAT）。
    function readTalkCfg() {
      const t = readPetSettings().talk
      if (t && (t.to === 'qq' || t.to === 'system')) return { to: t.to }
      // 没有新键时沿用耳朵的旧设置：升级不该把「进 QQ」悄悄改回后台（那是先生明确选过的默认）
      const e = readPetSettings().ear || {}
      return { to: e.to === 'system' ? 'system' : 'qq' }
    }
    api.route('/talk-config', async (req) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const patch = { ...q, ...body }
      if (!('to' in patch)) return { ok: true, talk: readTalkCfg(), message: '当前落点' }
      const v = String(patch.to ?? '')
      if (v !== 'qq' && v !== 'system') return { ok: false, message: '只能是 qq（主人私聊）或 system（后台会话）' }
      writePetSettings({ talk: { to: v } })
      // 换落点时把没跑完的排期清空：半路改主意的话，上一轮还带着旧落点，
      // 回复就会从两条路各说一遍。宁可这一轮不吭声。
      G.turnQ = []
      api.log.info('Live2D 三件套落点 → ' + v)
      return {
        ok: true, talk: { to: v },
        message: v === 'qq' ? '都落进 QQ 主人私聊（她的回复也发 QQ，桌宠同时出声）' : '都落后台那一条会话（不进 QQ，只回桌宠）',
      }
    })
    // ---------- 电话设置（只有开关；落点在上面那个总开关） ----------
    // 值存 pet.json 的 call 段，桌宠主进程 2 秒轮询：改完不用重启，拨号/挂断即时生效。
    function readCallCfg() {
      const c = readPetSettings().call || {}
      return { on: c.on === true } // 默认关：这是常驻占麦克风的功能，只有明确打开才开
    }
    api.route('/call-config', async (req) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const patch = { ...q, ...body }
      if (!('on' in patch)) {
        return { ok: true, call: readCallCfg(), message: '当前电话设置' }
      }
      const next = { ...readCallCfg() }
      next.on = !(patch.on === false || patch.on === 'false' || patch.on === 0 || patch.on === '0')
      if (next.on !== readCallCfg().on) resetCallQueue()
      writePetSettings({ call: next })
      api.log.info('Live2D 电话 → ' + JSON.stringify(next))
      return { ok: true, call: next, message: next.on ? '已拨号（桌宠一秒内开始听）' : '已挂断' }
    })

    // ---------- 唤醒词（第 5 期）----------
    // 桌宠那边一直开着麦，只在听到唤醒词之后才录一句。和电话的区别：
    //   电话 = 一直听、一直答（连续对话）；唤醒 = 一直听、叫醒才答一次。
    // 默认**开**（先生 2026-11-07 定的）：这是「随口就能叫」的前提，
    // 默认关的话每次都得先点面板，那就失去意义了。不想要时在面板一键关掉。
    function readWakeCfg() {
      const w = readPetSettings().wake || {}
      const mode = ['voice', 'chime', 'off'].includes(w.ackMode) ? w.ackMode : (w.ack === false ? 'off' : 'voice')
      return {
        on: w.on !== false,
        ack: mode !== 'off',
        ackMode: mode,
        word: typeof w.word === 'string' && w.word.trim() ? w.word.trim() : '小鱼小鱼',
      }
    }
    api.route('/wake-config', async (req) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const patch = { ...q, ...body }
      if (!['on', 'ack', 'ackMode', 'word'].some((k) => k in patch)) {
        return { ok: true, wake: readWakeCfg(), message: '当前唤醒设置' }
      }
      const next = { ...readWakeCfg() }
      if ('on' in patch) next.on = !(patch.on === false || patch.on === 'false' || patch.on === 0 || patch.on === '0')
      if ('ackMode' in patch) {
        const m = String(patch.ackMode || '')
        if (!['voice', 'chime', 'off'].includes(m)) return { ok: false, message: '应答方式只能是 voice / chime / off' }
        next.ackMode = m
        next.ack = m !== 'off'
      }
      if ('ack' in patch) {
        next.ack = !(patch.ack === false || patch.ack === 'false' || patch.ack === 0 || patch.ack === '0')
        if (!next.ack) next.ackMode = 'off'
        else if (next.ackMode === 'off') next.ackMode = 'voice'
      }
      if ('word' in patch) {
        const v = String(patch.word || '').trim()
        // 太短容易误唤醒，太长（>6 字）识别率掉得厉害；2~6 字是这套模型的甜点区
        if (v.length < 2 || v.length > 6) return { ok: false, message: '唤醒词要 2–6 个字' }
        next.word = v
      }
      writePetSettings({ wake: next })
      api.log.info('Live2D 唤醒词 → ' + JSON.stringify(next))
      return { ok: true, wake: next, message: next.on ? `已开：叫她「${next.word}」试试` : '已关（不再监听唤醒词）' }
    })

    // ---------- 陪看（第 4 期）----------
    // 桌宠那边只交「过去这段时间真正变了的几帧」拼成的一张图；这里做两件事：
    //   1) 交给她看一眼；
    //   2) 上一张还没答完就**不再给新的** —— 否则她会在看第 3 张时还在答第 1 张。
    // 省 token 的重头戏在桌宠那边（变化筛选 + 一图多帧 + 静止不出图），不是这里。
    // 主动搭话的区间硬限在 20–180 秒：
    //   低于 20 秒就成了碎嘴（她每句话之间也要几秒才能说完），高于 180 秒就失去「陪」的意思。
    // 面板上的输入框也按这个钳，但真正兜底的是这里 —— 手改 pet.json 写 5 秒照样被抬到 20。
    function clampSec(v, d) {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return d
      return Math.max(20, Math.min(180, Math.round(n)))
    }
    function readWatchCfg() {
      const w = readPetSettings().watch || {}
      const pace = ['calm', 'normal', 'dense'].includes(w.pace) ? w.pace : 'normal'
      const lo = clampSec(w.chatMin, 45)
      const hi = clampSec(w.chatMax, 120)
      // 两套驱动方式，**二选一**（2026-11-06 21:30 先生定）：
      //   auto   = 看画面变化：变了才攒帧，按慢/中/快节奏交付（原来的行为）
      //   active = 不看画面：纯按「随机间隔」自己找他说话（鱼搭子那套）
      // 以前这是两个**叠加**的开关（变化检测 + 主动搭话各开各的），两路各说各的，
      // 实测频率高得吵 —— 他 21:28 的原话「说话的频率有点高」。现在合成一个 mode，
      // 任何时刻只有一路在驱动，绝不会两路一起开口。
      // 兼容老配置：没有 mode 字段时，proactive=true 就当 active。
      const mode = w.mode === 'active' ? 'active'
        : w.mode === 'auto' ? 'auto'
          : (w.proactive === true ? 'active' : 'auto')
      return {
        sessionVersion:String(w.sessionVersion||'legacy'),displayId:String(w.displayId||''),
        on: w.on === true,
        mode,
        pace,
        listen: w.listen !== false,
        // 旧字段，桌宠/面板还没跟上时读它 —— 永远等于「是不是主动模式」
        proactive: mode === 'active',
        chatMin: Math.min(lo, hi),
        chatMax: Math.max(lo, hi),
      }
    }
    api.route('/watch', async (req) => {
      let b = {}
      try { b = (await api.core.http.body(req)) || {} } catch {}
      const cfg = readWatchCfg()
      if(G.watchObserved!==cfg.sessionVersion){invalidateWatch();G.watchObserved=cfg.sessionVersion}
      if (!cfg.on) return { ok: false, message: '陪看没开（面板 / 右键菜单里开）' }
      if(b.sessionVersion!==cfg.sessionVersion)return {ok:false,cancelled:true,message:'旧陪看会话已关闭'}
      const b64 = String(b.sheet || '')
      const textOnly = Boolean(b.textOnly) || !b64
      // 电话开着的时候不自作主张叫醒她：桌宠只把「最新一张」存进来，等主人说完一句、
      // 她正要回答时再一起带过去（见 callTurn 里的 takeWatchHold）。
      // 两条链路各自叫醒，回复会抢着往桌宠投 —— 表现就是连说两句或者说着被打断。
      if (b.hold || mhubCallActive()) {
        G.watchHold = b64
          ? {
            b64,
            mediaType: String(b.mediaType || 'image/jpeg'),
            tiles: Array.isArray(b.tiles) ? b.tiles : [],
            spanSec: Number(b.spanSec) || 0,
            at: Date.now(),capturedAt:Math.min(Date.now(),Number(b.capturedAt)||Date.now()),sessionVersion:cfg.sessionVersion,source:String(b.displayId||''),
          }
          : null
        return { ok: true, held: true }
      }
      if (G.watchBusy && Date.now() - (G.watchAt || 0) < 150000) {
        return { ok: false, busy: true, message: '上一张还在想' }
      }
      const hub = api.core && api.core.hub
      if (!hub || typeof hub.pushToSession !== 'function') {
        return { ok: false, message: '拿不到对话中枢' }
      }
      // 上下文封顶以前靠「攒满 20 张换一段新会话」——合并成一条会话之后，那招作废了
      // （换会话就等于又长出好几条对话，正是先生嫌乱的东西）。
      // 现在只做记账：攒到 20 张在日志里提一句，要不要清理这条会话由主人自己决定。
      if ((G.watchCount || 0) && (G.watchCount % 20) === 0) {
        api.log.info(`陪看：这条会话已经攒了 ${G.watchCount} 张图，再往下历史会越来越长（要清爽就去会话列表里另起一条）`)
      }
      const tiles = Array.isArray(b.tiles) ? b.tiles : []
      const span = Math.max(1, Math.round(Number(b.spanSec) || 0))
      // 台词：只带「上一张图之后新攒的」，取走即清 —— 不然同一句会被反复塞进每一张图里。
      const nowMs = Date.now()
      const since = G.watchLineMark || 0
      const lines = (G.watchLines || [])
        .filter((x) => x && x.text && x.at > since && nowMs - x.at <= 180000)
        .map((x) => ({ ago: Math.round((nowMs - x.at) / 1000), text: String(x.text).slice(0, 60) }))
      G.watchLineMark = nowMs
      const list = tiles.map((t, i) => `${i + 1}·${Math.max(0, Math.round(Number(t.ago) || 0))}s前`).join('，')
      const lineText = lines.length
        ? lines.map((x) => `约${x.ago}s前「${x.text}」`).join('；')
        : ''
      let prompt
      // 主动模式（0.15.0）：到点现抓一张「现在的屏幕」，不是变化拼图。
      // 两套模式的图看起来一样，话术必须分开 —— 否则她会把一张静止的现抓图当「这几秒里变了的瞬间」去解说。
      const activeMode = Boolean(b.active)
      if (activeMode && !textOnly) {
        prompt = `（我在陪你看屏幕，这次是**我自己想跟你说句话**，不是画面刚变过。`
          + `这张图是你现在的屏幕（${list}）。`
          + (lineText ? `这阵子环境里在说的话（机器转写，有错字，别当原文引用）：${lineText}。` : '')
          + '就像坐在旁边的人抬头瞄一眼、随口搭一句：一两句话、口语，别解说画面、别念画面上的字、别用 Markdown、'
          + '别提「截图/图片/我看到了」，也别反问我在干什么。'
          + '没什么想说的就只回一个「看」字，我不会念出来。要配动作就照常写〔动作〕。）'
      } else if (textOnly) {
        // 抓不到画面时的兜底：这次不是「她看到什么」，是「她自己想说话」。
        // 必须把「没新画面」讲透，否则她会顺着上一张图把画面编出来 —— 主人根本没在看那些东西。
        prompt = '（我自己想跟你说句话。这段时间没给你画面 —— '
          + '别猜画面、别提截图、别问我「在干嘛」。'
          + (lineText ? '这阵子环境里在说的话（机器转写，有错字，别当原文引用）：' + lineText + '。' : '')
          + '随口一句就行：一两句话、口语，别用 Markdown。'
          + '没什么想说的就只回一个「看」字，我不会念出来。要配动作就照常写〔动作〕。）'
      } else {
        prompt = `（我在陪你看屏幕。这张图是过去 ${span} 秒里画面真正变了的 ${tiles.length || 1} 个瞬间，`
          + `按左上→右下排时间（${list}），每格角上的 -12s 是相对现在往前多少秒。`
        if (lineText) prompt += `这期间环境里在说的话（机器转写，有错字）：${lineText}。`
        prompt += '你就像坐在我旁边一起看的人那样，瞄一眼，想说什么就说一句：'
          + '一两句话、口语，别解说画面、别念画面上的字、别用 Markdown、'
          + '别提「截图/图片/我看到了」这类话，也别反问我在干什么。'
          + '没什么可说的就只回一个「看」字，我不会念出来。要配动作就照常写〔动作〕。）'
      }
      const requestId=randomUUID(),watchVersion=cfg.sessionVersion
      const probe='【live2d-watch:'+requestId+'】'
      G.watchRequestId=requestId
      G.watchStatus={...G.watchStatus,modelError:null,lastReplySilent:false}
      G.watchBusy = true
      G.watchAt = Date.now()
      G.watchCount = (G.watchCount || 0) + 1
      // 和耳朵 / 电话走同一条投递路径：落哪儿由那个总开关定（QQ 私聊 / 后台会话），
      // 回复怎么回来也由它决定 —— 这里不再自己攒 content、自己判 vision。
      const selfTalk = activeMode || textOnly
      const sent = await talkTurn('watch', {
        requestId,watchVersion,stale:()=>!readWatchCfg().on||watchVersion!==readWatchCfg().sessionVersion,
        heard:probe+(selfTalk?'（陪看·我想说句话）':'（陪看画面）'),
        prompt:probe+prompt,probe,
        image: textOnly ? null : { base64: b64, mediaType: String(b.mediaType || 'image/jpeg') },
      })
      if (!sent.to) {
        if(G.watchRequestId===requestId){G.watchBusy=false;G.watchAt=0}
        return {ok:false,requestId,...sent,message:sent.message||'画面提交失败'}
      }
      api.log.info(activeMode
        ? `陪看：主动模式第 ${G.watchCount} 轮（${textOnly ? '没抓到画面，纯文字' : '现抓一张'}${lineText ? '，带台词' : ''}，进${sent.to === 'qq' ? ' QQ' : '后台'}）`
        : `陪看：第 ${G.watchCount} 张已交（${tiles.length} 帧 / ${span}s，进${sent.to === 'qq' ? ' QQ' : '后台'}）`)
      return { ok: true, requestId,textOnly, to: sent.to, withImage: sent.withImage,stage:'submitted' }
    })

    // 台词：系统回环里切出的一段 → 转成文字，先攒着，等下一张图交付时一起给她。
    // 不单独为一句台词开一轮思考，是有意的：又贵又碎，配上画面才有意义。
    api.route('/watch-line', async (req) => {
      let b = {}
      try { b = (await api.core.http.body(req)) || {} } catch {}
      const version=readWatchCfg().sessionVersion
      if(b.sessionVersion!==version)return {ok:false,cancelled:true}
      if (!readWatchCfg().on) return { ok: false, message: '陪看没开' }
      const b64 = String(b.wav || '')
      if (!b64) return { ok: false, message: '没收到音频' }
      const stt = api.dsh.get('speechToText')
      if (!stt || typeof stt.resolve !== 'function') return { ok: false, message: '内部本地语音识别未就绪。' }
      const t0 = Date.now()
      let heard = ''
      try {
        const spec = stt.resolve({ audio: new Uint8Array(Buffer.from(b64, 'base64')) })
        const r = await stt.transcribe(spec, AbortSignal.timeout(30000))
        heard = String(typeof r === 'string' ? r : (r && (r.text || r.transcript)) || '').trim()
      } catch (e) {
        api.log.warn('陪看·台词：识别失败', String((e && e.message) || e))
        return { ok: false, message: '识别失败' }
      }
      if(!readWatchCfg().on||version!==readWatchCfg().sessionVersion)return {ok:false,cancelled:true}
      const sttMs = Date.now() - t0
      if (!heard || heard.length < 2 || EAR_NOISE.test(heard)) {
        return { ok: false, message: '没听清', heard, sttMs }
      }
      const arr = G.watchLines || (G.watchLines = [])
      arr.push({ at: Date.now(), text: heard })
      while (arr.length > 10) arr.shift()
      return { ok: true, heard, sttMs, buf: arr.length }
    })

    api.route('/watch-config', async (req) => {
      const q = api.core.http.query(req)
      let body = {}
      try { body = (await api.core.http.body(req)) || {} } catch {}
      const patch = { ...q, ...body }
      if (!['on', 'mode', 'pace', 'listen', 'proactive', 'chatMin', 'chatMax','displayId'].some((k) => k in patch)) {
        return { ok: true, watch: readWatchCfg(), message: '当前陪看设置' }
      }
      const next = { ...readWatchCfg() }
      const truthy = (v) => !(v === false || v === 'false' || v === 0 || v === '0')
      if ('on' in patch) next.on = truthy(patch.on)
      if ('listen' in patch) next.listen = truthy(patch.listen)
      if ('mode' in patch) {
        const v = String(patch.mode || '')
        if (v !== 'auto' && v !== 'active') return { ok: false, message: 'mode 只能是 auto（看变化）或 active（按时间）' }
        next.mode = v
      }
      // 老入口：proactive=true 等于切到主动模式，false 等于切回自动模式
      if ('proactive' in patch) next.mode = truthy(patch.proactive) ? 'active' : 'auto'
      if ('chatMin' in patch || 'chatMax' in patch) {
        // 两个数一起按 20–180 钳，再补齐先后顺序 —— 横着填（最短 120 / 最长 40）不该被拒绝，
        // 直接换过来更符合直觉。夹逼之后不合法就保持原样。
        const lo = 'chatMin' in patch ? clampSec(patch.chatMin, next.chatMin) : next.chatMin
        const hi = 'chatMax' in patch ? clampSec(patch.chatMax, next.chatMax) : next.chatMax
        next.chatMin = Math.min(lo, hi)
        next.chatMax = Math.max(lo, hi)
      }
      if ('pace' in patch) {
        const v = String(patch.pace || '')
        if (!['calm', 'normal', 'dense'].includes(v)) return { ok: false, message: 'pace 只能是 calm / normal / dense' }
        next.pace = v
      }
      if('displayId' in patch){if(String(patch.displayId)!==''&&!/^-?\d{1,20}$/.test(String(patch.displayId)))return {ok:false,message:'显示器标识无效'};next.displayId=String(patch.displayId)}
      next.proactive = next.mode === 'active' // 写回时保持旧字段一致，老桌宠也认
      writePetSettings({ watch: next })
      api.log.info('Live2D 陪看 → ' + JSON.stringify(next))
      const msg = !next.on
        ? '停下了'
        : (next.mode === 'active'
          ? `主动模式：每 ${next.chatMin}–${next.chatMax} 秒之间随机找你说一句（不看画面变化）`
          : `自动模式：画面有变化才说，节奏 ${next.pace}`)
      return { ok: true, watch: next, message: msg }
    })

    // 后台那条会话在**侧栏里到底叫什么**。pushToSession 的 title 只在会话第一次建出来时有效，
    // 之后再传没用 —— 所以它现在叫「QQ · 听到主人说话」（11-06 建会话时按当时内容自动取的），
    // 和面板文案对不上，先生 21:15 就在列表里找不到「后台一条对话」（他没有找错，是名字不像）。
    // 面板直接读真名显示，他改了名面板也跟着变；读不到才退回 TALK_TITLE。
    function talkChatTitle() {
      try {
        const hub = api.core && api.core.hub
        const all = hub && typeof hub.sessions === 'function' ? hub.sessions() : null
        const rec = all && all[TALK_CHAT]
        return String((rec && rec.title) || TALK_TITLE)
      } catch { return TALK_TITLE }
    }
    // M HUB uses the same recognizer and the same local Live2D conversation.
    // This path returns the text to its caller, so the pet does not play it twice.
    function mhubAuthorized(req) {
      try {
        const host = JSON.parse(readFileSync(api.runtime.hostFile, 'utf8'))
        const expected = Buffer.from(host.token)
        const actual = Buffer.from(String(req.headers?.['x-pet-token'] || ''))
        return (!req.headers?.origin && expected.length >= 32 && expected.length === actual.length
          && timingSafeEqual(expected, actual))
      } catch { return false }
    }
    function mhubRoute(name, run) {
      api.route('/mhub-' + name, async (req) => {
        if (!mhubAuthorized(req)) return { ok: false, message: 'Live2D 连接未授权。' }
        try { return await run(req) }
        catch (e) { return { ok: false, message: String(e?.message || e).slice(0, 240),...(['submission','model','reply-validation','superseded','cancelled','timeout','reply'].includes(e?.stage)?{stage:e.stage}:{}) } }
      })
    }
    const mhubCallActive = () => G.mhubCall && G.mhubCall.until > Date.now()
    function stopOwnedWatch(id) {
      if (!id || readPetSettings().mhubWatchOwner !== id) return
      writePetSettings({ watch: { ...readWatchCfg(), on: false }, mhubWatchOwner: null })
      G.watchHold = null
      G.watchLines = []
      G.watchLineMark = 0
    }
    function stopOwnedCall(id) {
      const settings = readPetSettings()
      if (!id || settings.call?.mhubOwner !== id) return
      writePetSettings({ call: { ...settings.call, on: false, muted: false, mhubOwner: null, mhubSilenceMs: null } })
      resetCallQueue()
    }
    function expireMhubCall() {
      const settings = readPetSettings()
      stopOwnedCall(settings.call?.mhubOwner)
      stopOwnedWatch(settings.mhubWatchOwner)
      G.mhubCall = null
    }
    if (api.runtime.activated() && !mhubCallActive()) expireMhubCall()
    api.every(2000, () => {
      if (!mhubCallActive()) expireMhubCall()
    }, '迈从视频陪玩断线回收')
    function nativeCallState() {
      const c = G.mhubCall
      if (!c?.native || !mhubCallActive()) return null
      return { id: c.id, phase: readCallCfg().on ? c.phase : 'ended', error: c.error || '',
        muted: !!c.muted, input: c.input || '', reply: c.reply || '', replyKey: c.replyKey || '',
        audioMs: c.audioMs || 0, speechError: c.speechError || '' }
    }
    function selectedSpeechProvider(stt) {
      const snapshot = stt?.snapshot?.()
      return snapshot?.providers?.find(p => p.id === snapshot.selection?.providerId)
    }
    mhubRoute('state', () => {
      const provider = selectedSpeechProvider(api.dsh.get('speechToText'))
      const phase = provider?.preparation?.phase || 'unavailable'
      return { ok: true, asr: !!provider && phase === 'ready',
        online: !!api.use('pet')?.online?.()?.online && !!petRunning(),
        speechReplyHealth:G.speechReplyHealth??null,watchStatus:watchStatus(),call: readCallCfg().on, watch: readWatchCfg().on, provider: provider?.id || '', asrPhase: phase,
        asrError: phase === 'failed' ? String(provider.preparation.message || '语音识别器准备失败。').slice(0, 240) : null,
        nativeCall: nativeCallState() }
    })
    mhubRoute('asr-prepare', () => {
      const stt = api.dsh.get('speechToText')
      const provider = selectedSpeechProvider(stt)
      if (provider?.id !== 'sensevoice-local' || typeof stt?.prepare !== 'function')
        throw Error('内部本地 SenseVoice 识别尚未配置。')
      const phase = provider.preparation?.phase
      if (phase === 'unprepared' || phase === 'failed' || phase === 'stopped') stt.prepare(provider.id)
      return { ok: true }
    })
    mhubRoute('native-call', async req => {
      const { id, action, video, muted, phase, error, silenceMs, text, audioMs } = await api.core.http.body(req)
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error('通话参数无效。')
      if (action === 'stop') {
        if (G.mhubCall?.id === id) { stopOwnedCall(id); stopOwnedWatch(id); G.mhubCall = null }
        return { ok: true }
      }
      if (action === 'start') {
        if (!mhubCallActive()) expireMhubCall()
        if (readCallCfg().on || mhubCallActive()) throw Error('Live2D 已有一通电话，请先挂断。')
        if (!petRunning() || !api.use('pet')?.online?.()?.online) throw Error('Live2D 桌宠尚未上线。')
        resetCallQueue()
        const settings = readPetSettings()
        const startWatch = video === true && !readWatchCfg().on
        G.mhubCall = { id, native: true, phase: 'connecting', until: Date.now() + 10000 }
        try {
          const quiet = Number.isInteger(silenceMs) && silenceMs >= 400 && silenceMs <= 5000 ? silenceMs : null
          writePetSettings({ call: { ...settings.call, on: true, muted: false, mhubOwner: id, mhubSilenceMs: quiet },
            ...(startWatch ? { watch: { ...readWatchCfg(), on: true }, mhubWatchOwner: id } : {}) })
        } catch (e) { G.mhubCall = null; throw e }
        return { ok: true, nativeCall: nativeCallState() }
      }
      const c = G.mhubCall
      if (!c?.native || c.id !== id || !mhubCallActive()) return { ok: true, nativeCall: null }
      if (action === 'renew') c.until = Date.now() + 10000
      else if (action === 'mute' && typeof muted === 'boolean' && readCallCfg().on) {
        writePetSettings({ call: { ...readPetSettings().call, muted } })
        c.muted = muted
      } else if (action === 'report' && ['connected','ended','failed'].includes(phase)) {
        c.phase = phase
        c.error = typeof error === 'string' ? error.slice(0, 180) : ''
      } else if (action === 'speech' && c.phase === 'connected' && c.speech && c.speech.text === text) {
        c.reply = c.speech.text
        c.replyKey = c.speech.id
        c.audioMs = Number.isFinite(audioMs) ? Math.max(0, Math.min(180000, audioMs)) : 0
        c.speechError = c.audioMs > 0 ? '' : 'BreezeBlue 语音生成失败，已在桌宠显示文字。'
        c.speech = null
      } else throw Error('通话操作无效。')
      return { ok: true, nativeCall: nativeCallState() }
    })
    mhubRoute('call', async req => {
      const { id, on } = await api.core.http.body(req)
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || typeof on !== 'boolean') throw Error('通话参数无效。')
      if (!on) {
        if (G.mhubCall?.id === id) { G.mhubCall = null; G.watchHold = null; stopOwnedWatch(id) }
      } else {
        if (readCallCfg().on) throw Error('请先挂断桌宠上的电话，再用迈从电话。')
        if (mhubCallActive() && G.mhubCall.id !== id) throw Error('已有一通迈从电话。')
        G.mhubCall = { id, until: Date.now() + 10000 }
      }
      return { ok: true }
    })
    mhubRoute('watch-speech',async req=>{
      const b=await api.core.http.body(req),entry=watchRequests.get(String(b.requestId||''))
      if(!entry||watchStale(entry))return {ok:true,valid:false}
      return {ok:true,valid:true,sessionVersion:entry.watchVersion,requestId:entry.requestId}
    })
    mhubRoute('watch-status',async req=>{
      const b=await api.core.http.body(req),cfg=readWatchCfg()
      if(G.watchObserved!==cfg.sessionVersion){invalidateWatch();G.watchObserved=cfg.sessionVersion}
      if(b.sessionVersion!==cfg.sessionVersion)return {ok:true,ignored:true}
      const safeError=e=>e?{stage:String(e.stage||'').slice(0,50),name:String(e.name||'').slice(0,60),message:String(e.message||'').replace(/(?:https?:\/\/|Bearer |sk-)[^\s]+/gi,'[redacted]').slice(0,240)}:null
      const c=b.capture,u=b.upload,old=G.watchStatus||{}
      let p=b.speech
      if(p && (!watchRequests.has(p.requestId) || watchStale(watchRequests.get(p.requestId))))p=null
      if(p && ['end','cancel'].includes(p.event) && old.speech?.speechId!==p.speechId)p=null
      const capture=c&&['preparing','running','retrying','failed','stopped'].includes(c.phase)?{
        phase:c.phase,backend:c.backend==='snapshot'?'snapshot':'video',lastFrameAt:Math.min(Date.now(),Number(c.lastFrameAt)||0),width:Math.max(0,Number(c.width)||0),height:Math.max(0,Number(c.height)||0),retryCount:Number(c.retryCount)||0,error:safeError(c.error)}:old.capture
      const upload=u?{at:Number(u.at)||0,ok:u.ok===true,requestId:String(u.requestId||'').slice(0,50),withImage:u.withImage===true,held:u.held===true,visionUnsupported:u.visionUnsupported===true,...safeError(u)}:old.upload
      G.watchStatus={...old,sessionVersion:cfg.sessionVersion,at:Date.now(),capture,upload,
        ...(p?{speech:{at:Date.now(),requestId:String(p.requestId||'').slice(0,50),stage:String(p.stage||'').slice(0,40),event:String(p.event||'').slice(0,20),speechId:String(p.speechId||'').slice(0,50),ok:p.ok===true,message:safeError(p)?.message||''}}:{})}
      return {ok:true}
    })
    mhubRoute('watch', async req => {
      const { on, owner } = await api.core.http.body(req)
      if (typeof on !== 'boolean') throw Error('陪看开关无效。')
      if (owner !== undefined && (typeof owner !== 'string' || !/^[a-f0-9-]{36}$/.test(owner))) throw Error('陪玩通话参数无效。')
      if (owner && !on) { stopOwnedWatch(owner); return { ok: true, watch: readWatchCfg().on } }
      if (owner && (!mhubCallActive() || G.mhubCall.id !== owner)) throw Error('视频通话已经结束。')
      if (on && (!petRunning() || !api.use('pet')?.online?.()?.online)) throw Error('请先启动 Live2D 桌宠。')
      const saved = readWatchCfg()
      if (owner && saved.on) return { ok: true, watch: true }
      writePetSettings({ watch: { ...saved, on }, mhubWatchOwner: owner || null })
      if (!on) { G.watchHold = null; G.watchLines = []; G.watchLineMark = 0 }
      return { ok: true, watch: on }
    })
    mhubRoute('asr', async req => {
      const { wav } = await api.core.http.body(req)
      if (typeof wav !== 'string' || wav.length > 2700000 || !wav) throw Error('语音文件无效或太长。')
      const stt = api.dsh.get('speechToText')
      if (!stt || typeof stt.resolve !== 'function') throw Error('内部本地语音识别未就绪。')
      const spec = stt.resolve({ audio: new Uint8Array(Buffer.from(wav, 'base64')) })
      const r = await stt.transcribe(spec, AbortSignal.timeout(60000))
      const heard = String(typeof r === 'string' ? r : r?.text || r?.transcript || '').trim()
      if (heard.length < 2 || EAR_NOISE.test(heard)) throw Error('没有听清，请再说一次。')
      return { ok: true, heard }
    })
    mhubRoute('conversation-repair',async req=>{
      const {expectedSessionId}=await api.core.http.body(req)
      if(readCallCfg().on||readWatchCfg().on||mhubCallActive()||G.mhubTurn||talkQueue().length)throw Error('请先结束语音、电话和陪看，再修复会话。')
      const hub=api.core.hub,entry=hub.sessions()?.[TALK_CHAT]
      if(!entry||entry.sessionId!==expectedSessionId)throw Error('后台语音会话已变化，请重新核对。')
      if(!hub.resetChat(TALK_CHAT))throw Error('后台语音会话未能重新开始。')
      G.speechReplyHealth={at:Date.now(),ok:true,repairedSessionId:expectedSessionId,message:'旧语音会话已保留归档，下句使用新会话；长期记忆和 QQ 会话未改动。'}
      return {ok:true,archivedSessionId:expectedSessionId}
    })
    mhubRoute('turn', async req => {
      const { text, kind } = await api.core.http.body(req)
      const heard = typeof text === 'string' ? text.trim() : ''
      if (!heard || heard.length > 2000 || !['voice','call'].includes(kind)) throw Error('语音对话参数无效。')
      if (readCallCfg().on) throw Error('请先挂断桌宠上的电话。')
      if (G.mhubTurn) throw Error('上一句还在处理，请稍等。')
      const probe = '【迈从语音回合 ' + randomUUID() + '】'
      const frame = kind === 'call' && readWatchCfg().on ? takeWatchHold() : null
      const lines = frame ? takeRecentLines() : ''
      const prompt = probe + '（请用一两句自然口语回答，正常使用中文逗号、句号和问号，不要用空格或换行代替标点。短回复连成一段，不列清单，不写动作标签。'
        + (frame ? '我附了陪看的最新画面，问题涉及画面时请看图。' : readWatchCfg().on?'当前没有新鲜画面，涉及屏幕的问题请说明尚未取得当前画面，不要沿用旧图。':'')
        + (lines ? '视频里的声音刚才说了：' + lines : '') + '）\n' + heard
      let finish, failure, withImage = false
      const result = new Promise(resolve => { finish = resolve })
      G.mhubTurn = finish
      const deliver = (reply, error) => { if(error)failure=error; finish(reply) }
      const close = error => deliver(null,error)
      const aborted = () => close({stage:'cancelled',message:'这次语音对话已取消。'})
      const timer = setTimeout(() => close({stage:'timeout',message:'等待大肥鱼回复超时，请检查 AI 服务后重试。'}), 50000)
      req.once?.('aborted', aborted)
      try {
        void talkTurn(kind === 'call' ? 'call' : 'ear', {
          heard, prompt, probe, deliver,
          image: frame ? { base64: frame.b64, mediaType: frame.mediaType } : null,
        }).then(sent => { withImage = sent.withImage; if (!sent.to) close({stage:sent.stage || 'submission',message:sent.message || '语音对话未能投递，请检查 AI 服务。'}) }, error => close({stage:'submission',message:String(error?.message || error).slice(0,240)}))
        const reply = await result
        if (!reply) throw Object.assign(Error(failure?.message || '大肥鱼没有返回语音回复，请再试一次。'),{stage:failure?.stage || 'reply'})
        return { ok: true, reply, withImage }
      } finally {
        clearTimeout(timer)
        req.off?.('aborted', aborted)
        if (G.mhubTurn === finish) G.mhubTurn = null
        const q = talkQueue(), i = q.findIndex(entry => entry.deliver === deliver)
        if (i >= 0) q.splice(i, 1)
      }
    })

    api.route('/state', async () => {
      const pid = petRunning()
      const pet = api.use('pet')
      return {
        running: !!pid, pid, scale: readScale(), look: readLook(), lookLabels: LOOK_LABEL,
        fore: readFore(), foreLabels: FORE_KINDS,
        ear: readEarCfg(), earLabels: EAR_KEY_LABEL,
        talk: readTalkCfg(), talkTitle: talkChatTitle(),
        call: readCallCfg(),
        watch: readWatchCfg(),watchStatus:watchStatus(),
        wake: readWakeCfg(),
        petOnline: pet && pet.online ? pet.online() : null,
        // 安装体检：面板顶部据此提示「壳/模型/Electron 缺哪一块」，装的时候不用翻日志
        install: (() => {
          let shell = false
          try { accessSync(join(PET_DIR, 'app', 'main.js')); shell = true } catch {}
          const electron = findElectron(api)
          return {
            petDir: PET_DIR,
            shell,
            model: hasModel(),
            electron: !!electron,
            electronPath: electron || '',
          }
        })(),
      }
    })
    api.route('/launch', () => api.runtime.launch())
    api.route('/stop', () => api.runtime.stop())

    api.log.info('Live2D 桌宠联动模块已加载（scope=' + api.settings().scope + '）')
  },
}

}
