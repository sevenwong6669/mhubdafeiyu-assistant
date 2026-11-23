// One explicit monitor identity for continuous capture, snapshots and masks.
function selectDisplay(screen, id) {
  const displays=screen.getAllDisplays()
  const target=id ? displays.find(d=>String(d.id)===String(id)) : screen.getPrimaryDisplay()
  if(!target || !displays.some(d=>String(d.id)===String(target.id))){
    const error=Error('目标显示器已断开，请在桌宠菜单重新选择屏幕');error.name='DisplayMissingError';throw error
  }
  return target
}
function selectSource(sources,display){
  const source=sources.find(s=>String(s.display_id)===String(display.id))
  if(!source){const error=Error('目标显示器未提供采集源，请重新选择屏幕');error.name='DisplayMissingError';throw error}
  return source
}
module.exports={selectDisplay,selectSource}
