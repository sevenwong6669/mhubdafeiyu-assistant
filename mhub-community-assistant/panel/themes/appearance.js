window.DafeiyuI18n??={t:s=>s,h:s=>s,markup:s=>s,live:s=>s,number:(v,o={})=>Number(v).toFixed(o.maximumFractionDigits??0),relative:(v,u)=>String(v)+' '+u,locale:'zh-CN',message:s=>s};
/* All skins share the existing DOM, event handlers, drafts and APIs. Never rerender content. */
(() => {
  const pref = window.DafeiyuThemePreference, root = document.documentElement;
  if (!pref) return;
  // Native hosts register asset routes at startup. An older host can proxy
  // the new HTML before it can serve the new theme's stylesheet.
  const porcelainReady = Boolean(document.querySelector('link[href="themes/porcelain/theme.css"]')?.sheet);
  const themes = pref.themes.filter(theme => theme.id !== 'porcelain' || porcelainReady);
  if (!themes.some(theme => theme.id === root.dataset.theme)) root.dataset.theme = pref.normalize(null);
  const asset = new URL('assets/dafeiyu-original.png',document.currentScript.src).href;
  const open = document.createElement('button');
  open.type='button';open.className='appearance-open';open.textContent=window.DafeiyuI18n.t("外观");
  open.setAttribute('aria-label',window.DafeiyuI18n.t("外观"));
  const currentName=document.createElement('span');currentName.className='appearance-current';open.append(currentName);
  open.setAttribute('aria-haspopup','dialog');open.setAttribute('aria-controls','appearance-dialog');
  document.querySelector('.header-actions')?.prepend(open);
  const dialog=document.createElement('dialog');dialog.id='appearance-dialog';dialog.className='appearance-dialog';
  dialog.setAttribute('aria-labelledby','appearance-title');
  dialog.innerHTML=`<div class="appearance-heading"><div><small>PERSONALIZE YOUR COMPANION</small><h2 id="appearance-title">${window.DafeiyuI18n.h("外观设置")}</h2></div><button type="button" class="appearance-close" aria-label="${window.DafeiyuI18n.h("关闭外观设置")}">×</button></div><h3>${window.DafeiyuI18n.h("界面主题")}</h3><p class="appearance-description">${window.DafeiyuI18n.h("随时换一种心情。当前页面和正在编辑的参数都会保留。")}</p><div class="appearance-choices">${themes.map(theme=>`<button type="button" class="appearance-choice" data-theme-choice="${theme.id}" aria-pressed="false"><span class="appearance-thumbnail appearance-thumbnail--${theme.id}" aria-hidden="true"><span class="appearance-mini-sidebar"><i></i><b></b><b></b><b></b></span><span class="appearance-mini-main"><i></i><span><b></b><b></b><b></b></span><i></i></span></span><span class="appearance-choice-name">${theme.name}<span class="appearance-check" aria-hidden="true">✓</span></span>${theme.subtitle === theme.name ? "" : `<small lang="en" translate="no">${theme.subtitle}</small>`}<span class="appearance-choice-description">${theme.description}</span></button>`).join('')}</div><p class="appearance-status" role="status" aria-live="polite"></p><div class="appearance-footer"><span>${window.DafeiyuI18n.h("只保存外观偏好，不更改设备参数。")}</span><button type="button" class="appearance-done">${window.DafeiyuI18n.h("完成")}</button></div>`;
  document.body.append(dialog);
  const wallpaper=document.createElement('section');wallpaper.className='appearance-mhub-wallpaper';
  wallpaper.innerHTML=`<h3>${window.DafeiyuI18n.h('M HUB 壁纸')}</h3><p>${window.DafeiyuI18n.h('替换驱动的图片、GIF 或视频背景，不改设备灯光。')}</p><a class="button outline" href="#control/wallpaper">${window.DafeiyuI18n.h('管理 M HUB 壁纸')}</a>`;
  dialog.querySelector('.appearance-footer').before(wallpaper);
  wallpaper.querySelector('a').addEventListener('click',()=>dialog.close());
  const avatar=document.createElement('span');avatar.className='smartisan-avatar';avatar.setAttribute('aria-hidden','true');
  const image=document.createElement('img');image.src=asset;image.alt='';image.width=190;image.height=176;avatar.append(image);
  document.querySelector('.brand')?.prepend(avatar);
  const icons={
    control:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M7 8h10"/>',
    overview:'<ellipse cx="12" cy="12" rx="7" ry="9" transform="rotate(38 12 12)"/><path d="M3 19 21 5"/>',
    library:'<path d="M12 5C8 2 3 4 3 4v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1Zm0 0v15"/>',
    devices:'<rect x="7" y="6" width="10" height="13" rx="3"/><path d="M10 2h4v4m-2 4v3m-2 6v3h4v-3"/>',
    activity:'<circle cx="12" cy="12" r="9"/><path d="M12 6v7h5"/>'
  };
  const tabIcons={live2d:'<circle cx="12" cy="12" r="9"/><path d="M7 8 5 3m12 5 2-5M8 12h1m6 0h1m-7 5h6"/>',phone:'<path d="M6 3h4l2 5-3 2a14 14 0 0 0 5 5l2-3 5 2v4c0 2-2 3-4 2C9 18 4 13 3 7c-1-2 0-4 3-4Z"/>',home:'<path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10"/>',bindings:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',states:'<path d="M8 17c0-4-3-4-3-9a7 7 0 0 1 14 0c0 5-3 5-3 9ZM9 20h6m-5 3h4"/>',speaker:'<rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="15" r="4"/><circle cx="12" cy="6" r="1"/>',voice:'<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',balance:'<rect x="2" y="5" width="20" height="14" rx="1"/><circle cx="12" cy="12" r="3"/><path d="M5 9h2m10 6h2"/>'};
  function decorate() {
    // The V5 skin adds a direct link to the existing audio page. The existing
    // control-tab handler remains the only navigation/business implementation.
    const tabs=document.querySelector('.control-tabs');
    let audio=tabs?.querySelector('[data-liquid-audio]');
    if(root.dataset.theme==='liquid-glass-light'&&tabs){
      if(!audio){audio=document.createElement('button');audio.type='button';audio.textContent=window.DafeiyuI18n.t("音频设备");audio.dataset.action='control-tab';audio.dataset.tab='audio';audio.dataset.liquidAudio='';tabs.insertBefore(audio,tabs.querySelector('[data-tab="balance"]'));}
      audio.classList.toggle('selected',!!document.querySelector('.control-subtabs [data-tab="audio"].selected'));
    }else audio?.remove();
    document.querySelectorAll('.sidebar nav a[data-view]').forEach(button=>{
      if(button.querySelector('.smartisan-nav-icon'))return;
      const icon=document.createElement('span');icon.className='smartisan-nav-icon';icon.setAttribute('aria-hidden','true');
      icon.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${tabIcons[button.dataset.panelTab]??icons[button.dataset.view]??icons.control}</svg>`;button.prepend(icon);
    });
    document.querySelectorAll('.control-tabs button[data-tab]').forEach(button=>{
      if(button.querySelector('.smartisan-tab-icon'))return;
      const icon=document.createElement('span');icon.className='smartisan-tab-icon';icon.setAttribute('aria-hidden','true');icon.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${tabIcons[button.dataset.tab]??tabIcons.home}</svg>`;button.prepend(icon);
    });
    document.querySelectorAll('.task-light-card').forEach(card=>{
      const color=card.querySelector('input[type="color"]');
      if(color)card.style.setProperty('--state-color',color.value);
      const source=card.querySelector('input[name$=".brightness"]');if(!source)return;
      if(source.parentElement.querySelector('.smartisan-range'))return;
      const range=document.createElement('input');range.type='range';range.className='smartisan-range';range.min=source.min;range.max=source.max;range.step=source.step||'1';range.value=source.value;
      range.setAttribute('aria-label',source.getAttribute('aria-label')+window.DafeiyuI18n.t("滑块"));range.style.setProperty('--fill',source.value+'%');
      source.parentElement.classList.add('smartisan-brightness');source.parentElement.append(range);
      range.addEventListener('input',()=>{source.value=range.value;range.style.setProperty('--fill',range.value+'%');source.dispatchEvent(new Event('input',{bubbles:true}));});
    });
  }
  const observer=new MutationObserver(decorate);observer.observe(document.querySelector('#content'),{childList:true,subtree:true});decorate();
  document.addEventListener('input',event=>{
    const card=event.target.closest('.task-light-card');if(!card)return;
    if(event.target.type==='color')card.style.setProperty('--state-color',event.target.value);
    if(event.target.name?.endsWith('.brightness')){const range=card.querySelector('.smartisan-range');if(range){range.value=event.target.value;range.style.setProperty('--fill',range.value+'%');}}
  });
  function reflect(){
    const theme=themes.find(theme=>theme.id===root.dataset.theme);
    currentName.textContent=theme?' · '+theme.name:'';
    dialog.querySelectorAll('[data-theme-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===root.dataset.theme)));
  }
  function choose(id,persist=true){
    if (!themes.some(theme => theme.id === id)) id = pref.normalize(null);
    root.dataset.theme=pref.normalize(id);root.classList?.toggle('smartisan-font-scope',root.dataset.theme==='smartisan');decorate();reflect();
    let message=window.DafeiyuI18n.t("主题已切换，页面和未保存的修改已保留。");
    if(persist)try{window.localStorage.setItem(pref.key,root.dataset.theme);}catch{message=window.DafeiyuI18n.t("已切换；当前浏览器不允许保存外观偏好，重新打开时将使用经典主题。");}
    dialog.querySelector('.appearance-status').textContent=message;
  }
  open.addEventListener('click',()=>{reflect();dialog.querySelector('.appearance-status').textContent='';dialog.showModal();});
  dialog.addEventListener('click',event=>{const choice=event.target.closest('[data-theme-choice]');if(choice)choose(choice.dataset.themeChoice);if(event.target===dialog||event.target.closest('.appearance-close,.appearance-done'))dialog.close();});
  dialog.addEventListener('close',()=>open.focus({preventScroll:true}));
  window.addEventListener('storage',event=>{if(event.key===pref.key||event.key===null){let id=pref.normalize(null);try{id=pref.read(window.localStorage);}catch{}choose(id,false);}});
  reflect();
})();
