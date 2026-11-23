window.DafeiyuI18n??={t:s=>s,h:s=>s,markup:s=>s,live:s=>s,number:(v,o={})=>Number(v).toFixed(o.maximumFractionDigits??0),relative:(v,u)=>String(v)+' '+u,locale:'zh-CN',message:s=>s};
const API = '/api/mhub-community';
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const E = escapeHTML;
const labels = window.DafeiyuI18n.live({ 1001: window.DafeiyuI18n.t("键盘配置"), 1002: window.DafeiyuI18n.t("静态灯效"), 1003: window.DafeiyuI18n.t("动态灯效"), 1004: window.DafeiyuI18n.t("键盘宏"), 2001: window.DafeiyuI18n.t("鼠标配置"), 2002: window.DafeiyuI18n.t("鼠标宏"), 3001: window.DafeiyuI18n.t("音频 EQ") });
const categories = window.DafeiyuI18n.live({ 'mouse-profile': window.DafeiyuI18n.t("鼠标配置"), 'mouse-macro': window.DafeiyuI18n.t("鼠标宏"), 'keyboard-profile': window.DafeiyuI18n.t("键盘配置"), 'keyboard-light': window.DafeiyuI18n.t("静态灯效"), 'keyboard-animation': window.DafeiyuI18n.t("动态灯效"), 'keyboard-macro': window.DafeiyuI18n.t("键盘宏"), 'audio-eq': window.DafeiyuI18n.t("音频 EQ") });
const familyNames = window.DafeiyuI18n.live({ mouse: window.DafeiyuI18n.t("鼠标"), keyboard: window.DafeiyuI18n.t("键盘"), headset: window.DafeiyuI18n.t("耳机"), speaker: window.DafeiyuI18n.t("音箱"), dock: window.DafeiyuI18n.t("底座"), other: window.DafeiyuI18n.t("外设") });
const symbols = { mouse: '◉', keyboard: '▤', headset: '∩', speaker: '◫', dock: '⌁', other: '◇' };
const state = { data: null, view: 'control', query: '', filter: 'all', device: '', category: 'mouse-profile', fresh: false, limit: 6, librarySource: 'local', result: null, resultKey: '', searchAttempt: 0, pendingSearch: false, searchFeedback: '', drawer: null, drawerDevice: '', slot: 1, proposal: null, previewAttempt: 0, previewPending: false, previewError: '', learningDraft:null,drawerOpener:null,busy: new Set() };
let refreshPending=null,refreshRenderRequests=null,pollTimer=null,reconnectDelay=1000,reconnecting=false,connectionNotice='';
function time(value,full=false){if(!value||!Number.isFinite(Date.parse(value)))return window.DafeiyuI18n.t('尚未读取');if(full)return new Date(value).toLocaleString(window.DafeiyuI18n.locale,{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000));return minutes<1?window.DafeiyuI18n.t('刚刚'):window.DafeiyuI18n.relative(-(minutes<60?minutes:minutes<1440?Math.floor(minutes/60):Math.floor(minutes/1440)),minutes<60?'minute':minutes<1440?'hour':'day');}
function toast(message) { $('#toast').textContent = window.DafeiyuI18n.message(message); $('#toast').style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').style.display = 'none'; }, 4000); }
async function request(route, input) {
  let response;
  try { response = await fetch(API + route, { method: input === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(input === undefined ? {} : { 'x-mhub-panel-token': state.data?.token ?? '' }) },
    signal:AbortSignal.timeout(input===undefined?8000:route==='/controls/tts'?195000:45000),...(input === undefined ? {} : { body: JSON.stringify(input) }) }); }
  catch(error){
    if(error.name==='TypeError'||/failed to fetch|networkerror|load failed/i.test(error.message??'')||input!==undefined&&['TimeoutError','AbortError'].includes(error.name)){
      const message=input===undefined?'后台暂时断开，正在自动重连；未保存的修改会保留。':['TimeoutError','AbortError'].includes(error.name)?'操作等待超时，这次操作结果尚未确认；正在重连，请先查看状态再操作。':'后台连接中断，这次操作结果尚未确认；正在重连，请先查看状态再操作。';
      throw Object.assign(new Error(window.DafeiyuI18n.t(message)),{code:'PANEL_OFFLINE'});
    }
    throw error;
  }
  let body; try { body = await response.json(); } catch {
    // A lost or replaced receipt cannot tell us whether a mutation executed.
    // Recover with state reads, never by resending the original operation.
    const message=input===undefined?'面板连接暂时不可用，请稍后刷新。':'后台连接中断，这次操作结果尚未确认；正在重连，请先查看状态再操作。';
    throw Object.assign(new Error(window.DafeiyuI18n.t(message)),{code:'PANEL_OFFLINE'});
  }
  if (!response.ok) {
    const error=new Error(window.DafeiyuI18n.message(body.error) || window.DafeiyuI18n.t("这次操作未完成。"));
    // Native transport reports a temporarily unavailable local broker as HTTP
    // 503 rather than a rejected fetch. Clear that notice after recovery too.
    if(response.status===503)error.code='PANEL_OFFLINE';
    throw error;
  }
  return body;
}
function updateRecovery(){
 const el=$('#recovery-status');if(!el)return;
 const recovery=state.data?.recovery;
 const age=Date.now()-Number(recovery?.at);
 const settled=['completed','partial','failed'].includes(recovery?.phase);
 const recent=age>=0&&age<(recovery?.phase==='completed'?6000:60000);
 const recoveryVisible=Boolean(recovery)&&(recovery.active||!settled||!Number.isFinite(age)||recent);
 const updateNeeded=state.data?.deploymentVersion?.restartRequired===true;
 const failures=['partial','failed'].includes(recovery?.phase)&&Array.isArray(recovery.results)?recovery.results.filter(item=>item?.ok===false&&typeof item.message==='string').map(item=>window.DafeiyuI18n.message(item.message)):[];
 const remaining=recovery?.active&&!recovery?.stalled&&Number.isFinite(recovery.deadlineAt)?window.DafeiyuI18n.t('恢复剩余时间：{seconds} 秒',{seconds:Math.max(0,Math.ceil((recovery.deadlineAt-Date.now())/1000))}):'';
 const message=[
  ...(updateNeeded?[window.DafeiyuI18n.t('需要重启插件生效')]:[]),
  ...(recoveryVisible?[window.DafeiyuI18n.message(recovery.message??recovery.phase??''),...failures,remaining]:[]),
 ].filter(Boolean).join('\n');
 if(el.textContent!==message)el.textContent=message;
 el.hidden=!message;
 (document.querySelectorAll?.('[data-action="plugin-restart"]')??[]).forEach(button=>{button.disabled=state.busy.has('plugin-restart')||recovery?.active===true&&!recovery?.canRecheck;const label=window.DafeiyuI18n.t(recovery?.canRecheck?'重新检查恢复任务':'重启插件');const key=recovery?.canRecheck?'重新检查恢复任务':'重启插件';if(button.getAttribute?.('data-i18n')!==key)button.setAttribute?.('data-i18n',key);
    const text=button.querySelector?.('.sm-btn-text');if(text){if(text.textContent!==label)text.textContent=label;}
    else {const node=[...(button.childNodes??[])].find(n=>n.nodeType===3&&n.textContent.trim());if(node){if(node.textContent!==label)node.textContent=label;}else if(!button.childNodes?.length)button.textContent=label;}});
}
async function refresh(renderPage = true) {
  if(refreshPending){refreshRenderRequests.add(renderPage);return refreshPending;}
  // Share the read, but keep each caller's rendering intent. A manual refresh
  // must not inherit the suppression policy of an earlier background poll.
  const renderRequests=new Set([renderPage]);refreshRenderRequests=renderRequests;
  const task=(async()=>{
    const previousData=state.data;
    const data = await request('/state'); state.data = data; window.DafeiyuControls?.reconcile?.(state);
    if (!state.device) state.device = data.inventory?.devices?.find(d => d.family === 'mouse')?.model ?? data.inventory?.devices?.find(d => d.family === 'keyboard')?.model ?? '';
    $('#nav-count').textContent = data.counts.records;
    const versionNode=$('footer span');if(versionNode&&data.version)versionNode.textContent=window.DafeiyuI18n.t("迈从大肥鱼插件 · v")+data.version;
    if(reconnecting){reconnecting=false;reconnectDelay=1000;if($('#notice').textContent===connectionNotice)$('#notice').textContent='';toast(window.DafeiyuI18n.t("后台连接已恢复"));}
    updateRecovery();
    if ([...renderRequests].some(policy=>typeof policy==='function'?policy(previousData):policy)) render();
  })();
  refreshPending=task;
  try{return await task;}finally{if(refreshPending===task){refreshPending=null;refreshRenderRequests=null;}}
}
function reportConnectionError(error){
  const offline=error.code==='PANEL_OFFLINE'||['TimeoutError','AbortError'].includes(error.name);
  if(offline){reconnecting=true;connectionNotice=error.code==='PANEL_OFFLINE'?error.message:window.DafeiyuI18n.t("后台连接超时，正在自动重连；未保存的修改会保留。");$('#notice').textContent=connectionNotice;}
  else $('#notice').textContent=error.message;
  if(!state.data)$('#content').innerHTML=empty(offline?window.DafeiyuI18n.t("正在重新连接后台"):window.DafeiyuI18n.t("连接没有就绪"),offline?window.DafeiyuI18n.t("后台恢复后会自动继续，无需反复刷新。"):error.message);
}
function scheduleRefresh(delay=5000){clearTimeout(pollTimer);pollTimer=setTimeout(()=>{void pollOnce();},delay);}
async function pollOnce(){
  if(!document.hidden){
    // Replacing unchanged gallery HTML would restart its video previews every
    // five seconds. Explicit refresh/actions still render immediately.
    try{await refresh(previous=>!state.drawer&&!state.busy.size&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)&&!(state.view==='control'&&window.DafeiyuControls?.getTab()==='wallpaper'&&previous?.wallpapers&&JSON.stringify(previous.wallpapers)===JSON.stringify(state.data?.wallpapers)));}
    catch(error){reportConnectionError(error);}
  }
  scheduleRefresh(reconnecting?reconnectDelay:5000);
  if(reconnecting)reconnectDelay=Math.min(10000,reconnectDelay*2);
}
function normalized(value) { return String(value ?? '').replace(/^MCHOSE\s*/i, '').replace(/\s+/g, '').toLowerCase(); }
function eligible(item,device=state.device) {
  if (!device) return false;
  if ([1001, 2001, 3001].includes(item.category)) return normalized(item.device) === normalized(device);
  const family = state.data.inventory?.devices.find(d => d.model === device)?.family;
  return family === 'mouse' && item.category === 2002 || family === 'keyboard' && [1002,1003,1004].includes(item.category);
}
function card(item) {
  return `<article class="share-card"><div class="share-meta"><span class="tag">${E(labels[item.category] ?? window.DafeiyuI18n.t("社区分享"))}</span><span class="tag amber">${window.DafeiyuI18n.h("待验证")}</span></div><div class="share-name">${E(item.title || window.DafeiyuI18n.t("未命名分享"))}</div><div class="share-author">${E(item.author || window.DafeiyuI18n.t("未提供作者"))}</div><div class="share-tags">${E(item.tags || window.DafeiyuI18n.t("未提供标签"))}</div><div class="share-footer"><span>${E(time(item.fetchedAt))}${window.DafeiyuI18n.h("读取")}</span><button data-action="detail" data-code="${E(item.shareCode)}" aria-label="${window.DafeiyuI18n.h("查看")} ${E(item.title)} ${window.DafeiyuI18n.h("的详情")}">${window.DafeiyuI18n.h("查看分享 ↗")}</button></div></article>`;
}
function communityTabs(selected) {
  const entries = [['library', '分享库'], ['overview', '自动整理']];
  return '<div class="control-subtabs community-tabs">'+entries.map(([view,label]) =>
    `<button type="button" data-view="${view}" class="${view===selected?'selected':''}" aria-current="${view===selected?'page':'false'}">${window.DafeiyuI18n.h(label)}</button>`
  ).join('')+'</div>';
}
function learningControls(){
 const schedule=state.data.schedule??{},draft=state.learningDraft,values=draft?.values??{enabled:schedule.enabled??schedule.active??false,intervalHours:schedule.intervalHours??4},job=state.data.job;
 const stages=window.DafeiyuI18n.live({'queued':window.DafeiyuI18n.t("准备整理"),'reading-devices':window.DafeiyuI18n.t("读取设备范围"),'reading-community':window.DafeiyuI18n.t("读取社区资料"),'saving-knowledge':window.DafeiyuI18n.t("保存知识"),'completed':window.DafeiyuI18n.t("整理完成"),'partial':window.DafeiyuI18n.t("部分完成"),'cancelled':window.DafeiyuI18n.t("已取消"),'failed':window.DafeiyuI18n.t("未完成"),'network':window.DafeiyuI18n.t("网络不可用"),'capacity':window.DafeiyuI18n.t("容量达到上限"),'write_locked':window.DafeiyuI18n.t("知识写锁占用"),'corrupt_data':window.DafeiyuI18n.t("记录需要检查"),'interrupted':window.DafeiyuI18n.t("上次运行被中断")});
 const label=schedule.error?window.DafeiyuI18n.t("计划需要检查"):job?.status==='running'?stages[job.stage]??window.DafeiyuI18n.t("正在整理"):!values.enabled?window.DafeiyuI18n.t("自动学习已关闭"):schedule.hostRunning?window.DafeiyuI18n.t("Harness 插件调度中"):window.DafeiyuI18n.t("等待 Harness 插件启动");
 const when=value=>value?E(new Date(value).toLocaleString(window.DafeiyuI18n.locale,{hour12:false})):window.DafeiyuI18n.t("尚无记录");
 return `<section class="card"><div class="section-header"><div><h2>${window.DafeiyuI18n.h("社区学习计划")}</h2><p>${E(label)} ${window.DafeiyuI18n.h("· 本机执行，不调用 Codex 或聊天模型。")}</p></div><span class="tag">${E(schedule.hostVersion?window.DafeiyuI18n.t("插件 ")+schedule.hostVersion:window.DafeiyuI18n.t("独立后台"))}</span></div><div class="search-controls"><label><input type="checkbox" id="learning-enabled" ${values.enabled?'checked':''}>${window.DafeiyuI18n.h("启用自动整理")}</label><label>${window.DafeiyuI18n.h("整理频率")} <select id="learning-interval">${Array.from({length:24},(_,i)=>i+1).map(n=>`<option value="${n}" ${values.intervalHours===n?'selected':''}>${window.DafeiyuI18n.phrase("everyHours",n)}</option>`).join('')}</select></label></div><p class="source-line">${window.DafeiyuI18n.h("下一次计划：")}${schedule.enabled?when(schedule.nextRunAt):window.DafeiyuI18n.t("自动计划已关闭")}${schedule.hostRunning?'':window.DafeiyuI18n.t(" · 等待 Harness 打开后执行")}</p><div class="control-buttons"><button class="button" data-action="learning-save" ${!draft||!schedule.revision||state.busy.has('learning-settings')?'disabled':''}>${window.DafeiyuI18n.h("保存计划")}</button><button class="button outline" data-action="learning-reset" ${!draft?'disabled':''}>${window.DafeiyuI18n.h("撤销修改")}</button><button class="button outline" data-action="learn" ${job?.status==='running'||state.busy.has('learn')?'disabled':''}>${window.DafeiyuI18n.h("立即整理一次")}</button></div><p class="source-line">${window.DafeiyuI18n.h("最近尝试：")}${when(schedule.lastAttempt)}<br>${window.DafeiyuI18n.h("最近成功：")}${when(schedule.lastSuccess)}</p>${job?`<p role="status">${window.DafeiyuI18n.h("本轮：")}${E(stages[job.stage]??job.status)} ${window.DafeiyuI18n.h("· 已请求")} ${job.requests??0}${window.DafeiyuI18n.h("/8 次")}${job.added!==undefined?` ${window.DafeiyuI18n.h("· 新增")} ${job.added} ${window.DafeiyuI18n.h("条，更新")} ${job.changed??0} ${window.DafeiyuI18n.h("条")}`:''}${job.usedHistoricalDevices?window.DafeiyuI18n.t(" · 使用历史设备范围"):''}</p>`:''}${schedule.error||job?.error?`<p role="status">${E(window.DafeiyuI18n.message(schedule.error??job.error))}</p>`:''}<div class="info-note">${window.DafeiyuI18n.h("Harness 打开时由插件按计划整理，关闭或卸载后自动调度暂停；错过多轮只补一次。手动整理可使用本机后台。每轮最多八次社区请求，不导入配置、不写入板载、不发送消息。")}${draft?window.DafeiyuI18n.t("当前计划有未保存修改。"):''}</div></section>`;
}
function overview() {
  const warning=state.data.knowledgeError;
  return communityTabs('overview') + learningControls() + (warning?`<div class="note-panel" role="status">${E(window.DafeiyuI18n.message(warning))}</div>`:'');
}
function empty(title, body) { return `<div class="empty full"><span>◇</span><strong>${E(title)}</strong>${E(body)}</div>`; }
function deviceOptions(selected=state.device) {
  const devices = state.data.inventory?.devices.filter(d => !['dock', 'other'].includes(d.family)) ?? [];
  return devices.map(d => `<option value="${E(d.model)}" ${d.model === selected ? 'selected' : ''}>${E(d.model)}</option>`).join('') || window.DafeiyuI18n.markup("<option value=\"\">请先读取设备</option>");
}
const libraryPageSize=6;
function searchConditions() {
  return {topic:state.query.trim(),device:state.device,category:state.category,fresh:state.fresh};
}
function visibleRecords() {
  if (state.librarySource==='community') {
    return state.resultKey===JSON.stringify(searchConditions()) ? (state.result?.candidates??[]) : [];
  }
  const query=state.query.trim().toLowerCase();
  const groups={mouse:[2001],keyboard:[1001],lights:[1002,1003],macros:[1004,2002],audio:[3001]};
  return state.data.records.filter(item=>(state.filter==='all'||groups[state.filter]?.includes(item.category))
    && (!query||[item.title,item.tags,item.author,item.device].join(' ').toLowerCase().includes(query)));
}
function libraryResults() {
  const I=window.DafeiyuI18n;
  const remote=state.librarySource==='community';
  if(remote && (state.pendingSearch || !state.result || state.resultKey!==JSON.stringify(searchConditions()))) {
    const hint=state.pendingSearch?'正在查找…':state.searchFeedback||'选择设备和类别后查询社区。';
    return `<p class="source-line" role="status">${E(I.message(hint))}</p>`;
  }
  const records=visibleRecords();
  const result=remote?state.result:null;
  if(result?.mode?.startsWith('needs-'))return `<p class="source-line" role="status">${E(I.message(result.note))}</p>`;
  const provenance=result?({'cache-first':'来自本机知识','cache-fallback':'社区暂不可用 · 历史资料'})[result.mode]??'刚从社区读取':'筛选已收录';
  const queryHint=result?.searchedKeywords?.length?I.h('检索词')+' · '+result.searchedKeywords.map(E).join('、'):'';
  return `<div class="result-caption"><span>${I.h(provenance)} · ${E(I.number(records.length))} ${I.h('条分享')}</span><span>${I.h('兼容性均待验证')}</span></div>
    ${queryHint?`<p class="source-line">${queryHint}${result.partial?' · '+I.h('仅返回部分结果'):''}</p>`:''}
    <div class="tiles">${records.slice(0,state.limit).map(card).join('')||empty(I.t('这里暂时没有匹配的资料'),'')}</div>
    ${records.length>state.limit?`<div class="section-header"><button class="button outline" data-action="more">${I.h('加载更多')}</button></div>`:''}`;
}
function library() {
  const I=window.DafeiyuI18n;
  const remote=state.librarySource==='community';
  const sourceChoice=(source,label)=>`<button type="button" class="button outline" data-action="library-source" data-source="${source}" aria-pressed="${state.librarySource===source}">${I.h(label)}</button>`;
  const filters=[['all','全部'],['mouse','鼠标配置'],['keyboard','键盘配置'],['lights','灯效'],['macros','宏'],['audio','音频 EQ']];
  const onlineControls=`<div class="search-controls"><label>${I.h('目标设备')} <select id="target-device">${deviceOptions()}</select></label><label>${I.h('社区类别')} <select id="search-category">${Object.entries(categories).map(([id,label])=>`<option value="${id}" ${state.category===id?'selected':''}>${E(label)}</option>`).join('')}</select></label><label><input type="checkbox" id="fresh" ${state.fresh?'checked':''}>${I.h('查询最新资料')}</label></div>`;
  return `${communityTabs('library')}<div class="toolbar">
    <div class="library-source">${sourceChoice('local','筛选已收录')}${sourceChoice('community','查询社区')}</div>
    <form id="search-form"><div class="search-row"><label class="visually-hidden" for="query">${I.h('查找游戏、用途或风格')}</label><input id="query" value="${E(state.query)}" placeholder="${I.h('查找游戏、用途或风格，如 CS、办公、暖色灯效')}" maxlength="100">${remote?`<button id="community-search" class="button" type="submit" ${state.pendingSearch?'disabled':''}>${I.h(state.pendingSearch?'正在查找…':'查询')}</button>`:''}</div>
    ${remote?onlineControls:''}</form></div>
    ${remote?'':`<div class="filter-row">${filters.map(([id,label])=>`<button data-filter="${id}" aria-pressed="${state.filter===id}" class="${state.filter===id?'active':''}">${I.h(label)}</button>`).join('')}</div>`}
    <div id="library-results">${libraryResults()}</div>`;
}
function devices() {
  const inventory = state.data.inventory, list = inventory?.devices ?? [];
  const statuses = window.DafeiyuI18n.live({ 'receiver-only': window.DafeiyuI18n.t("已发现接收器 · 设备未确认唤醒"), 'receiver-connected-device-asleep': window.DafeiyuI18n.t("接收器已连接 · 设备休眠"), 'listed-by-mhub': window.DafeiyuI18n.t("M HUB 设备列表已识别") });
  return `<div class="section-header"><div><h2>${window.DafeiyuI18n.h("设备状态")}</h2><p>${inventory ? `${inventory.stale ? window.DafeiyuI18n.t("上次记录") : window.DafeiyuI18n.t("最近读取")} · ${E(time(inventory.fetchedAt, true))}` : window.DafeiyuI18n.t("尚未读取 M HUB")}</p></div><button class="button outline" data-action="devices" ${state.busy.has('devices')?'disabled':''}>${state.busy.has('devices')?window.DafeiyuI18n.t("正在读取…"):window.DafeiyuI18n.t("↻ 刷新设备")}</button></div><div class="grid device-grid">${list.map(d=>`<article class="card device-card"><span class="device-symbol">${symbols[d.family]??'◇'}</span><div><h3>${E(d.model)}</h3><p>${E(familyNames[d.family]??window.DafeiyuI18n.t("外设"))}${d.battery !== null && typeof d.battery === 'number' ? ` ${window.DafeiyuI18n.h("· 电量")} ${d.battery}%` : ''}</p><span class="tag">${E(statuses[d.status]??window.DafeiyuI18n.t("状态待确认"))}</span></div></article>`).join('') || empty(window.DafeiyuI18n.t("暂时没有设备清单"),window.DafeiyuI18n.t("保持 M HUB 运行，然后点击“刷新设备”。"))}</div><div class="note-panel">${window.DafeiyuI18n.h("设备信息只从本机 M HUB 读取。接收器存在不等于设备已唤醒；M HUB 无法读取时会保留并标记历史清单。此处不会切换设备、修改灯光或改键。")}</div>`;
}
function diagnostics(data){
 const c=data.controls??{},sync=c.sync??{},voice=c.voice??{},qq=data.connections?.qq??{};
 const t=window.DafeiyuI18n;
 const voiceReady=voice.ready&&voice.streamReady!==false&&voice.nativeReady;
 const voiceStatus=voiceReady?'已就绪':voice.reachable?(voice.error||voice.nativeError?'需要修复':'正在准备'):c.voiceDesired===true?'需要修复':c.voiceDesired===false?'已关闭':'未启动';
 const rows=[
  ['设备联动',sync.ready?'已就绪':sync.reconnecting?'正在连接':'需要恢复',sync.ready?'':sync.connection?.error??sync.startup?.message??'等待联动'],
  ['音箱屏幕',!sync.ready?'等待联动':sync.screen?.ready||sync.screen?.captionsReady?'可用':sync.screen?'需要恢复':'状态未知',sync.screen?.error??''],
  ['语音聊天',voiceStatus,voice.error??voice.nativeError??(voice.reachable&&!voiceReady?voice.phase:'')],
  ['QQ · '+(qq.provider==='aurabot'?'AuraBot':qq.provider??'QQ'),qq.ready?'已连接':'等待连接',qq.detail],
 ];
 const renderRow=([name,status,reason])=>`<li class="service-row"><strong>${t.h(name)}</strong><span class="service-state">${t.h(status)}</span><span class="service-detail">${E(t.message(reason??''))}</span></li>`;
 return `<section class="card runtime-diagnostics"><h2>${t.h('服务状态')}</h2><ul class="service-list">${rows.map(renderRow).join('')}</ul><small>${t.h('最近读取')} · ${E(data.checkedAt?new Date(data.checkedAt).toLocaleString(t.locale):'—')}</small></section>`;
}
function operationTitle(row){
 const code=row.action.split(' · ')[1];
 if(!code||!['操作已受理','操作失败'].includes(row.action.split(' · ')[0]))return row.action;
 const labels={'plugin-restart':'重启插件','voice-start':'启动语音','voice-stop':'停止语音','voice-restart':'修复语音','sync-start':'恢复联动','sync-stop':'停止并恢复设备','balance-refresh':'立即刷新余额','pet':'摸摸大肥鱼','game-start':'开始游戏','game-stop':'退出游戏','game-replay':'重看本轮'};
 return labels[code]??'设备操作';
}
function activity() {
  const d=state.data;
  const t=window.DafeiyuI18n;
  const entries=(d.recent??[]).map(row=>{
    const duration=Number.isFinite(row.durationMs)?t.h('用时 {seconds} 秒',{seconds:t.number(row.durationMs/1000,{maximumFractionDigits:1})}):'';
    return `<li class="operation-row"><time>${E(time(row.at,true))}</time><strong>${E(t.message(operationTitle(row)))}</strong><div class="operation-result">${E(t.message(row.message))}${duration?`<small>${duration}</small>`:''}</div></li>`;
  });
  return diagnostics(d)+`<section class="card activity-history"><h2>${t.h('最近操作')}</h2>${entries.length?`<ol>${entries.join('')}</ol>`:`<p>${t.h('尚无操作记录')}</p>`}</section>`;
}
function playSmartisanMotion(element, keyframes, duration) {
  if (document.documentElement.dataset.theme !== 'smartisan' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches || !element?.animate) return;
  element.animate(keyframes, {duration, easing:'cubic-bezier(.22,.61,.36,1)', id:'smartisan-navigation'});
}
function render() {
  if(state.view==='language'){
    const content=$('#content'),same=content.dataset.route==='language';
    $('#page-title').textContent=window.DafeiyuI18n.t('语言');
    document.querySelectorAll('.sidebar nav a[data-view]').forEach(button=>{const selected=button.dataset.view==='control'&&button.dataset.panelTab==='home';button.classList.toggle('selected',selected);button.setAttribute('aria-current',selected?'page':'false');button.setAttribute('aria-label',button.querySelector('[data-i18n]')?.textContent??button.textContent);});
    if(!same||content.dataset.locale!==window.DafeiyuI18n.locale){content.innerHTML=window.DafeiyuLanguage?.renderPage()??'';}content.dataset.locale=window.DafeiyuI18n.locale;content.dataset.route='language';content.dataset.renderedView='language';
    if(!same)playSmartisanMotion(content,[{opacity:.55,translate:'56px 0'},{opacity:1,translate:'none'}],300);
    return;
  }
  if (!state.data) return;
  const titles = window.DafeiyuI18n.live({ setup:window.DafeiyuI18n.t('首次使用引导'),control:window.DafeiyuI18n.t("控制台"), overview: window.DafeiyuI18n.t("自动整理"), library: window.DafeiyuI18n.t("社区配置"), devices: window.DafeiyuI18n.t("我的设备"), activity: window.DafeiyuI18n.t("运行诊断") });
  const content = $('#content');
  // New sidebar destinations do not all render tab bars. The stored route is
  // authoritative; inspecting selected tabs misses home/bindings/speaker.
  const previousRoute = content.dataset.route;
  const tab=window.DafeiyuControls?.getTab();
  const currentRoute=state.view==='control'?'control/'+tab:state.view==='setup'?'setup/'+window.DafeiyuSetup.getStep(state.data):state.view;
  const sameRoute=content.dataset.route===currentRoute;
  const expanded=sameRoute?[...(content.querySelectorAll?.('details')??[])].map(detail=>detail.open):[];
  const focusable=()=>[...(content.querySelectorAll?.('button, summary, a[href], input, select, textarea')??[])];
  const focused=document.activeElement;
  const focusIndex=sameRoute?focusable().indexOf(focused):-1;
  const focusKey=element=>element&&[element.tagName,element.id,element.name,element.textContent,element.getAttribute('data-action'),element.getAttribute('data-command')].join('|');
  const key=focusIndex>=0?focusKey(focused):null;
  content.dataset.route=currentRoute;
  $('#page-title').textContent = state.view==='control'?(window.DafeiyuControls?.title()??titles.control):titles[state.view];
  document.querySelectorAll('.sidebar nav a[data-view]').forEach(button=>{
    const group=button.dataset.panelTab;
    const selected=state.view==='setup'&&group==='home'||(group?state.view==='control'&&(group===tab||
      group==='phone'&&['voice','tts','audio','captions'].includes(tab)||
      group==='states'&&['balance','notices','devices'].includes(tab)):button.dataset.view===state.view||button.dataset.view==='library'&&state.view==='overview');
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-current',selected?'page':'false');
  });
  const guide=state.view==='control'?(tab==='home'?window.DafeiyuSetup?.renderEntry(state.data):window.DafeiyuSetup?.renderReturn(state.data))??'':'';
  $('#content').innerHTML = guide+({ setup:()=>window.DafeiyuSetup.renderPage(state.data),control:()=>window.DafeiyuControls?.render(state,devices)??window.DafeiyuI18n.markup("<section class=\"card\"><h2>本机管理后台已就绪</h2><p>Harness 仍在缓存旧版后台，重启 Harness 后可在这里管理。现在可直接打开本机入口。</p><a class=\"button\" href=\"/api/mhub-community/panel\" target=\"_blank\" rel=\"noopener\">打开本机管理后台 ↗</a></section>"), overview, library, devices, activity })[state.view]() + (state.view==='control'&&tab==='home'?(window.DafeiyuLanguage?.renderEntry()??''):'');
  (content.querySelectorAll?.('details')??[]).forEach((detail,index)=>{if(expanded[index])detail.open=true;});
  if(key){
    const replacement=focusable()[focusIndex];
    if(focusKey(replacement)===key)replacement.focus({preventScroll:true});
  }
  content.dataset.renderedView = state.view;
  updateRecovery();
  if (previousRoute && !sameRoute) {
    for (const motion of content.getAnimations?.() ?? []) {
      if (motion.id === 'smartisan-navigation') motion.cancel();
    }
    if(previousRoute==='language'||previousRoute.startsWith('setup/')&&state.view==='control')playSmartisanMotion(content,[{opacity:.55,translate:'-56px 0'},{opacity:1,translate:'none'}],300);
    else if(state.view==='setup'&&!previousRoute.startsWith('setup/'))playSmartisanMotion(content,[{opacity:.55,translate:'56px 0'},{opacity:1,translate:'none'}],300);
    else playSmartisanMotion(content, [{opacity:.82,translate:'0 6px'}, {opacity:1,translate:'none'}], 250);
  }
}
function drawerWarnings(item) {
  const warnings = window.DafeiyuI18n.live([ ...(item.category === 2001 ? [window.DafeiyuI18n.t("这条整套配置会改动鼠标按键，可能覆盖后侧语音键与前侧快捷键。")] : []), ...(eligible(item,state.drawerDevice) ? [window.DafeiyuI18n.t("仅完成型号或类别筛选；设备能力、固件与动作内容仍需检查。")] : [window.DafeiyuI18n.t("此分享尚未确认适用于当前选择的设备。")]) ]);
  return warnings.map(E).join('<br>');
}
function updateDrawerResult(focusResult) {
  const container=$('#drawer-result');
  if(!container || !state.drawer)return;
  const button=$('#drawer-root [data-action="preview"]');
  if(button){
    button.disabled=state.previewPending;
    button.textContent=window.DafeiyuI18n.t(state.previewPending?'正在核对来源…':'生成建议');
  }
  const warnings=$('#drawer-warnings');
  if(warnings)warnings.innerHTML=drawerWarnings(state.drawer);
  const proposal=state.proposal;
  if(proposal){
    container.innerHTML=`<div class="proposal"><h3 tabindex="-1">${window.DafeiyuI18n.h('板载')} ${E(proposal.target.slot+1)} ${window.DafeiyuI18n.h('· 待审阅建议')}</h3>${window.DafeiyuI18n.h('来源已重新读取，当前仍是预览。')}<ol>${proposal.requirements.map(text=>`<li>${E(text)}</li>`).join('')}</ol><strong>${window.DafeiyuI18n.h('安装功能尚未开放，设备保持原样。')}</strong></div>`;
  }else if(state.previewError){
    container.innerHTML=`<p role="alert" tabindex="-1">${E(window.DafeiyuI18n.message(state.previewError))}</p>`;
  }else container.replaceChildren();
  if(focusResult){
    const result=container.querySelector('[tabindex]');
    result?.focus({preventScroll:true});
    result?.scrollIntoView({block:'nearest'});
  }
}
async function previewShare() {
  if(!state.drawer || state.previewPending)return;
  const conditions={shareCode:state.drawer.shareCode,device:state.drawerDevice,slot:state.slot};
  const attempt=++state.previewAttempt;
  state.previewPending=true;
  state.proposal=null;
  state.previewError='';
  updateDrawerResult(false);
  try{
    const proposal=await request('/preview',conditions);
    if(attempt!==state.previewAttempt || state.drawer?.shareCode!==conditions.shareCode)return;
    state.proposal=proposal;
    void refresh(false).catch(reportConnectionError);
  }catch(error){
    if(attempt===state.previewAttempt)state.previewError=error.message||'建议未能生成。';
  }finally{
    if(attempt===state.previewAttempt){state.previewPending=false;updateDrawerResult(true);}
  }
}
function renderDrawer() {
  const item = state.drawer;
  const root=$('#drawer-root');
  if(!item){state.previewPending=false;root.innerHTML='';document.body.style.overflow='';document.querySelector('main')?.removeAttribute?.('inert');document.querySelector('.sidebar')?.removeAttribute('inert');if(state.drawerOpener){const opener=state.drawerOpener.isConnected?state.drawerOpener:[...(document.querySelectorAll?.('[data-action="detail"]')??[])].find(e=>e.dataset.code===state.drawerOpener.dataset.code);opener?.focus({preventScroll:true});}state.drawerOpener=null;return;}
  const current=root.querySelector('.drawer');
  if(current?.dataset.code===item.shareCode && current.dataset.locale===window.DafeiyuI18n.locale)return;
  document.body.style.overflow='hidden';document.querySelector('main')?.setAttribute?.('inert','');document.querySelector('.sidebar')?.setAttribute('inert','');
  const facts = item.facts ?? {};
  const factItems = window.DafeiyuI18n.live([...(facts.dpi ?? []).map(v => `${v} DPI`), ...(facts.eqGains ?? []).map(v => `${v > 0 ? '+' : ''}${v} dB`), ...(facts.macroSteps !== undefined ? [`${window.DafeiyuI18n.phrase("macroSteps",facts.macroSteps??0)}`] : [])]);
  $('#drawer-root').innerHTML = `<div class="scrim" data-action="dismiss"><section class="drawer" data-code="${E(item.shareCode)}" data-locale="${E(window.DafeiyuI18n.locale)}" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="drawer-top"><span class="eyebrow">SHARE INSPECTOR</span><button class="icon-button" data-action="close" aria-label="${window.DafeiyuI18n.h("关闭分享详情")}">×</button></div><span class="tag">${E(labels[item.category])}</span><h2 id="detail-title">${E(item.title)}</h2><div class="source-line">${E(item.author)} · ${E(time(item.fetchedAt))}${window.DafeiyuI18n.h("读取")}</div><div class="detail-label">${window.DafeiyuI18n.h("分享标签")}</div><div class="facts">${String(item.tags || window.DafeiyuI18n.t("暂无标签")).split(',').map(t=>`<span class="fact">${E(t)}</span>`).join('')}</div><div class="detail-label">${window.DafeiyuI18n.h("设备与参数概况")}</div><div class="source-line">${E(item.device || window.DafeiyuI18n.t("社区未指定型号"))}</div><div class="facts">${factItems.map(t=>`<span class="fact">${E(t)}</span>`).join('') || window.DafeiyuI18n.markup("<span class=\"source-line\">当前摘要未包含可展示参数</span>")}</div><div class="detail-label">${window.DafeiyuI18n.h("应用前需要注意")}</div><div class="detail-warnings" id="drawer-warnings">${drawerWarnings(item)}</div><div class="detail-label">${window.DafeiyuI18n.h("原始分享码")}</div><div class="share-code"><code>${E(item.shareCode)}</code><button class="button ghost" data-action="copy">${window.DafeiyuI18n.h("复制")}</button></div><hr class="split-line"><div class="detail-label">${window.DafeiyuI18n.h("生成槽位预览")}</div><label class="source-line" for="preview-device">${window.DafeiyuI18n.h("目标设备")}</label><select id="preview-device">${deviceOptions(state.drawerDevice)}</select><div class="preview-controls"><select id="preview-slot" aria-label="${window.DafeiyuI18n.h("目标板载槽位")}">${[0,1,2].map(i=>`<option value="${i}" ${state.slot===i?'selected':''}>${window.DafeiyuI18n.h("板载")} ${i+1}</option>`).join('')}</select><button class="button" data-action="preview" ${state.busy.has('preview')?'disabled':''}>${state.busy.has('preview')?window.DafeiyuI18n.t("正在核对来源…"):window.DafeiyuI18n.t("生成建议")}</button></div><div class="info-note">${window.DafeiyuI18n.h("会先从社区核对这条分享的当前版本，再生成建议。此操作不会安装或写入设备。")}</div><div id="drawer-result" aria-live="polite"></div></section></div>`;
  updateDrawerResult(false);
}
async function perform(key, action, message) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  try { $('#notice').textContent = ''; render(); renderDrawer();const result = await action();const receipt=typeof message==='function'?message(result):message??result?.message;state.actionReceipt={key,at:Date.now(),message:receipt??''};if(receipt)toast(receipt);try { await refresh(); } catch(error) { $('#notice').textContent=window.DafeiyuI18n.t('操作已受理，状态暂未更新。'); scheduleRefresh(1000); return result; } if (state.drawer) state.drawer = state.data.records.find(r => r.shareCode === state.drawer.shareCode) ?? state.drawer; return result; }
  catch (error) { const detail=['TimeoutError','AbortError'].includes(error.name)?window.DafeiyuI18n.t("操作等待超时，可刷新后重试。"):error.message;if(error.code==='PANEL_OFFLINE'){reportConnectionError(error);scheduleRefresh(1000);}else $('#notice').textContent = window.DafeiyuI18n.message(detail); toast(detail); }
  finally { state.busy.delete(key);try{render();renderDrawer();}catch(error){$('#notice').textContent=window.DafeiyuI18n.t("页面刷新未完成，请重新加载后台。")+error.message;} }
}
function updateLibraryResults() {
  if ($('#library-results')) $('#library-results').innerHTML=libraryResults();
  const button=$('#community-search');
  if (button) {
    button.disabled=state.pendingSearch;
    button.textContent=window.DafeiyuI18n.t(state.pendingSearch?'正在查找…':'查询');
  }
}
function invalidateSearch() {
  if(state.librarySource==='community' && (state.resultKey || state.pendingSearch))state.searchFeedback='条件已变，请重新查询。';
  state.searchAttempt++;
  state.pendingSearch=false;
  state.result=null;
  state.resultKey='';
  state.limit=libraryPageSize;
  updateLibraryResults();
}
async function search(event) {
  event.preventDefault();
  if(state.librarySource!=='community')return;
  const conditions=searchConditions();
  if(!conditions.topic || !conditions.device){
    state.searchFeedback=!conditions.topic?'输入关键词后查询社区。':'请先读取并选择目标设备。';
    updateLibraryResults();
    return;
  }
  if(state.pendingSearch)return;
  const key=JSON.stringify(conditions);
  const attempt=++state.searchAttempt;
  state.pendingSearch=true;
  state.result=null;
  state.searchFeedback='';
  state.limit=libraryPageSize;
  updateLibraryResults();
  try {
    const result=await request('/search',conditions);
    if(attempt!==state.searchAttempt || state.librarySource!=='community' || key!==JSON.stringify(searchConditions()))return;
    state.result=result;
    state.resultKey=key;
    // Newly stored records also become available in the local library.
    void refresh(false).catch(reportConnectionError);
  } catch(error) {
    if(attempt===state.searchAttempt)state.searchFeedback=error.message||'查询失败，请重试。';
  } finally {
    if(attempt===state.searchAttempt){state.pendingSearch=false;updateLibraryResults();}
  }
}
document.addEventListener('submit', event => { if (event.target.id === 'search-form') void search(event); });
document.addEventListener('input', event => {
  window.DafeiyuControls?.edit(event,state);
  if (event.target.id === 'query') { state.query = event.target.value; invalidateSearch(); }
});
document.addEventListener('change', event => {
  if(event.target.dataset?.companion==='balance.source'){render();return;}
  if(['learning-enabled','learning-interval'].includes(event.target.id)){
    const schedule=state.data.schedule;if(!state.learningDraft)state.learningDraft={revision:schedule.revision,values:{enabled:schedule.enabled,intervalHours:schedule.intervalHours}};
    if(event.target.id==='learning-enabled')state.learningDraft.values.enabled=event.target.checked;else state.learningDraft.values.intervalHours=Number(event.target.value);render();return;
  }
  if (event.target.id === 'target-device') state.device = event.target.value;
  if (event.target.id === 'search-category') state.category = event.target.value;
  if (event.target.id === 'fresh') state.fresh = event.target.checked;
  if (['target-device','search-category','fresh'].includes(event.target.id))invalidateSearch();
  if (event.target.id==='preview-device')state.drawerDevice=event.target.value;
  if (event.target.id==='preview-slot')state.slot=Number(event.target.value);
  if(['preview-device','preview-slot'].includes(event.target.id)){state.previewAttempt++;state.previewPending=false;state.proposal=null;state.previewError='';updateDrawerResult(false);}
});
document.addEventListener('click', event => {
  if(window.DafeiyuControls?.shortcutClick?.(event))return;
  const button = event.target.closest('[data-view],[data-action],[data-filter]'); if (!button) return;
  if(button.tagName==='A'&&button.dataset.view&&button.hasAttribute('href'))return;
  if (button.dataset.view) { location.hash=button.dataset.view==='devices'?'control/devices':button.dataset.view+(button.dataset.panelTab?'/'+button.dataset.panelTab:''); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; state.limit = libraryPageSize; render(); return; }
  const action = button.dataset.action;
  if(window.DafeiyuSetup?.action(button,{data:state.data,render,navigate:route=>{location.hash=route;}}))return;
  if(action==='library-source'){
    if(button.dataset.source!==state.librarySource){state.librarySource=button.dataset.source;state.searchFeedback='';invalidateSearch();render();}
    return;
  }
  if(window.DafeiyuControls?.action(button,{perform,request,render,navigate:route=>{location.hash=route;}}))return;
  if (action === 'dismiss' && event.target !== button) return;
  if (['close','dismiss'].includes(action)) { state.drawer = null; renderDrawer(); }
  if(action==='refresh')void refresh().then(()=>toast(window.DafeiyuI18n.t('面板已刷新'))).catch(reportConnectionError);
  if(action==='plugin-restart')void perform('plugin-restart',()=>request('/controls/action',{action:'plugin-restart'}),value=>value.message??window.DafeiyuI18n.t('恢复任务已受理')); 
  if (action === 'devices') void perform('devices', () => request('/devices/refresh', {}), value => value.stale ? window.DafeiyuI18n.t("保留上次设备清单，当前未能实时读取") : `${window.DafeiyuI18n.h("已读取")} ${value.devices.length} ${window.DafeiyuI18n.h("个设备")}${value.cacheError?' · '+window.DafeiyuI18n.message(value.cacheError):''}`);
  if (action === 'learn') void perform('learn', () => request('/learning/run', {}), window.DafeiyuI18n.t("开始整理社区资料，可在社区整理计划中查看进度"));
  if(action==='learning-save'&&state.learningDraft)void perform('learning-settings',async()=>{const draft=state.learningDraft,submitted=JSON.stringify(draft);const result=await request('/learning/settings',{revision:draft.revision,values:draft.values});if(state.learningDraft===draft&&JSON.stringify(draft)===submitted)state.learningDraft=null;return result;},window.DafeiyuI18n.t("学习计划已保存"));
  if(action==='learning-reset'){state.learningDraft=null;render();}
  if (action === 'more') { state.limit += libraryPageSize; $('#library-results').innerHTML = libraryResults(); }
  if (action === 'detail') {
    state.drawerOpener=button;
    state.drawer=visibleRecords().find(r=>r.shareCode===button.dataset.code)??state.data.records.find(r=>r.shareCode===button.dataset.code);
    state.drawerDevice=state.device;
    state.previewAttempt++;state.previewPending=false;state.previewError='';
    state.proposal = null;
    renderDrawer();
    $('#drawer-root button[data-action="close"]')?.focus();
    playSmartisanMotion($('#drawer-root .drawer'), [{opacity:.72,translate:'24px 0'}, {opacity:1,translate:'none'}], 300);
  }
  if(action==='copy'){const fallback=()=>{const code=$('#drawer-root .share-code code');if(code){const selection=window.getSelection?.(),range=document.createRange?.();if(selection&&range){range.selectNodeContents(code);selection.removeAllRanges();selection.addRange(range);}}toast(window.DafeiyuI18n.t('复制失败，可选中分享码手动复制'));};if(navigator.clipboard?.writeText)void navigator.clipboard.writeText(state.drawer.shareCode).then(()=>toast(window.DafeiyuI18n.t('分享码已复制'))).catch(fallback);else fallback();}
  if(action==='preview')void previewShare();
});
document.addEventListener('keydown',event=>{
 if(!state.drawer)return;
 if(event.key==='Escape'){event.preventDefault();state.drawer=null;renderDrawer();return;}
 if(event.key!=='Tab')return;
 const controls=[...document.querySelectorAll('#drawer-root button:not(:disabled),#drawer-root select,#drawer-root a[href]')].filter(e=>e.getClientRects().length);
 const first=controls[0],last=controls.at(-1);
 if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
 else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleRefresh(0);});
window.addEventListener?.('online',()=>scheduleRefresh(0));
function readRoute(){
  const [view,tab]=(globalThis.location?.hash??'').slice(1).split('/');
  if(view==='settings'){globalThis.location.replace(tab==='language'?'#language':'#control/home');state.view=tab==='language'?'language':'control';window.DafeiyuControls?.setTab('home');render();return;}
  state.view=['overview','library','activity','language','setup'].includes(view)?view:'control';
  window.DafeiyuControls?.setTab(view==='devices'?'devices':tab);
  render();
}
window.addEventListener?.('hashchange',()=>{readRoute();window.scrollTo(0,0);});
window.addEventListener?.('dafeiyu:languagechange',()=>{window.DafeiyuI18n.localize();render();if(state.drawer)renderDrawer();if(state.data?.token)void request('/ui/preferences',{locale:window.DafeiyuI18n.locale}).catch(error=>toast(window.DafeiyuI18n.message(error.message)));});
window.DafeiyuControls?.setShortcutRequest?.(request);
readRoute();
void refresh().catch(reportConnectionError).finally(()=>scheduleRefresh(reconnecting?1000:5000));
