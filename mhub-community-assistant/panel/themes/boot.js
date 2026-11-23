window.DafeiyuI18n??={t:s=>s,h:s=>s,markup:s=>s,live:s=>s,number:(v,o={})=>Number(v).toFixed(o.maximumFractionDigits??0),relative:(v,u)=>String(v)+' '+u,locale:'zh-CN',message:s=>s};
/* Presentation preference only. Run before styles to avoid a flash of the wrong skin. */
(() => {
  const themes = Object.freeze([
    Object.freeze({id:'liquid-glass-light',get name(){return window.DafeiyuI18n.t("经典主题");},subtitle:'Classic',get description(){return window.DafeiyuI18n.t("清晰轻盈的浅色界面。");}}),
    Object.freeze({id:'porcelain',get name(){return window.DafeiyuI18n.t("瓷白拟物");},subtitle:'Porcelain',get description(){return window.DafeiyuI18n.t("哑光瓷白、压纹图标与有触感的按键。");}})
  ]);
  const key = 'dafeiyu.ui.theme.v1';
  const normalize = id => themes.some(theme => theme.id === id) ? id : 'liquid-glass-light';
  const read = storage => {try{return normalize(storage.getItem(key));}catch{return 'liquid-glass-light';}};
  let current = 'liquid-glass-light';
  try {current = read(window.localStorage);} catch {}
  document.documentElement.dataset.theme = current;
  window.DafeiyuThemePreference = Object.freeze({themes,key,normalize,read});
})();
