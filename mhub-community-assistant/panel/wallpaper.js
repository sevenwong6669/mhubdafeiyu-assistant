/* Local wallpaper library; applying is always an explicit user action. */
(() => {
 let selectedFile=null,fileMessage='';
 const E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(s){
  const I=window.DafeiyuI18n,w=s.data.wallpapers;
  if(!w)return `<section class="card"><h2>${I.h('M HUB 壁纸')}</h2><p>${I.h('壁纸服务正在准备，请稍后刷新。')}</p></section>`;
  const busy=s.busy.has('wallpaper')||w.busy,disabled=busy?'disabled':'',locked=busy||!!w.recovery,linkOff=s.data.controls?.deviceLink?.enabled===false,status=w.status??{};
  const phase=({idle:'尚未接管壁纸',unverified:'壁纸记录已载入，请检查驱动状态。',applied:'壁纸已应用',restored:'已恢复原壁纸',released:'壁纸接管已停止','user-changed':'已跟随你在 M HUB 中的更改',checked:'已读取壁纸状态',failed:'壁纸操作未完成',waiting:'等待 M HUB 恢复连接','restore-required':'原壁纸需要恢复',recovering:'正在恢复之前的壁纸…','recovery-pending':'上次壁纸操作被中断，正在恢复。','recovery-failed':'壁纸自动恢复已停止。','recovery-paused':'设备联动已关闭，壁纸恢复已暂停。'})[status.phase]??'尚未接管壁纸';
  const cards=w.assets.map(a=>{const src='wallpaper-media?id='+encodeURIComponent(a.id),active=w.active?.id===a.id;return `<article class="card mhub-wallpaper-card ${active?'is-current':''}"><div class="mhub-wallpaper-preview">${a.kind==='video'?`<video src="${src}" controls muted loop playsinline preload="metadata" aria-label="${E(a.name)}"></video>`:`<img src="${src}" alt="${E(a.name)}" loading="lazy">`}<span class="tag">${I.h(a.kind==='video'?'视频 · 实验':a.kind==='gif'?'GIF 动画':'静态图片')}</span></div><div class="mhub-wallpaper-card-body"><h3>${E(a.preset?I.t(a.name):a.name)}</h3><p class="control-muted">${a.preset?I.h('内置预设 · 3840 × 2160'):I.number(a.size/1024/1024,{maximumFractionDigits:1})+' MB'}${active?' · '+I.h('当前使用'):''}</p><div class="control-buttons"><button class="button ${active?'ghost':'outline'}" data-action="wallpaper-apply" data-wallpaper-id="${E(a.id)}" ${locked||linkOff?'disabled':''}>${I.h(a.kind==='video'?'应用视频（实验）':active?'重新应用':'应用到 M HUB')}</button>${a.preset?'':`<button class="button ghost" data-action="wallpaper-remove" data-wallpaper-id="${E(a.id)}" ${locked||active?'disabled':''}>${I.h('移除素材')}</button>`}</div></div></article>`;}).join('');
  return `<section class="section-header"><div><h2>${I.h('M HUB 壁纸')}</h2><p class="control-muted">${I.h('在这里更换驱动背景，保留原壁纸以便恢复。')}</p></div><button class="button ghost" data-action="control-tab" data-tab="home">${I.h('返回总览')}</button></section>
   <section class="card mhub-wallpaper-toolbar"><div><strong>${I.h(phase)}</strong>${linkOff?`<p role="status">${I.h('设备联动总开关已关闭，请先在总览开启。')}</p>`:''}${status.error?`<p role="status">${E(I.message(status.error))}</p>`:''}${w.recovery?`<p role="status">${I.h('自动恢复尝试：{attempts} / {limit}',{attempts:I.number(w.recovery.attempts),limit:I.number(w.recovery.limit)})}</p>`:''}<p class="control-muted">${I.h('图片和 GIF 保存到 M HUB；视频需要插件运行，并遵循驱动的暂停规则。')}</p></div><div class="control-buttons"><button class="button outline" data-action="wallpaper-inspect" ${disabled}>${I.h('检查驱动')}</button><button class="button outline" data-action="wallpaper-restore" ${busy||linkOff||!w.canRestore?'disabled':''}>${I.h(w.recovery?'重试恢复壁纸':'恢复之前的壁纸')}</button><button class="button ghost" data-action="wallpaper-release" ${busy||!w.active&&!w.recovery?'disabled':''}>${I.h(w.recovery?'停止恢复，保留当前壁纸':'停止接管，保留画面')}</button></div></section>
   <section class="card mhub-wallpaper-upload"><h3>${I.h('添加壁纸素材')}</h3><p class="control-muted">${I.h('建议使用 16:9 横图或视频，1920 × 1080 起。每个文件不超过 32 MB。')}</p><div class="mhub-wallpaper-file-row"><label class="button outline">${I.h('选择图片、GIF 或视频')}<input class="visually-hidden" type="file" data-wallpaper-file accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,.mp4,.webm" ${disabled}></label><span data-wallpaper-filename>${E(selectedFile?.name??I.t('尚未选择文件'))}</span><button class="button" data-action="wallpaper-import" ${busy||!selectedFile?'disabled':''}>${I.h('导入壁纸库')}</button></div><p class="control-muted" data-wallpaper-file-status role="status">${E(I.message(fileMessage))}</p></section>
   <div class="mhub-wallpaper-grid">${cards}</div><p class="control-muted">${I.h('视频支持取决于驱动编解码器。推荐无声 MP4（H.264）或 WebM，短片循环播放。')}</p>`;
 }
 function edit(event){if(!event.target?.matches?.('[data-wallpaper-file]'))return false;selectedFile=event.target.files?.[0]??null;fileMessage='';if(selectedFile?.size>32*1024*1024){selectedFile=null;fileMessage='壁纸文件无效或超过 32 MB。';}const label=document.querySelector('[data-wallpaper-filename]'),note=document.querySelector('[data-wallpaper-file-status]'),button=document.querySelector('[data-action="wallpaper-import"]');if(label)label.textContent=selectedFile?.name??window.DafeiyuI18n.t('尚未选择文件');if(note)note.textContent=window.DafeiyuI18n.message(fileMessage);if(button)button.disabled=!selectedFile;return true;}
 function action(button,ctx){
  const a=button.dataset.action;if(!a?.startsWith('wallpaper-'))return false;
  if(a==='wallpaper-import'){
   if(!selectedFile)return true;const file=selectedFile;
   void ctx.perform('wallpaper',async()=>{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error(window.DafeiyuI18n.t('文件读取失败，请重新选择。')));r.readAsDataURL(file);});const result=await ctx.request('/wallpaper',{operation:'import',name:file.name,data});if(selectedFile===file)selectedFile=null;return result;},r=>r.message);
  }else{
   const operation=a.slice('wallpaper-'.length);if(!['apply','restore','inspect','release','remove'].includes(operation))return false;
   void ctx.perform('wallpaper',()=>ctx.request('/wallpaper',{operation,...(button.dataset.wallpaperId?{id:button.dataset.wallpaperId}:{})}),r=>r.message);
  }
  return true;
 }
 window.DafeiyuWallpapers={render,edit,action};
})();
