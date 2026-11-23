/* The overview owns one flag-strip entry; choosing a language is a separate page. */
(() => {
 const I=window.DafeiyuI18n,h=I.h;let saveError='',overviewScroll=null,restoreOverview=false;
 const flags={'zh-CN':'flag-china.png',ru:'flag-russia.png',en:'flag-usa.png',fr:'flag-france.png',it:'flag-italy.svg'};
 const showFlags=()=>document.documentElement?.dataset?.theme==='smartisan';
 const image=id=>`<img class="language-flag" data-language-flag="${id}" ${showFlags()?`src="i18n/assets/${flags[id]}"`:''} alt="" aria-hidden="true" draggable="false">`;
 if(typeof MutationObserver==='function'){
  new MutationObserver(()=>{
   document.querySelectorAll('[data-language-flag]').forEach(flag=>{
    const name=flags[flag.dataset.languageFlag];
    if(showFlags()&&name)flag.setAttribute('src','i18n/assets/'+name);
    else flag.removeAttribute('src');
   });
  }).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
 }
 function renderEntry(){const current=I.languages.find(([id])=>id===I.locale);return `<section class="overview-language" aria-labelledby="overview-language-title"><h2 id="overview-language-title">${h('语言设置')}</h2><button type="button" class="overview-language-entry" data-ui-language-open aria-label="${h('语言')} ${current[1]}"><span class="overview-language-label">${h('语言')}</span><span class="overview-language-flags" aria-hidden="true">${I.languages.map(([id])=>image(id)).join('')}</span><span class="overview-language-current" lang="${current[0]}" translate="no">${current[1]}</span><span class="language-arrow" aria-hidden="true"></span></button><p class="overview-language-status" role="status">${saveError?h(saveError):''}</p></section>`;}
 function renderPage(){return `<section class="language-pane"><header class="language-page-heading"><button type="button" class="language-back" data-ui-language-back>‹ ${h('返回总览')}</button><h2>${h('语言')}</h2></header><p class="language-hint">${h('点选语言后立即生效，并返回总览。')}</p><fieldset class="language-list"><legend class="visually-hidden">${h('设置语言')}</legend>${I.languages.map(([id,name])=>`<label class="language-row">${image(id)}<span class="language-name" lang="${id}" translate="no">${name}</span><input type="radio" name="interface-language" value="${id}" ${I.locale===id?'checked':''}><span class="language-check" aria-hidden="true"></span><span class="visually-hidden">${I.locale===id?h('当前语言'):''}</span></label>`).join('')}</fieldset></section>`;}
 function back(){restoreOverview=true;location.replace('#control/home');}
 function choose(id){if(!I.languages.some(([locale])=>locale===id))return;saveError='';if(!I.setLocale(id))saveError='语言偏好未能保存，重新打开后可能恢复默认语言。';back();}
 document.addEventListener('click',event=>{const choice=event.target.closest('.language-row');if(choice){event.preventDefault();choose(choice.querySelector('input[name="interface-language"]').value);return;}if(event.target.closest('[data-ui-language-open]')){overviewScroll=window.scrollY;location.hash='language';return;}if(event.target.closest('[data-ui-language-back]'))back();});
 document.addEventListener('change',event=>{if(event.target.matches('input[name="interface-language"]'))choose(event.target.value);});
 window.addEventListener('hashchange',()=>{if(restoreOverview&&location.hash==='#control/home'){restoreOverview=false;requestAnimationFrame(()=>{const entry=document.querySelector('[data-ui-language-open]');if(overviewScroll!==null)window.scrollTo(0,overviewScroll);const rect=entry?.getBoundingClientRect?.();if(overviewScroll===null||rect&&(rect.top<0||rect.bottom>window.innerHeight))entry?.scrollIntoView?.({block:'end'});entry?.focus({preventScroll:true});});}});
 window.DafeiyuLanguage={renderEntry,renderPage};
})();
