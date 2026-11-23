/* The author's complete Live2D controls share this project's services and themes. */
(() => {
 const E=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const I=()=>window.DafeiyuI18n??{t:s=>s};
 const T=(text,vars={})=>String(I().t(text,vars)).replace(/\{(\w+)\}/g,(all,key)=>Object.hasOwn(vars,key)?String(vars[key]):all),TE=(text,vars)=>E(T(text,vars)),M=text=>I().message?.(text)??T(text);
 // Translate only literal markup, never interpolated model or author content.
 const H=(parts,...values)=>parts.map((part,index)=>(I().markup?.(part)??part)+(index<values.length?values[index]:'')).join('');
 const N=value=>I().number?.(Number(value),{maximumFractionDigits:2})??String(value);
 const percent=value=>new Intl.NumberFormat(I().locale??'zh-CN',{style:'percent',maximumFractionDigits:0}).format(Number(value));
 const motionCount=(shown,total)=>I().phrase?T(I().phrase('live2dMotions',total),{shown:N(shown)}):T('{shown} / {count} 个动作',{shown:N(shown),count:N(total)});
 const trackCount=count=>I().phrase?.('live2dTracks',count)??T('{count} 条轨道',{count:N(count)});
 let view='desktop',query='',message='',cache={},drafts=new Map(),serial=0,motionExpanded=false;
 const views=[['desktop','桌宠与模型'],['look','形象与外观'],['input','语音输入'],['watch','电话与陪看'],['motions','动作与表情'],['settings','联动设置']];
 const definitions={
  settings:[['on','启用 Live2D 联动','checkbox'],['voice','桌宠朗读回复','checkbox'],['auto','按语义自动配动作','checkbox'],['autoFace','每句自动配表情','checkbox'],['scope','联动范围','select',[['private','仅主人私聊'],['both','私聊与群聊']]]],
  desktop:[['modelFile','Live2D 模型 model3.json','text'],['coreFile','Cubism Core JS','text'],['autoHideFullscreen','全屏时自动隐藏','checkbox']],
  size:[['scale','角色大小','range',.4,2.5,.05]],
  look:[['Clothes2','体型 · 0 默认 / 1 Q 版','range',0,1,.01],['Clothes1','裙长 · 0 长裙 / 1 短裙','range',0,1,.01],['Clothes3','胸口形态','range',0,1,.01],['Clothes4','鞋子透明度','range',0,1,.01],['Clothes5','尾巴显示程度','range',0,1,.01],['key10','大钢盆','checkbox'],['key11','黑框眼镜','checkbox'],['key12','单片眼镜','checkbox']],
  ear:[['on','启用原桌宠按键收音','checkbox'],['say','按住说话键','ear-key'],['sayShot','带屏幕说话键','ear-key'],['mic','麦克风名称（留空跟随当前配置）','text'],['minMs','最短录音 · 毫秒','number',150,2000,1]],
  talk:[['to','耳朵、电话与陪看共用的对话落点','select',[['system','后台对话 · 只回桌宠'],['qq','主人 QQ 私聊']]]],
  wake:[['on','启用离线唤醒词','checkbox'],['word','唤醒词 · 2–6 字','text'],['ackMode','唤醒回应','select',[['voice','台词'],['chime','提示音'],['off','不出声']]]],
  watch:[['displayId','陪看显示器 ID（留空使用主屏）','text'],['mode','陪看模式','select',[['auto','画面变化时回应'],['active','按随机间隔主动陪伴']]],['pace','画面交付节奏','select',[['calm','慢 · 30 秒'],['normal','中 · 15 秒'],['dense','快 · 8 秒']]],['listen','包含系统音频（不可用时仅画面）','checkbox'],['chatMin','主动开口最短间隔 · 秒','number',20,180,1],['chatMax','主动开口最长间隔 · 秒','number',20,180,1]],
  motion:[['name','动作名称 · 最多 10 字','text'],['when','何时使用','text'],['dur','时长 · 秒','number',.4,20,.1],['base','手型基底','select',[['','默认'],['举手','举手'],['竖手指','竖手指'],['狗尾草','狗尾草']]],['expr','表情（可留空）','text'],['tags','关键词 · 逗号分隔','text'],['tracks','参数轨迹 JSON','textarea']],
 };
 const groupRoutes={settings:'settings',desktop:'desktop-config',size:'size',look:'look',ear:'ear-config',talk:'talk-config',wake:'wake-config',watch:'watch-config',motion:'make-motion'};
 function data(s){const p=s?.data?.live2d??{},state=p.state??p.runtime??p;return {wrapper:p,state:Object.keys(state).length?state:cache.state??{},clips:p.clips??cache.clips??{clips:[]},settings:p.settings??cache.settings,revision:p.revision??cache.revision,desktop:p.desktop??p.desktopConfig??cache.desktop,companion:s?.data?.companion};}
 function initial(group,d){if(group==='settings')return d.settings?.values??d.settings??{};if(group==='desktop')return d.desktop?.values??{};if(group==='size')return {scale:d.state.scale??1};if(group==='motion')return {name:'',when:'',dur:2.4,base:'',expr:'',tags:'',tracks:'{\n  "d.AngleZ": [[0, 0], [0.25, 8], [0.75, -8], [1, 0]]\n}'};return d.state[group]??{};}
 function values(group,d){return drafts.get(group)?.values??initial(group,d);}
 function btn(label,action,extra={},disabled=false,primary=false,original=false){return H`<button type="button" class="button ${primary?'primary':'outline'}" data-action="live2d-${action}" ${original?'translate="no"':''} ${['view','fore'].includes(action)?`aria-pressed="${primary}"`:''} ${Object.entries(extra).map(([k,v])=>`data-${k}="${E(v)}"`).join(' ')} ${disabled?'disabled':''}>${original?E(label):TE(label)}</button>`;}
 function card(title,body,extra=''){return H`<section class="card live2d-card ${extra}"><h2>${E(I().t(title))}</h2>${body}</section>`;}
 function controls(group,d){const v=values(group,d);return definitions[group].map(([key,label,type,a,b,step])=>{
  const attrs=`data-live2d-group="${group}" data-live2d-field="${key}"`,val=v[key]??(type==='checkbox'?false:'');
  let input;if(type==='checkbox')input=H`<input type="checkbox" ${attrs} ${val?'checked':''}>`;
  else if(type==='select'||type==='ear-key'){const opts=type==='ear-key'?Object.entries(d.state.earLabels??{59:'F1',60:'F2',61:'F3',62:'F4',63:'F5',64:'F6',65:'F7',66:'F8',67:'F9',68:'F10',87:'F11',88:'F12',57:'空格',58:'CapsLock',41:'反引号'}):a;input=H`<select ${attrs}>${opts.map(([id,text])=>H`<option value="${E(id)}" ${String(id)===String(val)?'selected':''}>${TE(text)}</option>`).join('')}</select>`;}
  else if(type==='textarea')input=H`<textarea ${attrs} rows="8" spellcheck="false">${E(val)}</textarea>`;
  else input=H`<input ${attrs} type="${type}" value="${E(val)}" ${['range','number'].includes(type)?`min="${a}" max="${b}" step="${step}"`:''}>${type==='range'?H`<output data-live2d-output="${group}.${key}">${E(percent(val))}</output>`:''}`;
  return H`<label class="control-field live2d-field ${type==='checkbox'?'live2d-switch':''}"><span>${E(I().t(label))}</span><span class="live2d-input">${input}</span></label>`;
 }).join('');}
 function form(group,d,label='保存设置'){return controls(group,d)+H`<div class="control-buttons">${btn(label,'save',{group},false,true)}${btn('撤销修改','revert',{group},!drafts.has(group))}</div>`;}
 function status(d){const st=d.state,online=st.petOnline?.online===true;return H`<div class="live2d-health"><span class="small-dot ${online?'':'is-offline'}"></span><strong>${TE(online?'桌宠已连接':st.running?'桌宠已启动，等待连接':'桌宠未启动')}</strong><span>${st.pid?E('PID '+st.pid):TE('完整 Live2D 引擎')}</span></div>`;}
 function aiNotice(d){const c=d.companion;if(c?.config?.hasKey!==false||c?.task?.hostOnline!==false||!['auto','api','harness'].includes(c?.config?.values?.chat?.mode))return '';return H`<div class="note-panel live2d-ai-notice" role="status"><p>尚未配置独立 AI，且可选的 Harness 未在线；电话与陪看暂时无法生成回复。</p><a class="button outline" href="#control/voice">配置对话模型</a></div>`;}
 const desktopBusy=state=>!!state.call?.on||state.running!==false&&!!state.watch?.on;
 function desktop(d){const st=d.state,inst=st.install??{},missing=[];if(inst.shell===false)missing.push('桌宠运行代码未安装');if(inst.model===false)missing.push('尚未选择可用的 Live2D 模型');if(inst.electron===false)missing.push('Electron 运行环境未准备');const busy=desktopBusy(st);
  return card('桌宠运行',H`${status(d)}${aiNotice(d)}${missing.length?H`<div class="note-panel"><strong>需要准备</strong><ul>${missing.map(x=>H`<li>${TE(x)}</li>`).join('')}</ul></div>`:''}<div class="control-buttons">${btn('启动桌宠','launch',{},false,true)}${btn('显示桌宠','show',{},!st.running)}${btn('隐藏桌宠','hide',{},!st.running)}${btn('停止桌宠','stop',{},!st.running)}${btn('重新启动','restart',{},busy)}</div><p class="control-muted">桌宠运行在本项目内。语音条不主动弹出角色；电话显示角色，全屏隐藏按你的设置执行。</p><p class="control-muted">模型切换需要重启桌宠加载。通话或陪看开启时，请先结束，再重启。</p>`)
  +H`<div class="live2d-grid">${card('模型与显示',d.desktop?form('desktop',d,'保存模型设置'):H`<p>读取当前使用的模型、Core 和自动隐藏设置。</p>${btn('读取模型设置','load-desktop')}`)}${card('角色大小',form('size',d,'应用大小')+H`<p class="control-muted">支持 40%–250%，保存后下发给实际桌宠。</p><div class="control-buttons">${btn('复位到初始状态','reset',{},!st.petOnline?.online)}${btn('读取身体能力手册','manual')}</div>`)}</div>`;
 }
 function look(d){const fore=d.state.fore??'none',opts=Object.entries(d.state.foreLabels??{none:'无',planter:'花箱',snack:'点心',dinner:'家宴'});return card('常驻形象',H`<p class="control-muted">服装、道具、体型与动作分开保存。眼镜互斥由真实引擎校验。</p>${form('look',d,'应用形象')}`)+card('前景道具',H`<p class="control-muted">前景仅在相应取景模式显示。</p><div class="control-buttons">${opts.map(([id,label])=>btn(label,'fore',{value:id},false,id===fore)).join('')}</div>`);}
 function input(d){return H`<div class="live2d-grid">${card('原桌宠按住说话',H`<p class="control-muted">这是 Live2D 自带的键位入口。现有鼠标侧键和迈从快捷键继续使用原设置；避免为同一个按键开启两套录音。</p>${form('ear',d)}<p class="control-muted">“带屏幕说话”会附带你选择屏幕的画面。</p>`)}${card('离线叫醒词',H`<p class="control-muted">开启后会持续使用麦克风进行本地唤醒检测；不需要时关闭即可释放。首次集成默认关闭。</p>${form('wake',d)}`)}</div>${card('共用对话落点',form('talk',d)+H`<p class="control-muted">${TE('当前后台会话：{title}',{title:d.state.talkTitle??T('等待读取')})}</p><p class="control-muted">QQ 落点需要内部 QQ 网关已启用；原始消息与画面只按实际开启范围提交。</p>`)}`;}
 const errorText=error=>M(typeof error==='object'&&error?`${error.stage?error.stage+' · ':''}${error.message??error.name??'未知错误'}`:String(error??''));
 function watch(d){
  const st=d.state,w=st.watch??{},ws=st.watchStatus??{},capture=ws.capture??{};
  const offline=st.running===false||st.petOnline?.online===false;
  const phase=offline&&w.on?'offline':capture.phase??ws.phase??(w.on?'preparing':'stopped');
  const error=offline?null:capture.error??ws.error;
  const stamp=at=>at?(I().date?.(at,{hour:'2-digit',minute:'2-digit',second:'2-digit'})??new Date(at).toLocaleTimeString(I().locale??'zh-CN')):T('尚无');
  const upload=ws.upload,model=ws.modelError,speech=ws.speech;
  const uploadLabel=!upload||(!upload.at&&upload.ok==null)?'尚未提交画面':upload.visionUnsupported?'当前模型不支持看图':upload.ok===true?(upload.held?'已缓存最新画面':upload.withImage?'已提交图片':'未附带图片'):upload.ok===false?(upload.message||upload.name?errorText(upload):'提交失败'):'等待提交回报';
  const call=st.nativeCall,callLabel=call?({connecting:'电话正在连接',preparing:'电话正在准备',connected:'电话已接通',failed:'电话连接失败',ended:'电话已结束'})[call.phase]??String(call.phase):st.call?.on?'连续对话开关已开启':'电话未开启';
  const details=H`<dl class="live2d-status-details"><div><dt>最近有效画面</dt><dd>${E(stamp(capture.lastFrameAt))}${capture.width&&capture.height?` · ${E(capture.width)} × ${E(capture.height)}`:''}</dd></div><div><dt>画面提交</dt><dd>${TE(uploadLabel)}</dd></div><div><dt>语音播放</dt><dd>${TE(speech?(speech.ok?'最近播放已回报':errorText(speech)||speech.stage||'等待播放回报'):'等待回报')}</dd></div></dl>`;
  return H`<div class="live2d-grid">${card('电话',H`<p><strong>${TE(callLabel)}</strong></p>${aiNotice(d)}${call?.error?H`<p role="status">${E(errorText(call.error))}</p>`:''}${call?.speechError?H`<p role="status">语音播放 · ${E(errorText(call.speechError))}</p>`:''}<p class="control-muted">接通后无需按住说话。麦克风、合成和字幕继续使用本项目配置；此处开关不代表麦克风已就绪。</p><div class="control-buttons">${btn(st.call?.on?'挂断电话':'接通连续对话','call',{on:st.call?.on?'false':'true'},false,!st.call?.on)}<a class="button" href="#control/phone">主动来电与键盘接听设置</a></div>`)}${card('陪看',H`<p><strong>${TE(({preparing:'正在准备画面',running:'画面采集中',retrying:'画面重试中',failed:'画面采集失败',stopped:'陪看已停止',offline:'Live2D 未连接'})[phase]??phase)}</strong></p>${error?H`<p role="status">${E(errorText(error))}</p>`:''}${model?H`<p role="status">${E(errorText(model))}</p>`:''}${details}<div class="control-buttons">${btn(w.on?'结束陪看':'开启陪看','watch',{on:w.on?'false':'true'},false,!w.on)}${btn('重试画面','retry-watch',{},!w.on||offline)}</div><p class="control-muted">开启后才采集画面。电话期间保留最新画面，主动发言不会与通话抢话。</p>`)}</div>${card('陪看节奏',form('watch',d)+H`<p class="control-muted">自动模式按画面变化选择帧；主动模式按 20–180 秒区间安排。实际请求与模型费用随服务和内容变化。</p>`)}${card('停止采集',H`${btn('关闭全部收音与陪看','stop-capture')}<p class="control-muted">挂断电话，并关闭陪看、原按键收音和唤醒词；不会修改迈从快捷键。</p>`)}`;
 }
 const searchText=c=>[c.name,c.when,...(Array.isArray(c.tags)?c.tags:[c.tags??''])].join(' ').toLowerCase();
 function motions(d){const raw=Array.isArray(d.clips)?d.clips:d.clips?.clips??[],list=raw.filter(c=>searchText(c).includes(query.toLowerCase())),online=d.state.petOnline?.online===true;
  const items=raw.map(c=>H`<article class="live2d-motion" data-live2d-search="${E(searchText(c))}" ${searchText(c).includes(query.toLowerCase())?'':'hidden'}><h3 translate="no">${E(c.name)}</h3><p translate="no">${E(c.when??'')}</p><small>${TE('{seconds} 秒',{seconds:c.dur==null?'—':N(c.dur)})} · ${E(trackCount(Number(c.tracks)||0))}${c.expr?' · <span translate="no">'+E(c.expr)+'</span>':''}${c.born?' · '+TE('新动作'):''}</small><div class="control-buttons">${btn('静默预览','play',{name:c.name},!online)}${btn('载入编辑','edit-motion',{name:c.name})}</div></article>`).join('');
  const faces=cache.expressions?.expressions??cache.expressions?.faces??cache.expressions?.names??[];
  return card('动作库',H`<div class="live2d-library-tools"><label>搜索动作<input type="search" data-live2d-query value="${E(query)}" placeholder="名称、用途或关键词"></label><span data-live2d-count>${E(motionCount(list.length,raw.length))}</span>${btn('刷新动作库','clips')}${btn('复位到初始状态','reset',{},!online)}</div><p class="control-muted">预览只演动作，不朗读、不触发新的对话。动作库为真实文件，新动作保存后会出现在这里。</p><div class="live2d-motions">${items}<p data-live2d-empty ${list.length?'hidden':''}>没有匹配动作。可刷新动作库或清空关键词。</p></div>`)
  +card('表情',H`<div class="control-buttons">${btn('读取表情库','expressions')}${faces.map(c=>{const name=typeof c==='string'?c:c.name;return btn(name,'expression',{name},!online,false,true);}).join('')}</div><p class="control-muted">表情按模型实际能力读取，静默预览不生成语音。</p>`)
  +card('动作编辑',H`<details class="live2d-motion-editor" ${motionExpanded?'open':''}><summary>创建或修改动作</summary><p class="control-muted">载入已有动作后可以编辑。保存同名动作会更新库中的这一项，其他动作保留。轨道名使用 d.、p. 或 a. 前缀；关键帧时间为 0–1 的归一化进度，参数范围以身体能力手册为准。</p>${form('motion',d,'保存动作')}</details>`);
 }
 function settings(d){return card('回复与动作联动',form('settings',d)+H`<p class="control-muted">范围只控制已接入消息，实际 QQ 接收能力由当前通道决定。音色在“语音合成”中配置，桌宠不单独保存第二份 API Key。</p><a class="button" href="#control/tts">语音合成与音色</a>`)+card('能力手册与调试',H`<div class="control-buttons">${btn('读取完整能力手册','manual')}${btn('发送带动作标签的测试语句','test',{},!d.state.petOnline?.online)}</div><p class="control-muted">测试语句会按你已开启的朗读设置播放语音；动作库的静默预览可单独验证形体。</p>${cache.manual?H`<pre class="live2d-manual" translate="no">${E(cache.manual.manual??cache.manual)}</pre>`:''}`);}
 function render(s){const d=data(s),runtimeError=d.wrapper.error??d.state.error;return H`<div class="live2d-page"><section class="section-header"><div><h2>Live2D 桌宠</h2><p>原版桌宠、动作与表情、语音输入和陪看，统一在迈从大肥鱼中管理。</p></div>${btn('刷新桌宠','refresh')}</section>${runtimeError?H`<section class="note-panel" role="status">${E(M(runtimeError))}</section>`:''}<nav class="live2d-tabs" aria-label="Live2D 功能">${views.map(([id,label])=>btn(label,'view',{'live2d-view':id},false,id===view)).join('')}</nav><p class="live2d-feedback" role="status">${E(M(message))}</p>${({desktop,look,input,watch,motions,settings})[view](d)}</div>`;}
 function edit(event,s){const el=event.target;if(el.hasAttribute?.('data-live2d-query')||el.dataset?.live2dQuery!==undefined){query=el.value;const page=el.closest?.('.live2d-page'),items=Array.from(page?.querySelectorAll?.('[data-live2d-search]')??[]);let count=0;for(const item of items){item.hidden=!item.dataset.live2dSearch.includes(query.toLowerCase());if(!item.hidden)count++;}const counter=page?.querySelector?.('[data-live2d-count]'),empty=page?.querySelector?.('[data-live2d-empty]');if(counter)counter.textContent=motionCount(count,items.length);if(empty)empty.hidden=count>0;return true;}const group=el.dataset?.live2dGroup,key=el.dataset?.live2dField;if(!group||!key||!definitions[group]?.some(f=>f[0]===key))return false;const d=data(s);let entry=drafts.get(group);if(!entry){entry={values:structuredClone(initial(group,d)),revision:group==='settings'?d.settings?.revision??d.revision:group==='desktop'?d.desktop?.revision:null,serial:0};drafts.set(group,entry);}entry.serial=++serial;entry.values[key]=el.type==='checkbox'?el.checked:['number','range'].includes(el.type)||definitions[group].find(f=>f[0]===key)?.[2]==='ear-key'?Number(el.value):el.value;const output=el.parentElement?.querySelector?.('output');if(output)output.textContent=percent(el.value);return true;}
 async function fresh(request){const [state,clips,settings]=await Promise.all([request('/live2d/state'),request('/live2d/clips'),request('/live2d/settings')]);cache={...cache,state,clips,settings:settings.values,revision:settings.revision};return state;}
 function action(button,ctx,s){const key=button.dataset.action;if(!key?.startsWith('live2d-'))return false;const op=key.slice(7),d=data(s);if(op==='view'){view=views.some(([id])=>id===button.dataset.live2dView)?button.dataset.live2dView:'desktop';ctx.render();return true;}if(op==='revert'){drafts.delete(button.dataset.group);ctx.render();return true;}
  const group=button.dataset.group,entry=group?drafts.get(group):null,submitted=group?structuredClone(entry?.values??initial(group,d)):null,version=entry?.serial,submittedRevision=entry?.revision??(group==='desktop'?d.desktop?.revision:d.settings?.revision??d.revision);
  void ctx.perform('live2d-'+op,async()=>{let result;
   if(op==='refresh'){result=await fresh(ctx.request);message='桌宠状态与动作库已更新。';}
   else if(op==='load-desktop'){cache.desktop=await ctx.request('/live2d/desktop-config');message='已读取模型与显示设置。';}
   else if(op==='clips'){cache.clips=await ctx.request('/live2d/clips');message='动作库已更新。';}
   else if(op==='manual'){cache.manual=await ctx.request('/live2d/manual');view='settings';message='已读取身体能力手册。';}
   else if(op==='expressions'){cache.expressions=await ctx.request('/live2d/expressions');message='已读取模型表情。';}
   else if(op==='edit-motion'){const all=await ctx.request('/live2d/motions'),c=all.clips?.[button.dataset.name];if(!c)throw Error('动作已更新，请刷新动作库。');drafts.set('motion',{values:{...c,name:button.dataset.name,tags:(c.tags??[]).join(','),tracks:JSON.stringify(c.tracks??{},null,2)},serial:++serial});motionExpanded=true;message='已载入动作，可在下方编辑区修改。';}
   else if(op==='save'){
    if(!groupRoutes[group])throw Error('未知的 Live2D 设置分组。');let body=submitted;
    if(['settings','desktop'].includes(group))body={values:submitted,revision:submittedRevision};
    if(group==='motion'){try{body.tracks=JSON.parse(body.tracks);}catch{throw Error('轨迹 JSON 格式不正确。');}}
    result=await ctx.request('/live2d/'+groupRoutes[group],body);if(result?.ok===false)throw Error(result.message??'设置未应用。');
    if(drafts.get(group)===entry&&entry?.serial===version)drafts.delete(group);else if(drafts.get(group)&&result.revision&&drafts.get(group).revision===submittedRevision)drafts.get(group).revision=result.revision;
    if(group==='desktop')cache.desktop=result;if(group==='settings'){cache.settings=result.values??submitted;cache.revision=result.revision;}
    message=result.message??(group==='desktop'?'模型设置已保存，重启桌宠后加载。':'设置已应用。');
    if(group==='motion'){try{cache.clips=await ctx.request('/live2d/clips');}catch{message='动作已保存，列表暂未更新。请刷新动作库。';result={...result,message};}}
   }else if(['launch','show','hide','stop','restart','reset'].includes(op)){if(op==='restart'&&desktopBusy(d.state))throw Error('请先结束电话和陪看，再重启桌宠。');result=await ctx.request('/live2d/'+op,{});message=result.message??'操作已受理。';}
   else if(op==='fore')result=await ctx.request('/live2d/fore',{fore:button.dataset.value});
   else if(op==='play')result=await ctx.request('/live2d/play',{name:button.dataset.name});
   else if(op==='expression')result=await ctx.request('/live2d/expressions',{name:button.dataset.name});
   else if(op==='call')result=await ctx.request('/live2d/call-config',{on:button.dataset.on==='true'});
   else if(op==='watch')result=await ctx.request('/live2d/watch-config',{on:button.dataset.on==='true'});
   else if(op==='retry-watch')result=await ctx.request('/live2d/watch-config',{on:true});
   else if(op==='stop-capture'){const errors=[];for(const route of ['call-config','watch-config','ear-config','wake-config']){try{const stopped=await ctx.request('/live2d/'+route,{on:false});if(stopped.ok===false)throw Error(stopped.message??'关闭失败');}catch(error){errors.push(route+'：'+error.message);}}if(errors.length)throw Error('部分采集尚未关闭：'+errors.join('；'));message='电话、陪看、原按键收音和唤醒词已关闭。';}
   else if(op==='test')result=await ctx.request('/live2d/test',{text:T('大肥鱼在呢～')+'<body:挥手,爱心眼>'});
   else throw Error('未知 Live2D 操作。');
   if(result?.ok===false)throw Error(result.message??'Live2D 操作未完成。');if(result?.message)message=result.message;return {message:message||'操作已受理。'};
  });return true;
 }
 window.DafeiyuLive2d={render,edit,action};
})();
