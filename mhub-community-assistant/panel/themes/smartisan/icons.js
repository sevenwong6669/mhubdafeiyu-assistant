window.DafeiyuI18n??={t:s=>s,h:s=>s,markup:s=>s,live:s=>s,number:(v,o={})=>Number(v).toFixed(o.maximumFractionDigits??0),relative:(v,u)=>String(v)+' '+u,locale:'zh-CN',message:s=>s};
/* Presentation only. The original controls, text, forms and handlers stay in place. */
(() => {
 const root=document.documentElement,base=new URL('assets/',document.currentScript.src);
 let catalog=null,pending=null;
 const failed=new Set();
 const nav={control:'control',overview:'community',library:'knowledge',devices:'devices',activity:'history'};
 const tabs={live2d:'screen',home:'home',bindings:'keyboard',states:'lights',speaker:'screen',voice:'voice',tts:'voice',balance:'balance',audio:'audio',phone:'voice',captions:'captions',notices:'status-attention',devices:'devices'};
 const commands={'voice-start':'recognition','voice-restart':'refresh','voice-interrupt':'cancel','voice-stop':'cancel','sync-start':'refresh','sync-stop':'cancel','sync-devices-refresh':'refresh','device-default-theme':'screen','screen-animation':'screen','screen-text':'captions','screen-pages':'screen','screen-page-next':'screen','balance-refresh':'refresh','subtitle-preview':'play','audio-test':'play','audio-apply':'save','game-start':'play','game-toggle':'play','game-replay':'refresh','game-stop':'cancel','task-light-stop':'cancel','phone-dial':'voice','phone-demo':'voice','phone-accept':'voice','phone-reject':'cancel','phone-hangup':'cancel','phone-mute':'recognition'};
 const actions={'refresh':'refresh','learn':'refresh','devices':'refresh','learning-save':'save','learning-reset':'cancel','control-save':'save','control-reset':'cancel','tts-save':'save','tts-reset':'cancel','tts-models':'refresh','tts-voices':'refresh','tts-preview':'play','tts-test':'recognition','tts-apply':'voice','tts-settings':'save','control-preview':'play','devices-refresh':'refresh','control-audio-refresh':'refresh','control-audio-test':'play','control-audio-apply':'save','control-balance-toggle':'balance'};
 function load(){
  if(catalog||pending)return;
  pending=fetch(new URL('icons.json',base),{cache:'force-cache'}).then(r=>{if(!r.ok)throw Error('Icon catalog unavailable');return r.json();}).then(value=>{catalog=value.icons;decorate();}).catch(()=>{pending=null;});
 }
 function glyph(target,id,{host=target,kind='button'}={}){
  const spec=catalog[id];if(!spec||failed.has(id)||host.querySelector(':scope > .sm-art-glyph'))return;
  const holder=document.createElement('span');holder.className='sm-art-glyph';holder.hidden=true;holder.dataset.smIcon=id;holder.dataset.smKind=kind;holder.dataset.smMask=String(!!spec.mask);holder.setAttribute('aria-hidden','true');
  holder.dataset.smPainted=String(spec.render==='painted');
  const [x,y,size]=spec.crop;
  holder.style.setProperty('--sm-image-width',spec.width/size*100+'%');holder.style.setProperty('--sm-image-height',spec.height/size*100+'%');holder.style.setProperty('--sm-image-left',-x/size*100+'%');holder.style.setProperty('--sm-image-top',-y/size*100+'%');
  for(const state of ['normal','selected','pressed']){
   const image=document.createElement('img');image.src=new URL(spec[state],base).href;image.alt='';image.draggable=false;image.dataset.smState=state;image.width=spec.width;image.height=spec.height;
   image.addEventListener('error',()=>{failed.add(id);holder.remove();target.classList.remove('sm-art-target');host.classList.remove('sm-art-host');},{once:true});holder.append(image);
  }
  target.classList.add('sm-art-target');host.classList.add('sm-art-host');host.prepend(holder);
 }
 function buttonIcon(button,id){
  if(!id)return;
  glyph(button,id);
  // Keep original accessible text and symbols intact for the other skins.
  if(['learn','devices'].includes(button.dataset.action)&&!button.querySelector('.sm-art-label')){
   const label=document.createElement('span');label.className='sm-art-label';label.hidden=true;label.setAttribute('aria-hidden','true');label.textContent=[...button.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').replace(/^\s*[✧↻]\s*/u,'');button.append(label);button.classList.add('sm-art-symbol-label');
  }
 }
 function decorate(){
  if(root.dataset.theme!=='smartisan')return;
  if(!catalog){load();return;}
  document.querySelectorAll('.sidebar nav a[data-view]').forEach(button=>{
   // font-size:0 hides the legacy symbol, but its anonymous flex item still
   // creates an extra gap. Keep the original text in a theme-aware wrapper.
   for(const node of [...button.childNodes])if(node.nodeType===3&&node.textContent.trim()){
    const fallback=document.createElement('span');fallback.className='sm-nav-fallback';fallback.style.display='contents';fallback.style.fontSize='0';fallback.style.lineHeight='0';fallback.textContent=node.textContent;fallback.setAttribute('aria-hidden','true');node.replaceWith(fallback);
   }
   const host=button.querySelector('.smartisan-nav-icon');if(host)glyph(button,tabs[button.dataset.panelTab==='phone'?'voice':button.dataset.panelTab]??nav[button.dataset.view],{host,kind:'nav'});
  });
  document.querySelectorAll('.control-tabs button[data-tab]').forEach(button=>{const host=button.querySelector('.smartisan-tab-icon');if(host)glyph(button,tabs[button.dataset.tab],{host,kind:'tab'});});
  document.querySelectorAll('.control-subtabs button[data-tab]').forEach(button=>buttonIcon(button,button.dataset.tab==='voice'?'recognition':tabs[button.dataset.tab]));
  document.querySelectorAll('button[data-action]').forEach(button=>{
   if(button.dataset.action==='control-tab')return;
   buttonIcon(button,button.dataset.action==='control-run'?commands[button.dataset.command]:actions[button.dataset.action]);
  });
  const appearance=document.querySelector('.appearance-open');if(appearance)buttonIcon(appearance,'screen');
  const family={'◉':'mouse','▤':'keyboard','∩':'audio','◫':'speaker','◇':'devices'};
  function deviceIcon(el){
   const symbol=el.textContent.trim();
   if(symbol==='⌁')return /MagDock/i.test(el.closest('.device-card,.device-pill')?.textContent??'')?'mouse-dock':'headset-dock';
   return family[symbol];
  }
  document.querySelectorAll('.device-symbol').forEach(el=>{const id=deviceIcon(el);if(id)glyph(el,id,{kind:'device'});});
  document.querySelectorAll('.device-pill i').forEach(el=>{const id=deviceIcon(el);if(id)glyph(el,id,{kind:'pill'});});
  document.querySelectorAll('.connection-icon').forEach(el=>{const title=el.closest('.connection')?.querySelector('strong')?.textContent;glyph(el,title?.includes('语音')?'voice':title?.includes('QQ')?'captions':'devices',{kind:'connection'});});
  document.querySelectorAll('.task-light-card').forEach(card=>{
   const state=card.querySelector('[data-action="control-preview"]')?.dataset.state;
   const mark=card.querySelector('h3 i');
   if(mark)glyph(mark,{IDLE:'status-idle',BUSY:'status-working',ATTENTION:'status-attention'}[state],{kind:'status'});
   const color=card.querySelector('input[type="color"]'),label=color?.closest('label');
   if(label&&!label.querySelector('.sm-color-value')){
    const value=document.createElement('span');value.className='sm-color-value';value.hidden=true;value.setAttribute('aria-hidden','true');value.textContent=color.value.toUpperCase();label.append(value);
   }
  });
  const companion=document.querySelector('.control-runtime-grid>.card:nth-child(2)');
  if(companion&&!companion.querySelector('.sm-runtime-caption')){
   const caption=document.createElement('p');caption.className='sm-runtime-caption';caption.hidden=true;caption.textContent=window.DafeiyuI18n.t("动画、任务状态和主动陪伴，随时切换。");companion.querySelector('.control-section-heading')?.after(caption);
  }
 }
 document.addEventListener('input',event=>{
  if(event.target.matches('.task-light-card input[type="color"]')){
   const value=event.target.closest('label')?.querySelector('.sm-color-value');if(value)value.textContent=event.target.value.toUpperCase();
  }
 });
 new MutationObserver(decorate).observe(root,{attributes:true,attributeFilter:['data-theme']});
 const content=document.querySelector('#content');if(content)new MutationObserver(decorate).observe(content,{childList:true,subtree:true});
 decorate();
})();
