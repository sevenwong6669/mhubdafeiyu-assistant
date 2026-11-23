// 眼睛：截屏（第 2 期）
//
// 归属：只负责「把当前这一屏变成一张能交给模型看的 JPEG」。
// 不参与采音、不参与上送、不碰桌宠本体 —— 出问题只丢一行日志。
//
// 为什么在主进程：desktopCapturer 从 Electron 17 起只在主进程可用，
// 渲染页拿不到。主进程直接 `thumbnail.toJPEG()` 也最省事（不用再走 video 流截图）。
//
// 为什么按「鼠标所在那块屏」抓：先生是双屏/高分屏，getSources 里多块屏时
// 按 display_id 对齐，比盲取第一个可靠（虚拟显示器、副屏顺序都不固定）。

const { desktopCapturer, screen } = require('electron')
const {selectDisplay,selectSource}=require('./display-selection')

// 长边压到 1600：主流视觉模型进图前会缩到 1568 左右，再大只是白花传输时间。
// 1600 下 4K 屏的正文仍然读得清（实测 1px 的细横线会糊，但字不会）。
const MAX_EDGE = 1600
const JPEG_QUALITY = 88

/**
 * 抓当前屏。
 * @returns {Promise<null | {base64:string, mediaType:string, w:number, h:number, source:string}>}
 */
async function captureScreen(displayId) {
  try {
    const display = selectDisplay(screen,displayId)
    // thumbnailSize 要的是物理像素：display.size 是 DIP（125% 缩放时 4K 报 3072×1728）
    const phys = {
      width: Math.round(display.size.width * (display.scaleFactor || 1)),
      height: Math.round(display.size.height * (display.scaleFactor || 1)),
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: phys,
      fetchWindowIcons: false,
    })
    if (!sources || !sources.length) return null
    // 优先匹配光标所在那块屏；匹配不上退回第一块（单屏/虚拟屏常见）
    const hit = selectSource(sources,display)
    let img = hit.thumbnail
    if (!img || img.isEmpty()) return null

    const size = img.getSize()
    const longEdge = Math.max(size.width, size.height)
    if (longEdge > MAX_EDGE) {
      const k = MAX_EDGE / longEdge
      img = img.resize({
        width: Math.max(1, Math.round(size.width * k)),
        height: Math.max(1, Math.round(size.height * k)),
        quality: 'good',
      })
    }
    const out = img.getSize()
    return {
      base64: img.toJPEG(JPEG_QUALITY).toString('base64'),
      mediaType: 'image/jpeg',
      w: out.width,
      h: out.height,
      source: String(hit.name || '屏幕'),
    }
  } catch (e) {
    return { name:e.name, error: String((e && e.message) || e) }
  }
}

module.exports = { captureScreen, MAX_EDGE }
