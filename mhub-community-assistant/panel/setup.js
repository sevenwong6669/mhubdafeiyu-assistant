/* Presentation-only guide. Device, account and capture settings use the existing pages. */
(() => {
 const steps=['devices','harness','balance','voice','pet'];
 const names=['连接设备','选择 Harness 来源','余额与音箱','设置语音','可选桌宠'];
 const routes=new Set(['control/devices','control/voice','control/balance','control/speaker','control/audio','control/tts','control/live2d']);
 const memory=new Map(),storageErrors=new Set();
 const I=()=>window.DafeiyuI18n;
 const H=(text,vars)=>I().h(text,vars);
 const E=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key=data=>'dafeiyu.setup.v1.'+String(data?.dataDirectoryId??'unavailable');
 function progress(data){
  const id=key(data);if(memory.has(id))return memory.get(id);
  let saved;try{saved=JSON.parse(localStorage.getItem(id)??'null');}catch{}
  const result={step:steps.includes(saved?.step)?saved.step:'devices',completed:saved?.completed===true,active:saved?.active===true,dismissed:saved?.dismissed===true};
  memory.set(id,result);return result;
 }
 function save(data,patch){
  const id=key(data),next={...progress(data),...patch};memory.set(id,next);
  try{localStorage.setItem(id,JSON.stringify(next));storageErrors.delete(id);}catch{storageErrors.add(id);}
  return next;
 }
 const age=(value,now)=>{const at=typeof value==='number'?value:Date.parse(value);return Number.isFinite(at)&&now>=at?now-at:Infinity;};
 function status(data,now=Date.now()){
  const c=data?.controls??{},sync=c.sync??{},v=c.voice??{},inventory=data?.inventory;
  const fresh=inventory?.stale!==true&&age(inventory?.fetchedAt,now)<30000;
  const devices=fresh?(inventory.devices??[]).filter(d=>d&&d.online!==false&&d.connected!==false):[];
  const normalize=value=>String(value??'').replace(/^MCHOSE\s*/i,'').replace(/[^a-z0-9]/gi,'').toLowerCase();
  const found=model=>devices.some(d=>normalize(d.model)===model);
  const conversation=c.voiceInfo?.conversation;
  const config=data?.companion?.config?.values;
  const balance=c.balance??{};
  const model=data?.live2d?.settings?.values??config?.pet??{};
  return {
   freshInventory:fresh,ace75:found('ace75'),k20gt:found('k20gt'),
   devices:c.deviceLink?.enabled===false?'未开启':sync.running&&sync.ready===true&&!sync.reconnecting&&fresh&&devices.length?'联动已就绪':'等待连接',
   harness:config?.chat?.mode==='api'?'独立 API 模式':conversation?.available===true&&age(conversation.checkedAt,now)<30000?'来源可用':'待配置',
   balance:balance.visible===true&&balance.diagnostics?.paletteReadback==='verified'&&age(balance.updatedAt,now)<30000?'已就绪':'待验证',
   screen:found('k20gt')&&sync.ready===true&&!sync.reconnecting&&sync.screen?.captionsReady===true?'已就绪':'待验证',
   voice:v.reachable===true&&v.ready===true&&v.nativeReady===true&&v.streamReady===true&&v.playback?.ready===true?'通道就绪':'待配置',
   pet:data?.live2d?.state?.running&&data.live2d.state.petOnline?'已上线':model.modelFile&&model.coreFile?'待验证':'待配置',
  };
 }
 function getStep(data){const [view,step]=(location.hash??'').replace(/^#/,'').split('/');return view==='setup'&&steps.includes(step)?step:progress(data).step;}
 function badge(text){return `<span class="tag setup-status">${H(text)}</span>`;}
 function row(label,value){return `<div class="setup-status-row"><strong>${E(label)}</strong>${badge(value)}</div>`;}
 function open(route,label){return `<button type="button" class="button outline" data-action="setup-settings" data-route="${route}">${H(label)}</button>`;}
 function renderEntry(data){
  const p=progress(data),compact=p.completed||p.dismissed||data?.controls?.sync?.ready===true;
  return `<section class="card setup-entry${compact?' setup-entry-compact':''}" aria-labelledby="setup-entry-title"><div><h2 id="setup-entry-title">${H('首次使用引导')}</h2><p class="control-muted">${H('从连接设备开始，一步一步设置。')}</p></div><button type="button" class="button${compact?' outline':''}" data-action="setup-open">${H(p.completed?'重新查看引导':p.active||p.dismissed?'继续设置':'开始设置')}</button></section>`;
 }
 function renderReturn(data){return progress(data).active?`<div class="note-panel setup-return"><span>${H('首次使用引导')} · ${H(names[steps.indexOf(progress(data).step)])}</span><button type="button" class="button outline" data-action="setup-open">${H('返回引导')}</button></div>`:'';}
 function renderPage(data){
  const step=getStep(data),index=steps.indexOf(step),s=status(data);
  const pages={
   devices:`<p>${H('先连接设备并打开官方 M HUB，再到设备设置中主动开启联动。')}</p><p class="control-muted">${H('这份测试包先重点验证 Ace 75 和 K20 GT。')}</p><div class="setup-status-list">${row(I().t('设备控制'),s.devices)}${row('Ace 75',s.ace75?'已发现':'尚未发现')}${row('K20 GT',s.k20gt?'已发现':'尚未发现')}</div>${!s.freshInventory?`<p class="control-muted">${H('暂无实时设备清单')}</p>`:''}<div class="control-buttons">${open('control/devices','打开设备设置')}</div>`,
   harness:`<p>${H('确认 Harness 已登录，选择聊天来源；余额账户在下一步单独选择。')}</p><div class="setup-status-list">${row(I().t('聊天来源'),s.harness)}</div><div class="control-buttons">${open('control/voice','打开模型与识别')}</div>`,
   balance:`<p>${H('余额需要用户选择来源；K20 GT 屏幕设置与键盘灯带分别保存。')}</p><div class="setup-status-list">${row(I().t('余额灯带'),s.balance)}${row(I().t('音箱屏幕'),s.screen)}</div><div class="control-buttons">${open('control/balance','设置余额')}${open('control/speaker','设置音箱屏幕')}</div>`,
   voice:`<p>${H('先选择实际麦克风和播放设备，再配置识别模型及音色。')}</p><div class="setup-status-list">${row(I().t('语音聊天'),s.voice)}</div><div class="control-buttons">${open('control/audio','选择麦克风与播放设备')}${open('control/voice','打开模型与识别')}${open('control/tts','选择音色')}</div><div class="info-note">${H('请实际说一句话，确认能听见回复，并在音箱看到字幕。')}</div>`,
   pet:`<p>${H('模型和 Cubism Core 未随包附带；暂时没有也可以先使用设备后台。')}</p><div class="setup-status-list">${row('Live2D',s.pet)}</div><div class="control-buttons">${open('control/live2d','配置桌宠资源')}</div><p class="control-muted">${H('未配置的功能可以以后再补。')}</p>`,
  };
  return `<section class="setup-page" aria-labelledby="setup-title"><div class="section-header"><div><a class="setup-back" href="#control/home">‹ ${H('返回总览')}</a><h2 id="setup-title">${H('首次使用引导')}</h2></div><button type="button" class="button outline" data-action="setup-later">${H('稍后设置')}</button></div><nav aria-label="${H('设置步骤')}" class="setup-steps"><ol>${steps.map((id,i)=>`<li><button type="button" data-action="setup-step" data-step="${id}" ${id===step?'aria-current="step"':''}><span class="setup-number" aria-hidden="true">${I().number(i+1)}</span><span>${H(names[i])}${id==='pet'?`<small>${H('可选')}</small>`:''}</span></button></li>`).join('')}</ol></nav><section class="card setup-detail"><div class="control-section-heading"><h3 tabindex="-1">${H(names[index])}</h3><span class="control-muted">${H('第 {current} 步，共 {total} 步',{current:I().number(index+1),total:I().number(steps.length)})}</span></div>${pages[step]}<div class="setup-footer"><button type="button" class="button outline" data-action="setup-step" data-step="${steps[index-1]??step}" ${index===0?'disabled':''}>${H('上一步')}</button>${index<steps.length-1?`<button type="button" class="button" data-action="setup-step" data-step="${steps[index+1]}">${H('下一步')}</button>`:`<button type="button" class="button" data-action="setup-finish">${H('完成引导')}</button>`}</div></section><p class="setup-note">${H('引导不会自动开启设备控制、录音或陪看。')} ${H('引导进度只保存在当前浏览器，不会修改你的账户或设备设置。')}</p>${storageErrors.has(key(data))?`<p role="status">${H('无法保存引导进度；当前页面仍可继续设置。')}</p>`:''}</section>`;
 }
 function action(button,{data,render,navigate}){
  const action=button.dataset.action;if(!action?.startsWith('setup-'))return false;
  if(action==='setup-open'){const old=progress(data),p=save(data,{active:true,dismissed:false,...(old.completed&&!old.active?{step:'devices'}:{})});navigate('setup/'+p.step);}
  else if(action==='setup-step'&&steps.includes(button.dataset.step)){save(data,{step:button.dataset.step,active:true,dismissed:false});navigate('setup/'+button.dataset.step);}
  else if(action==='setup-settings'&&routes.has(button.dataset.route)){save(data,{step:getStep(data),active:true,dismissed:false});navigate(button.dataset.route);}
  else if(action==='setup-later'||action==='setup-finish'){save(data,{step:getStep(data),active:false,dismissed:action==='setup-later',completed:action==='setup-finish'||progress(data).completed});navigate('control/home');}
  render();return true;
 }
 window.DafeiyuSetup={status,progress,getStep,renderEntry,renderPage,renderReturn,action};
})();
