(() => {
const E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let draft=null,draftRevision=null,secret='',qqToken='',imageKey='',models=[],message='',editVersion=0,balanceSources=[],sourceDraft=null,balanceMessage='',sourceSequence=0,sourceRetry=null;
const I=()=>window.DafeiyuI18n??{t:s=>s};
const T=(text,vars={})=>String(I().t(text,vars)).replace(/\{(\w+)\}/g,(all,key)=>Object.hasOwn(vars,key)?String(vars[key]):all),TE=text=>E(T(text)),M=text=>I().message?.(text)??T(text);
const H=(parts,...values)=>parts.map((part,index)=>(I().markup?.(part)??part)+(index<values.length?values[index]:'')).join('');
const phaseLabels={stopped:'已停止',starting:'正在启动',preparing:'正在准备',ready:'已就绪',failed:'失败',unavailable:'不可用',unprepared:'未准备',connecting:'正在连接',connected:'已连接',offline:'离线',waiting:'等待连接'};
const field=(label,key,value,type='text')=>H`<label class="control-field"><span>${TE(label)}</span><input data-companion="${key}" type="${type}" value="${E(value)}" ${type==='password'?'autocomplete="new-password"':''}></label>`;
function render(s){const runtime=s.data?.companion??{},cfg=draft??runtime?.config?.values;if(!cfg)return H`<section class="card">内部伙伴状态暂不可用：${E(M(runtime?.error??T('请刷新查看。')))}</section>`;const selected=cfg.chat.mode;return H`<section class="section-header"><div><h2>内部伙伴</h2><p>本项目直接提供对话、识别、余额、桌宠和 QQ 连接。外部插件均不再是启动前提。</p></div></section>
<div class="control-settings-grid companion-settings"><section class="card"><h3>AI 与账户</h3><label class="control-field"><span>对话通道</span><select data-companion="chat.mode"><option value="auto" ${selected==='auto'?'selected':''}>自动：已配置 API 优先，否则使用可选 Harness 接入</option><option value="api" ${selected==='api'?'selected':''}>独立 API（不需要 Harness）</option><option value="harness" ${selected==='harness'?'selected':''}>Harness 原生接入（仅需本项目）</option></select></label>${field('兼容 API 地址','chat.baseUrl',cfg.chat.baseUrl)}${field('API Key（留空保留已保存密钥）','apiKey',secret,'password')}<p class="control-muted">${TE(runtime.config?.hasKey===true?'已保存密钥，按服务地址绑定并使用 Windows 账户加密。':runtime.config?.hasKey===false?'尚未配置密钥。':'密钥状态暂不可用。')} DeepSeek 余额由内部接口查询，不读取外部插件数据。</p>${field('对话模型','chat.model',cfg.chat.model)}<div class="control-buttons"><button class="button" data-action="companion-models">读取模型列表</button><button class="button" data-action="companion-balance">刷新余额</button></div>${models.length?H`<select data-companion="chat.model"><option value="">选择模型</option>${models.map(m=>H`<option ${m.id===cfg.chat.model?'selected':''}>${E(m.id)}</option>`).join('')}</select>`:''}<label class="control-field"><span>当前模型支持看图</span><input type="checkbox" data-companion="chat.vision" ${cfg.chat.vision?'checked':''}></label><label class="control-field"><span>大肥鱼人设</span><textarea data-companion="chat.system" rows="3">${E(cfg.chat.system)}</textarea></label></section>
<section class="card"><h3>本地识别</h3>${field('ONNX 模型目录（model.onnx、tokens.txt）','asr.modelDir',cfg.asr.modelDir)}<label class="control-field"><span>模型类型</span><select data-companion="asr.tier">${['int8','fp32','paraformer'].map(t=>H`<option ${cfg.asr.tier===t?'selected':''}>${t}</option>`).join('')}</select></label><p class="control-muted">本地识别：${TE(phaseLabels[runtime.asrPhase]??runtime.asrPhase??'状态未知')} ${E(M(runtime.asrError??''))}<br>内置桌宠：${TE(runtime.online?'已连接':'未启动')}</p><div class="control-buttons"><button class="button" data-action="companion-prepare">加载识别</button><a class="button" href="#control/live2d">Live2D 桌宠</a></div><p class="control-muted">完整桌宠的形象、动作、电话和陪看请在 <a href="#control/live2d">Live2D 桌宠</a> 页面设置。语音条不会主动弹出桌宠；电话接通后显示。角色模型与 SDK 不随公开包分发。</p></section>
<section class="card"><h3>设备生图</h3><label class="control-field"><span>启用设备生图</span><input type="checkbox" data-companion="image.enabled" ${cfg.image.enabled?'checked':''}></label>${field('图片模型','image.model',cfg.image.model)}${field('OpenAI 图片 API Key（留空保留）','imageKey',imageKey,'password')}<p class="control-muted">${TE(runtime.config?.hasImageKey===true?'已保存独立生图密钥。':runtime.config?.hasImageKey===false?'尚未配置生图密钥。':'密钥状态暂不可用。')} 设备尺寸、像素风、主体大小、余额条隔离和导入校验继续使用本项目规则。实际模型和 GIF 权限取决于你的 API 项目。</p></section><section class="card"><h3>QQ 网关（可选）</h3><p class="control-muted">直接连接 OneBot v11 正向 WebSocket；无需 AuraBot。请勿同时让两个机器人服务处理同一账号。</p><label class="control-field"><span>启用内部 QQ 通道</span><input type="checkbox" data-companion="qq.enabled" ${cfg.qq.enabled?'checked':''}></label>${field('网关地址','qq.url',cfg.qq.url)}${field('主人 QQ','qq.owner',cfg.qq.owner)}${field('网关令牌（留空保留）','qqToken',qqToken,'password')}<p class="control-muted">状态：${TE(phaseLabels[runtime.qq?.phase]??runtime.qq?.phase??'状态未知')}。只接受主人私聊；板载覆盖仍须确认。</p></section></div><section class="card"><div class="control-buttons"><button class="button primary" data-action="companion-save">保存内部伙伴设置</button><button class="button" data-action="companion-revert">撤销修改</button></div><p role="status">${E(M(message))}</p></section>`;}
function renderBalanceSource(s){const c=s.data?.companion?.config?.values;if(!c)return '';const v=sourceDraft??c.balance??{source:'legacy',provider:''};return H`<section class="card"><h3>Harness 余额来源</h3><label class="control-field"><span>读取来源</span><select data-companion="balance.source">${v.source==='legacy'?'<option value="legacy" selected>'+TE('原有配置（兼容）')+'</option>':''}<option value="account" ${v.source==='account'?'selected':''}>${TE('Harness 当前登录账户')}</option><option value="api" ${v.source==='api'?'selected':''}>${TE('Harness 中的 DeepSeek API 来源')}</option></select></label>${v.source==='api'?'<label class="control-field"><span>'+TE('API 来源')+'</span><select data-companion="balance.provider"><option value="">'+TE('请选择来源')+'</option>'+balanceSources.filter(x=>x.provider).map(x=>'<option value="'+E(x.provider)+'" '+(v.provider===x.provider?'selected':'')+'>'+E(x.label)+'</option>').join('')+(!balanceSources.some(x=>x.provider===v.provider)&&v.provider?'<option selected value="'+E(v.provider)+'">'+E(v.provider)+'</option>':'')+'</select></label>':''}<p class="control-muted">余额只从选中的 Harness 来源读取，不自动切换账户。断网保留上次余额并标记；切换来源后重新读取。</p><div class="control-buttons"><button class="button" data-action="companion-balance-sources">读取 Harness 来源列表</button><button class="button primary" data-action="companion-balance-source-save">保存余额来源</button></div><p role="status">${E(M(balanceMessage))}</p></section>`;}
function balanceReceipt(value){
 const balanceUpdated=value?.status==='ready'&&!value.stale;
 return {saved:true,balanceUpdated,message:balanceUpdated?(value.cacheWarning?'设置已保存，余额已更新，缓存等待重试。':'设置已保存，余额已更新。'):'设置已保存，余额暂未更新，正在重试。'};
}
function retryBalanceRead(ctx,s,ticket,attempt=0){
 const timer=globalThis.setTimeout;if(attempt>=3||!timer)return;
 sourceRetry=timer(()=>{
  sourceRetry=null;if(ticket!==sourceSequence)return;
  ctx.perform('companion-balance-read-retry',async()=>{
   let value;try{value=await ctx.request('/companion/balance-refresh',{});}catch{}
   if(ticket!==sourceSequence)return {message:T('余额来源已改变，旧读取结果已忽略。')};
   const receipt=balanceReceipt(value);
   if(!receipt.balanceUpdated){if(attempt<2)retryBalanceRead(ctx,s,ticket,attempt+1);else receipt.message='设置已保存，余额暂未更新，请稍后重新读取。';}
   balanceMessage=receipt.message;ctx.render();return {...receipt,message:T(receipt.message)};
  });
 },[1000,3000,8000][attempt]);
}
async function saveBalanceSource(ctx,s){
 const config=s.data.companion.config,values=structuredClone(config.values),submitted=sourceDraft;
 values.balance=submitted??values.balance??{source:'account',provider:''};
 if(values.balance.source==='api'&&!values.balance.provider)throw Error(T('请选择来源'));
 const ticket=++sourceSequence;if(sourceRetry!==null)globalThis.clearTimeout?.(sourceRetry);sourceRetry=null;
 const saved=await ctx.request('/companion/settings',{values,revision:config.revision});
 // A committed revision is acknowledged even if the following read fails.
 s.data.companion.config={...config,...saved,values:saved.values??values,revision:saved.revision??config.revision};
 if(sourceDraft===submitted)sourceDraft=null;
 let value;try{value=await ctx.request('/companion/balance-refresh',{});}catch{}
 if(ticket!==sourceSequence)return {saved:true,message:T('余额来源已改变，旧读取结果已忽略。')};
 const receipt=balanceReceipt(value);balanceMessage=receipt.message;
 if(!receipt.balanceUpdated)retryBalanceRead(ctx,s,ticket);
 return {...receipt,message:T(receipt.message)};
}
function edit(event,s){const el=event.target,key=el.dataset.companion;if(!key)return false;if(key.startsWith('balance.')){sourceDraft??=structuredClone(s.data.companion.config.values.balance??{source:'legacy',provider:''});sourceDraft[key.split('.')[1]]=el.value;return true;}editVersion++;if(!draft){draft=structuredClone(s.data.companion.config.values);draftRevision=s.data.companion.config.revision;}if(key==='imageKey'){imageKey=el.value;return true;}if(key==='apiKey'){secret=el.value;return true;}if(key==='qqToken'){qqToken=el.value;return true;}const [group,name]=key.split('.');draft[group][name]=el.type==='checkbox'?el.checked:el.value;return true;}
function action(button,{perform,request,render},s){
 const key=button.dataset.action;if(!key?.startsWith('companion-'))return false;
 if(key==='companion-revert'){editVersion++;draft=null;draftRevision=null;secret='';qqToken='';imageKey='';message='';render();return true;}
 if(key==='companion-models'&&(secret||draft?.chat.baseUrl&&draft.chat.baseUrl!==s.data.companion.config.values.chat.baseUrl)){message='请先保存 API 地址和密钥，再读取模型列表。';render();return true;}
 const submitted={draft,version:editVersion,values:structuredClone(draft??s.data.companion.config.values),revision:draftRevision??s.data.companion.config.revision,secret,qqToken,imageKey};
 perform(key,async()=>{
  const route=key.slice(10);let result;
  if(route==='balance-sources'){result=await request('/companion/balance-sources',{});balanceSources=result.sources;return {message:T('已读取 Harness 来源列表。')};}
  if(route==='balance-source-save')return saveBalanceSource({perform,request,render},s);
  if(route==='save'){
   result=await request('/companion/settings',{values:submitted.values,revision:submitted.revision,...(submitted.secret?{apiKey:submitted.secret}:{}),...(submitted.qqToken?{qqToken:submitted.qqToken}:{}),...(submitted.imageKey?{imageKey:submitted.imageKey}:{})});
   if(draft===submitted.draft&&editVersion===submitted.version){draft=null;draftRevision=null;message='设置已保存。';}
   else if(draft===submitted.draft){draftRevision=result.revision;message='已保存上一版，当前更改待保存';}
   else if(draft&&draftRevision===submitted.revision){draftRevision=result.revision;message='已保存上一版，当前更改待保存';}
   else message='设置已保存。';
   if(secret===submitted.secret)secret='';if(qqToken===submitted.qqToken)qqToken='';if(imageKey===submitted.imageKey)imageKey='';
  }else if(route==='models'){result=await request('/companion/models',{});models=result.models;message='已读取模型列表。';}
  else if(route==='balance'){result=await request('/companion/balance-refresh',{});message=result.status==='ready'?result.balances.map(x=>x.total+' '+x.currency).join(' / '):result.message;}
  else if(route==='prepare'){result=await request('/companion/asr-prepare',{});message='正在准备识别，请查看上方实际状态。';}
  else{result=await request('/companion/pet',{action:route});if(route==='launch')await request('/companion/pet',{action:'show'});message=route==='hide'?'桌宠已隐藏。':'桌宠显示请求已受理。';}
  return {message:M(message)};
 });return true;
}
window.DafeiyuCompanion={render,renderBalanceSource,edit,action};
})();
