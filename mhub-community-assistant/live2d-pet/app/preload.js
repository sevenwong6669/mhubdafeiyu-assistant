// Live2D 桌宠 preload：渲染页 ↔ 主进程桥
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  onExpression: (cb) => ipcRenderer.on('expression', (_e, data) => cb(data)),
  audioConfig: () => ipcRenderer.invoke('audio-config'),
  reportPlayback: (data) => ipcRenderer.send('mhub-playback', data),
  onSpeak: (cb) => ipcRenderer.on('speak', (_e, data) => cb(data)),
  onFocus: (cb) => ipcRenderer.on('focus', (_e, data) => cb(data)),
  onTestMouth: (cb) => ipcRenderer.on('test-mouth', () => cb()),
  onHideBubble: (cb) => ipcRenderer.on('hide-bubble', () => cb()),
  onToggleView: (cb) => ipcRenderer.on('toggle-view', () => cb()),
  onZoom: (cb) => ipcRenderer.on('zoom', (_e, v) => cb(v)),
  onLook: (cb) => ipcRenderer.on('look', (_e, o) => cb(o)),
  // 换衣模式（右键开关）：主进程只负责开关事件，面板本身在渲染页里画
  onDress: (cb) => ipcRenderer.on('dress-mode', (_e, d) => cb(d)),
  setDress: (on) => ipcRenderer.send('dress-state', !!on),
  onFore: (cb) => ipcRenderer.on('fore', (_e, v) => cb(v)),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onThink: (cb) => ipcRenderer.on('think', (_e, d) => cb(d)),
  // 耳朵（按住说话）：主进程说「开始/停止/取消」，渲染页采音；采完回传 PCM。
  onPtt: (cb) => ipcRenderer.on('ptt', (_e, d) => cb(d)),
  onEarState: (cb) => ipcRenderer.on('ear-state', (_e, d) => cb(d)),
  onEarConfig: (cb) => ipcRenderer.on('ear-config', (_e, d) => cb(d)),
  earConfig: () => ipcRenderer.invoke('ear-config'),
  earAudio: (d) => ipcRenderer.invoke('ear-audio', d),
  // 电话（第 3 期）：一直开着麦克风，渲染页自己断句，切好一句回传一次
  onCallCtl: (cb) => ipcRenderer.on('call-ctl', (_e, d) => cb(d)),
  onCallConfig: (cb) => ipcRenderer.on('call-config', (_e, d) => cb(d)),
  callConfig: () => ipcRenderer.invoke('call-config'),
  callAudio: (d) => ipcRenderer.invoke('call-audio', d),
  reportCall: (d) => ipcRenderer.send('call-status', d),
  // 唤醒词（第 5 期）：渲染页一直开着麦，每 128ms 推一帧给主进程做关键词识别；
  // 命中后主进程推 wake-hit，渲染页自己录一句再走 earAudio。
  // 推流走 send 不走 invoke —— 每秒 8 次，不能每次都等回执。
  onWakeHit: (cb) => ipcRenderer.on('wake-hit', (_e, d) => cb(d)),
  onWakeConfig: (cb) => ipcRenderer.on('wake-config', (_e, d) => cb(d)),
  wakeConfig: () => ipcRenderer.invoke('wake-config'),
  wakePcm: (pcm) => ipcRenderer.send('wake-pcm', pcm),
  // 陪看（第 4 期）：渲染页抓屏筛帧、拼成一张图交给主进程上送
  onWatchCtl: (cb) => ipcRenderer.on('watch-ctl', (_e, d) => cb(d)),
  onWatchConfig: (cb) => ipcRenderer.on('watch-config', (_e, d) => cb(d)),
  watchConfig: () => ipcRenderer.invoke('watch-config'),
  watchSheet: (d) => ipcRenderer.invoke('watch-sheet', d),
  watchLine: (d) => ipcRenderer.invoke('watch-line', d),
  watchSnapshot: (d) => ipcRenderer.invoke('watch-snapshot',d),
  watchStatus: (d) => ipcRenderer.send('watch-status', d),
  watchMask: () => ipcRenderer.invoke('watch-mask'),
  moveTo: (x, y) => ipcRenderer.send('move', x, y),
  setHit: (hit) => ipcRenderer.send('set-hit', hit),
  menu: () => ipcRenderer.send('menu'),
  log: (...a) => ipcRenderer.send('log', ...a),
  screenInfo: () => ipcRenderer.invoke('screen-info'),
  pollState: () => ipcRenderer.invoke('poll-state'),
  setLook: (patch) => ipcRenderer.invoke('set-look', patch),
})
