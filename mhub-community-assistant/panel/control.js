window.DafeiyuI18n??={t:s=>s,h:s=>s,markup:s=>s,live:s=>s,phrase:(id,n)=>n+" 台在线",number:(v,o={})=>Number(v).toFixed(o.maximumFractionDigits??0),relative:(v,u)=>String(v)+' '+u,locale:'zh-CN',message:s=>s,weather:s=>s,date:(v,o)=>new Intl.DateTimeFormat('zh-CN',o).format(new Date(v))};
(() => {
const shortcutDrafts={};let shortcutRecording=null,shortcutNotice='';
const drafts={},E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles=window.DafeiyuI18n.live({wallpaper:window.DafeiyuI18n.t('M HUB 壁纸'),live2d:'Live2D 桌宠',home:window.DafeiyuI18n.t("总览"),bindings:window.DafeiyuI18n.t("陪伴互动"),states:window.DafeiyuI18n.t("任务灯光"),notices:window.DafeiyuI18n.t("任务提示音"),devices:window.DafeiyuI18n.t("设备状态"),balance:window.DafeiyuI18n.t("余额灯带"),speaker:window.DafeiyuI18n.t("音箱屏幕"),phone:window.DafeiyuI18n.t("语音与电话"),voice:window.DafeiyuI18n.t("模型与识别"),tts:window.DafeiyuI18n.t("语音合成"),audio:window.DafeiyuI18n.t("麦克风与播放"),captions:window.DafeiyuI18n.t("语音字幕")});
let tab='home',balancePending=null;
let weatherQuery='',weatherResults=null,audioAdvanced=false,weatherNotice='';
let selectedLight='IDLE';
const expandedLights=new Set();
function speakerPreviews(s){
 const c=s.data.controls,meta=c.groups?.screenPages;
 const values=drafts.screenPages?.values??meta?.values;
 if(!meta?.available)return form(s,'screenPages',window.DafeiyuI18n.t("快捷页选择"));
 const r=c.runtime,clock=c.systemTime,view=c.balance?.view,config=c.weather;
 const weather=config?.enabled&&config.location&&r?.weather?.locationId===config.location.id?window.DafeiyuI18n.weather(r.weather.text):null;
 const clip=/^[a-z_]+$/.test(r?.resident??'')?r.resident:'idle';
 const fresh=Number.isFinite(r?.at)&&Date.now()-r.at>=0&&Date.now()-r.at<10000;
 const taskKey=r?.rawState==='IDLE'?'IDLE':['ERROR','ATTENTION','DISCONNECTED','WAITING'].includes(r?.rawState)?'ATTENTION':'BUSY';
 const taskLabel=!fresh?window.DafeiyuI18n.t("等待读取"):r.screenFeedback?.text??(r.rawState==='SUCCESS'?window.DafeiyuI18n.t("完成啦"):c.groups?.taskLights?.values?.[taskKey]?.label??window.DafeiyuI18n.t("待命中"));
 // These rows are rebuilt on every render. Keep live device/user text intact.
 const cards=[
  ['fish',window.DafeiyuI18n.t("大肥鱼动画"),window.DafeiyuI18n.t("轮换中的点阵动画"),''],
  ['status',window.DafeiyuI18n.t("任务状态"),window.DafeiyuI18n.t("随 Harness 任务更新"),taskLabel],
  ['balance',window.DafeiyuI18n.t("DeepSeek 余额"),window.DafeiyuI18n.t("显示最近一次有效余额"),Number.isFinite(view?.amount)?window.DafeiyuI18n.t("余额 ")+window.DafeiyuI18n.number(view.amount,{minimumFractionDigits:2,maximumFractionDigits:2})+window.DafeiyuI18n.t(" 元"):window.DafeiyuI18n.t("余额暂不可用")],
  ['clock',window.DafeiyuI18n.t("时间"),window.DafeiyuI18n.t("使用本机日期和时间"),[clock?.screenText??window.DafeiyuI18n.t("等待系统时间"),weather].filter(Boolean).join('  ')],
  ['affinity',window.DafeiyuI18n.t("好感度"),window.DafeiyuI18n.t("累计互动好感度"),window.DafeiyuI18n.t("♥ 好感度 ")+(r?.affinity??20)+'%'],
 ];
 const busy=s.busy.has('weather');
 const weatherControls=`<section class="weather-settings"><div class="control-section-heading"><h3>${window.DafeiyuI18n.h("时间页天气")}</h3><span class="tag">${config?.enabled?window.DafeiyuI18n.t("已开启"):window.DafeiyuI18n.t("已关闭")}</span></div>
 <p class="control-muted">${config?.location?E([config.location.name,config.location.region].filter(Boolean).join(' · ')):window.DafeiyuI18n.t("选择城市后立即开启天气。")}${weather?' · '+E(weather):config?.enabled?' · '+E(window.DafeiyuI18n.message(r?.weather?.error??window.DafeiyuI18n.t("等待读取天气"))):''}</p>
 <details><summary>${window.DafeiyuI18n.h("更改城市")}</summary><p class="control-muted">${window.DafeiyuI18n.h("选择后立即绑定")}</p><div class="search-row"><input id="screen-weather-query" type="search" maxlength="60" value="${E(weatherQuery)}" aria-label="${window.DafeiyuI18n.h("搜索天气城市")}" placeholder="${window.DafeiyuI18n.h("输入城市，例如深圳")}"><button class="button outline" type="button" data-action="control-weather-search" ${busy?'disabled':''}>${window.DafeiyuI18n.h("搜索城市")}</button>
 ${config?.location?`<button class="button outline" data-action="control-weather-toggle" data-enabled="${!config.enabled}" ${busy?'disabled':''}>${config.enabled?window.DafeiyuI18n.t("关闭天气"):window.DafeiyuI18n.t("开启天气")}</button>`:''}</div>
 ${weatherResults===null?'':weatherResults.length?`<ul class="weather-results">${weatherResults.map(row=>`<li><button class="button outline" data-action="control-weather-bind" data-id="${E(row.id)}" ${busy?'disabled':''}>${E(row.name)}${row.region?' · '+E(row.region):''}</button></li>`).join('')}</ul>`:window.DafeiyuI18n.markup("<p role=\"status\">没有找到城市，试试拼音或英文。</p>")}
 <p class="control-muted">${window.DafeiyuI18n.h("天气数据由")} <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> ${window.DafeiyuI18n.h("提供。")}</p></details>${weatherNotice?`<p role="status">${E(window.DafeiyuI18n.message(weatherNotice))}</p>`:''}</section>`;
 const rows=cards.map(([key,title,hint,value])=>{
  const row=field('screenPages',[key,title,'checkbox',hint+window.DafeiyuI18n.t(" · 加入实体键轮换")],values);
  let preview=E(value);
  if(key==='fish')preview=`<img src="screen-preview/${E(clip)}.gif" alt="${window.DafeiyuI18n.h("大肥鱼点阵动画")}">`;
  if(key==='clock')preview=`<div class="speaker-clock-layout">
    <div class="speaker-clock-date"><span>${E(clock?.at?window.DafeiyuI18n.date(clock.at,{year:'numeric',month:'2-digit',day:'2-digit'}):'—')}</span><span>${E(clock?.at?window.DafeiyuI18n.date(clock.at,{weekday:'short'}):'')}</span></div>
    <strong class="speaker-clock-time">${E(clock?.text??'--:--')}</strong>
    <div class="speaker-clock-weather">${config?.enabled&&config.location?`<span>${E(weather??window.DafeiyuI18n.t("天气暂不可用"))}</span><span title="${E(config.location.name)}">${E(config.location.name)}</span>`:''}</div>
  </div>`;
  return `<div class="speaker-preview-row">${row}<div class="speaker-preview-display" data-screen-preview="${key}" aria-label="${E(title)}${window.DafeiyuI18n.h("预览")}">${preview}</div>${r?.shortcutPage===key?window.DafeiyuI18n.markup("<small class=\"control-muted\">当前快捷页</small>"):''}${key==='clock'?weatherControls:''}</div>`;
 }).join('');
 const dirty=!!drafts.screenPages;
 return `<section class="card control-form speaker-preview-form"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("快捷页选择")}</h2><span class="tag ${dirty?'amber':''}">${dirty?window.DafeiyuI18n.t("有未保存修改"):window.DafeiyuI18n.t("保存立即应用")}</span></div><fieldset class="control-group">${rows}</fieldset>${footer(s,'screenPages',window.DafeiyuI18n.t('保存轮换页'))}</section>`;
}
const names=window.DafeiyuI18n.live({IDLE:window.DafeiyuI18n.t("待命"),THINKING:window.DafeiyuI18n.t("思考"),WORKING:window.DafeiyuI18n.t("执行工具／工作"),WAITING:window.DafeiyuI18n.t("等待确认"),SUCCESS:window.DafeiyuI18n.t("完成"),ERROR:window.DafeiyuI18n.t("出错"),DISCONNECTED:window.DafeiyuI18n.t("连接中"),BUSY:window.DafeiyuI18n.t("处理中"),ATTENTION:window.DafeiyuI18n.t("需要你")});
const mouseChoices=window.DafeiyuI18n.live([['pet',window.DafeiyuI18n.t("摸摸大肥鱼")],['game-toggle',window.DafeiyuI18n.t("开始／退出游戏")],['game-replay',window.DafeiyuI18n.t("重看本轮")],['fireworks-demo',window.DafeiyuI18n.t("通关烟花")],['screen-page-next',window.DafeiyuI18n.t("音箱下一页（避开固件切屏）")],['none',window.DafeiyuI18n.t("不触发动作")]]);
const schema=window.DafeiyuI18n.live({
voice:[['asrProvider',window.DafeiyuI18n.t("语音识别引擎"),'select',window.DafeiyuI18n.t("识别后发送给 Harness；切换后点击“保存并应用”。"),[['fish-buddy',window.DafeiyuI18n.t("鱼搭子 · SenseVoice / Paraformer")],['qwen3-asr',window.DafeiyuI18n.t("本地 Qwen3-ASR · 1.7B")],['doubao-ime',window.DafeiyuI18n.t("豆包输入法")]]],['asrContext',window.DafeiyuI18n.t("识别提示词"),'text',window.DafeiyuI18n.t("仅 Qwen3-ASR 使用，最多 500 字符。")],['holdMilliseconds',window.DafeiyuI18n.t("长按说话阈值 · 毫秒"),'number',window.DafeiyuI18n.t("短按功能在“陪伴互动”中设置。"),150,1500],['maxReplyCharacters',window.DafeiyuI18n.t("每轮最多朗读 · 字"),'number',window.DafeiyuI18n.t("完整长回复保留在 Harness。"),30,1000],['maxQueuedSentences',window.DafeiyuI18n.t("最多排队句数"),'number',window.DafeiyuI18n.t("避免长回复在后台堆积。"),1,16],['asrThreads',window.DafeiyuI18n.t("识别 CPU 线程"),'number',window.DafeiyuI18n.t("建议使用 2～4 个线程。"),1,8],['fishBuddyModel',window.DafeiyuI18n.t("本地识别档位"),'select',window.DafeiyuI18n.t("需要事先安装对应模型。"),[['int8',window.DafeiyuI18n.t("小档 · 228 MB")],['fp32',window.DafeiyuI18n.t("大档 · 894 MB")],['paraformer',window.DafeiyuI18n.t("最快档 · 78 MB")]]],['fishBuddyFollowSelection',window.DafeiyuI18n.t("跟随鱼搭子档位"),'checkbox',window.DafeiyuI18n.t("开启后优先使用鱼搭子设置中的选择。")]],
notifications:[['soundEnabled',window.DafeiyuI18n.t("状态提示音总开关"),'checkbox',window.DafeiyuI18n.t("只控制状态挂件，不影响正常回复和摸摸。")],['successSound',window.DafeiyuI18n.t("每轮完成播报"),'checkbox',window.DafeiyuI18n.t("开启后普通聊天也可能播放“搞定啦”，建议关闭。")],['errorSound',window.DafeiyuI18n.t("出错时提醒"),'checkbox',window.DafeiyuI18n.t("工具或任务出错时播放提醒。")],['approvalSound',window.DafeiyuI18n.t("等待审批时提醒"),'checkbox',window.DafeiyuI18n.t("需要你确认时播放提醒。")]],
balance:[['enabled',window.DafeiyuI18n.t("显示余额灯带（立即生效）"),'checkbox',window.DafeiyuI18n.t("启用后关闭 M HUB 常驻神光同步；在 M HUB 修改氛围灯后自动取消勾选。")],['fullAmount',window.DafeiyuI18n.t("满格代表金额 · 元"),'number',window.DafeiyuI18n.t("不能低于当前账户余额。"),1,10000,.01],['brightness',window.DafeiyuI18n.t("灯带亮度 · %"),'number',window.DafeiyuI18n.t("单独调节余额条亮度。"),1,100],['gt75Layout',window.DafeiyuI18n.t("GT75 显示方式"),'select',window.DafeiyuI18n.t("双侧同步时，每侧 10 颗各自显示完整比例，左右从相同方向增长。"),[['mirrored',window.DafeiyuI18n.t("双侧同步（每侧 10 颗）")],['continuous',window.DafeiyuI18n.t("连续进度（20 颗）")]]]],
bindings:[['pet',window.DafeiyuI18n.t("摸摸快捷键"),'text',window.DafeiyuI18n.t("例如 Ctrl+Alt+F9")],['gameToggle',window.DafeiyuI18n.t("开始／退出游戏"),'text',window.DafeiyuI18n.t("例如 Ctrl+Alt+G")],['gameReplay',window.DafeiyuI18n.t("重看当前一轮"),'text',window.DafeiyuI18n.t("仅游戏时使用。")],['color1',window.DafeiyuI18n.t("游戏答案 1 · 红"),'text',window.DafeiyuI18n.t("仅游戏时使用。")],['color2',window.DafeiyuI18n.t("游戏答案 2 · 黄"),'text',window.DafeiyuI18n.t("仅游戏时使用。")],['color3',window.DafeiyuI18n.t("游戏答案 3 · 蓝"),'text',window.DafeiyuI18n.t("仅游戏时使用。")],['color4',window.DafeiyuI18n.t("游戏答案 4 · 绿"),'text',window.DafeiyuI18n.t("仅游戏时使用。")],['mouseFrontAction',window.DafeiyuI18n.t("鼠标前侧键"),'select',window.DafeiyuI18n.t("沿用已安装的鼠标宏，改变它触发的功能。"),mouseChoices],['mouseRearAction',window.DafeiyuI18n.t("鼠标后侧键短按"),'select',window.DafeiyuI18n.t("语音就绪后可按住说话；未启动语音时使用短按宏。"),mouseChoices]],
screenCycle:Array.from({length:9},(_,i)=>['theme'+i,i===8?window.DafeiyuI18n.t("大肥鱼自定义动画"):window.DafeiyuI18n.t("内置主题 ")+(i+1),'checkbox',i===8?window.DafeiyuI18n.t("保留现有大肥鱼动画，不重新上传。"):window.DafeiyuI18n.t("由音箱固件提供，具体画面以实物为准。")]),
screenPages:[['fish',window.DafeiyuI18n.t("大肥鱼动画"),'checkbox',window.DafeiyuI18n.t("复用音箱已经安装的动画。")],['status',window.DafeiyuI18n.t("当前任务状态"),'checkbox',window.DafeiyuI18n.t("显示待命、处理中或需要你。")],['balance',window.DafeiyuI18n.t("DeepSeek 余额"),'checkbox',window.DafeiyuI18n.t("显示最近读取的人民币余额。")],['clock',window.DafeiyuI18n.t("时间"),'checkbox',window.DafeiyuI18n.t("系统日期、星期和时间，分组显示。")],['affinity',window.DafeiyuI18n.t("好感度"),'checkbox',window.DafeiyuI18n.t("红色爱心与累计好感度百分比。")]]});
const sections=window.DafeiyuI18n.live({
phone:[[window.DafeiyuI18n.t("手动通话与操作"),['enabled','hotkey','mouseHoldEnabled','mouseHoldMs','silenceMs','ringVolume']],[window.DafeiyuI18n.t("主动来电"),['autoEnabled','startTime','endTime','dailyLimit','minGapMinutes','onlyWhenIdle']],[window.DafeiyuI18n.t("未接电话"),['ringSeconds','retryCount','retryMinutes']],[window.DafeiyuI18n.t("键盘接听"),['deepAnswer','answerDepthMm']],[window.DafeiyuI18n.t('测试与调试'),['debugAnswerKey']]],
bindings:[[window.DafeiyuI18n.t("摸摸与陪伴"),['pet']],[window.DafeiyuI18n.t("颜色记忆游戏"),['gameToggle','gameReplay','color1','color2','color3','color4']],[window.DafeiyuI18n.t("鼠标侧键"),['mouseFrontAction','mouseRearAction']]],
voice:[[window.DafeiyuI18n.t("识别引擎与模型"),['asrProvider','fishBuddyModel','fishBuddyFollowSelection','asrThreads','asrContext']],[window.DafeiyuI18n.t("说话操作"),['holdMilliseconds']],[window.DafeiyuI18n.t("回复朗读"),['maxReplyCharacters','maxQueuedSentences']]],
balance:[[window.DafeiyuI18n.t("余额比例"),['enabled','fullAmount']],[window.DafeiyuI18n.t("灯带外观"),['gt75Layout','brightness']]],
notifications:[[window.DafeiyuI18n.t("任务提示音"),['soundEnabled','successSound','errorSound','approvalSound']]]});
schema.subtitles=[['captionMode',window.DafeiyuI18n.t("长字幕显示方式"),'select',window.DafeiyuI18n.t("滚动会从右向左显示；完整分页按语音进度换页。"),[['auto',window.DafeiyuI18n.t("自动：短句静态，长句左滚")],['scroll',window.DafeiyuI18n.t("始终向左滚动")],['pages',window.DafeiyuI18n.t("完整分页")]]],['captionFontSize',window.DafeiyuI18n.t("字幕字号"),'select',window.DafeiyuI18n.t("标准字号适合长字幕，大号字体会自动减少每页字数。"),[[0,window.DafeiyuI18n.t("标准")],[1,window.DafeiyuI18n.t("大号")]]]];
schema.phone=[['enabled',window.DafeiyuI18n.t("开启电话"),'checkbox',window.DafeiyuI18n.t("使用现有语音模型、音色和音频设备。")],['hotkey',window.DafeiyuI18n.t("拨号／挂断快捷键"),'text',window.DafeiyuI18n.t("默认 Ctrl+Alt+F8；来电时按下即可接听。")],['mouseHoldEnabled',window.DafeiyuI18n.t("长按鼠标滚轮拨号／挂断"),'checkbox',window.DafeiyuI18n.t("短按仍是普通中键；后侧键摸摸和前侧键游戏保持不变。")],['mouseHoldMs',window.DafeiyuI18n.t("滚轮长按阈值 · 毫秒"),'number',window.DafeiyuI18n.t("按住达到时间只触发一次，松开后才能再次触发。"),500,3000],['silenceMs',window.DafeiyuI18n.t("说完后等待 · 毫秒"),'number',window.DafeiyuI18n.t("停止说话多久发送这一轮，停顿多可适当增加。"),400,5000],['ringVolume',window.DafeiyuI18n.t("拨号与来电提示音 · %"),'number',window.DafeiyuI18n.t("使用你选中的声音播放设备，0 为静音。"),0,60],['autoEnabled',window.DafeiyuI18n.t("允许大肥鱼主动来电"),'checkbox',window.DafeiyuI18n.t("默认关闭；只在下方时段内拨打，次数包含未接重拨。")],['startTime',window.DafeiyuI18n.t("来电开始时间"),'time',window.DafeiyuI18n.t("跟随这台电脑的系统时间，支持跨午夜。")],['endTime',window.DafeiyuI18n.t("来电结束时间"),'time',window.DafeiyuI18n.t("时段以外不会主动来电或重拨。")],['dailyLimit',window.DafeiyuI18n.t("每天最多来电 · 次"),'number',window.DafeiyuI18n.t("包括未接重拨，拒接后不会立即重拨。"),1,20],['minGapMinutes',window.DafeiyuI18n.t("主动来电最短间隔 · 分钟"),'number',window.DafeiyuI18n.t("开启后先等待此间隔，再开始主动来电。"),5,1440],['onlyWhenIdle',window.DafeiyuI18n.t("只在 Harness 空闲时来电"),'checkbox',window.DafeiyuI18n.t("任务或游戏进行中先等待。")],['ringSeconds',window.DafeiyuI18n.t("无人接听等待 · 秒"),'number',window.DafeiyuI18n.t("超时自动挂断并恢复键盘设置。"),10,90],['retryCount',window.DafeiyuI18n.t("未接后最多重拨 · 次"),'number',window.DafeiyuI18n.t("只重拨无人接听的电话；主动拒接不会重拨。"),0,3],['retryMinutes',window.DafeiyuI18n.t("每次重拨间隔 · 分钟"),'number',window.DafeiyuI18n.t("仍然遵守来电时段和每天次数限制。"),1,120],['deepAnswer',window.DafeiyuI18n.t("接听键临时设为深按"),'checkbox',window.DafeiyuI18n.t("来电时随机选一个普通键，绿色呼吸并向外扩散涟漪；通话接通或来电结束后恢复。")],['answerDepthMm',window.DafeiyuI18n.t("接听按键行程 · mm"),'number',window.DafeiyuI18n.t("Ace 75 最深 4 mm，GT75 最深 3.4 mm。仅调整接听键的行程。"),1,4,.1]];
schema.phone.push(['debugAnswerKey',window.DafeiyuI18n.t('调试来电接听键'),'key-capture',window.DafeiyuI18n.t('点击输入框后直接按一个键，Escape 取消。仅用于来电测试，正常来电仍随机选键。')]);
function jump(tab,label) {return `<a class="control-inline-link" href="#control/${tab}">${window.DafeiyuI18n.h(label)}</a>`;}
function phone(s) {
 const c=s.data.controls,v=c.voice??{},p=v.phone??{},config=c.groups.phone.values;
 const I=window.DafeiyuI18n;
 const direct=c.voiceChannel==='live2d';
 const canCall=direct?v.streamReady:v.ready;
 const active=['dialing','incoming','connecting','connected'].includes(p.phase);
 const phase=({idle:I.t('等待拨号'),dialing:I.t('正在拨号'),incoming:I.t('大肥鱼来电'),connecting:I.t('正在准备语音'),connected:I.t('通话中'),ended:I.t('通话已结束')})[p.phase]??I.t('语音服务未启动');
 let actions;
 if(p.phase==='incoming')actions=button(s,'phone-accept',I.t('接听'),false,'')+button(s,'phone-reject',I.t('拒接'));
 else if(active)actions=button(s,'phone-hangup',I.t(p.phase==='connected'?'挂断':'取消通话'),false,'')+(p.phase==='connected'?button(s,'phone-mute',I.t(p.muted?'取消静音':'麦克风静音')):'');
 else if(!canCall)actions=v.reachable&&direct?I.h('等待 Live2D 语音识别就绪'):voiceStart(s,v);
 else actions=button(s,'phone-dial',I.t('拨给大肥鱼'),!config.enabled,'')+button(s,'phone-demo',I.t('指定键来电测试'),!config.enabled,'ghost');
 const audio=c.groups.audio?.values??{};
 const device=name=>!name||name==='__default__'?I.h('系统默认'):E(name);
 const error=p.error||v.phoneVoiceError||c.phoneInput?.error||v.channelError;
 const video=c.live2d??{};
 const watching=video.watch===true;
 const ws=video.watchStatus??{},capture=ws.capture??{};
 const captureFresh=capture.phase==='running'&&Date.now()-Number(capture.lastFrameAt||0)<15000;
 const watchLabel=!watching?'陪看已关闭':captureFresh?'画面采集正常':({preparing:'正在准备画面',retrying:'抓屏重试中',failed:'抓屏失败',stopped:'等待采集启动'}[capture.phase]||'等待采集状态');
 const watchErrors=[capture.error,ws.upload?.at>0&&ws.upload.ok===false&&!ws.upload?.held?ws.upload:null,ws.modelError,ws.speech?.ok===false?ws.speech:null].filter(Boolean);
 const watchCard=c.voiceChannel==='live2d'||c.live2d? `<section class="card">
 <div class="control-section-heading"><h2>${I.h('视频陪玩')}</h2><span class="tag">${I.h(video.online?watchLabel:'Live2D 未连接')}</span></div>
 <p>${I.h('让大肥鱼看这台电脑的屏幕、听系统声音。通话中开启陪玩，说话时可以一起聊画面。')}</p>
 <p>${captureFresh?`${E(capture.width)} × ${E(capture.height)} · ${I.h(capture.backend==='snapshot'?'纯画面采集':'视频流采集')} · ${I.h('最近有效帧')} ${E(Math.max(0,Math.round((Date.now()-capture.lastFrameAt)/1000)))} s`:''}${ws.upload?.held?I.h('最新画面已缓存，等待通话使用'):ws.upload?.withImage?I.h('图片已提交，等待模型回复'):''}${ws.lastReplyAt?` · ${I.h('最近模型回复')} ${E(new Date(ws.lastReplyAt).toLocaleTimeString())}`:''}</p>
 ${watchErrors.map(e=>`<p class="error">${E(e.stage||'watch')} · ${E(e.message||'')}</p>`).join('')}
 <div class="control-buttons">${button(s,'phone-video',I.t('拨出视频陪玩'),active||!direct||!canCall||!config.enabled,'')}${button(s,watching?'voice-watch-stop':'voice-watch-start',I.t(watching?'结束陪看':'只开陪看'),!watching&&!video.online)}${watching?button(s,'voice-watch-retry',I.t('重试画面采集'),!video.online):''}</div></section>`:'';
 return `<section class="card call-overview"><div class="control-section-heading"><h2>${E(phase)}</h2><span class="tag">${I.h('今日主动来电')} ${p.dailyCount??0} ${I.h('次')}</span></div>
 <div class="control-buttons">${actions}</div>
 <p>${p.phase==='incoming'?(p.keyboard?.ready?`${I.h('键盘绿色接听键：')}<strong>${E(p.keyboard.answerKey)}</strong> · ${I.h(p.keyboard.depthMm?'深按接听':'按下接听')}${p.keyboard.depthMm?` · ${E(p.keyboard.depthMm)} mm`:''}`:I.h(p.keyboard?.error?'键盘接听暂不可用，可点击接听':'正在准备键盘接听，也可点击接听')):`${I.h('拨号／挂断快捷键')} · ${E(p.controls?.hotkey??config.hotkey)}`}</p>
 ${direct?`<p>${I.h('通话显示在 Live2D 桌宠，语音由 BreezeBlue 合成。可右键桌宠挂断。')} ${jump('tts','语音合成')}</p>`:`<div class="call-audio"><p><strong>${I.h('麦克风')}</strong> ${device(audio.inputName)}</p><p><strong>${I.h('播放设备')}</strong> ${device(audio.outputName)}</p></div><nav class="call-links">${jump('audio','麦克风与播放')} ${jump('voice','模型与识别')} ${jump('tts','语音合成')}</nav>`}
 ${error?`<p role="status">${E(I.message(error))}</p>`:''}</section>
 ${watchCard}
 ${form(s,'phone',I.t('电话设置'))}
 <details class="control-details"><summary>${I.h('通话说明')}</summary>${direct?`<p>${I.h('拨号会自动打开 Live2D 桌宠，等麦克风就绪后直接接通。')}</p>`:`<p>${I.h('你拨出立即弹窗；她来电先响铃，接听后再弹窗。开场语音准备好才显示接通，音箱同步字幕。')}</p><p>${I.h('连续听话基于')} <a href="https://github.com/Yuuyuko-uu/dsh-fish-buddy" target="_blank" rel="noopener">${I.h('鱼搭子 · Yuuyuko-uu')}</a>${I.h('，接入现有 Harness 会话、音色与设备联动。当前采用自动轮流说话；连续通话需选择鱼搭子或 Qwen 本地识别，豆包输入法需按键确认，暂不支持免按通话。')}</p>`}</details>`;
}
function phoneFieldVisible(key,values) {
 if(['startTime','endTime','dailyLimit','minGapMinutes','onlyWhenIdle','retryCount','retryMinutes','ringSeconds'].includes(key)&&!values.autoEnabled)return false;
 if(key==='retryMinutes')return values.retryCount>0;
 if(key==='mouseHoldMs')return values.mouseHoldEnabled;
 if(key==='answerDepthMm')return values.deepAnswer;
 return true;
}
function updatePhoneGroups(form,values){
 for(const item of form.querySelectorAll('[data-phone-field]')){
   const shown=phoneFieldVisible(item.dataset.phoneField,values);
   item.hidden=!shown;
   item.querySelector('input,select,textarea').disabled=!shown;
 }
 for(const set of form.querySelectorAll('[data-phone-set]')){
   set.hidden=!set.querySelector('[data-phone-field]:not([hidden])');
 }
}
function field(group,row,values){const [key,label,type,help,min,max,step]=row,id='ctl-'+group+'-'+key,v=values[key],hidePhone=group==='phone'&&!phoneFieldVisible(key,values),attrs=`id="${id}" name="${key}" data-control-group="${group}" ${hidePhone?'disabled':''}`;let input;
if(type==='checkbox')input=`<input ${attrs} type="checkbox" ${v?'checked':''} ${group==='balance'&&key==='enabled'?`data-action="control-balance-toggle" ${balancePending!==null?'disabled':''}`:''}>`;
else if(type==='key-capture')input=`<input ${attrs} type="text" readonly data-debug-key-input value="${E(v??'F11')}" aria-label="${E(label)}" title="${window.DafeiyuI18n.h('点击后按键设定')}" ${['incoming','dialing','connecting','connected'].includes(lastState?.data?.controls?.voice?.phone?.phase)?'disabled':''}>`;
else if(key==='asrContext')input=`<textarea ${attrs} maxlength="500">${E(v)}</textarea>`;
else if(type==='select')input=`<select ${attrs}>${min.map(([value,name])=>`<option value="${value}" ${value===v?'selected':''}>${name}</option>`).join('')}</select>`;
else input=`<input ${attrs} type="${type}" value="${E(v)}" ${type==='number'?`required min="${min}" max="${max}" step="${step??1}"`:`${key==='asrContext'?'':'required'} maxlength="${key==='asrContext'?500:100}"`}>`;
return `<label class="control-field" for="${id}" ${group==='phone'?`data-phone-field="${key}" ${hidePhone?'hidden':''}`:'' }><span><strong>${label}</strong><small>${help}</small></span>${input}</label>${group==='voice'&&key==='holdMilliseconds'?jump('bindings','陪伴互动'):''}`;}
function button(s,cmd,label,off=false,style='outline'){const controls=s.data.controls,sync=controls?.sync,waiting=sync?.running&&sync.ready===false&&!/^(voice-|audio-|phone-)/.test(cmd)&&!['sync-start','sync-stop'].includes(cmd);const paused=controls?.deviceLink?.enabled===false&&!['voice-stop','voice-interrupt','voice-watch-stop','phone-hangup','phone-reject'].includes(cmd);return `<button class="button ${style}" data-action="control-run" data-command="${cmd}" ${off||paused||waiting||s.busy.has('control-run-'+cmd)?'disabled':''}>${label}</button>`;}
function deviceLinkSwitch(s){
 const I=window.DafeiyuI18n,link=s.data.controls.deviceLink??{enabled:true},busy=s.busy.has('device-link');
 return `<section class="card control-link-switch"><div><h2 id="device-link-label">${I.h('设备联动总开关')}</h2><p class="control-muted" role="status">${I.h(link.releasing?'正在释放设备控制…':link.enabled?'关闭后，可直接在 M HUB 设置设备。':'设备由 M HUB 管理。')}</p>${link.issues?.length?`<ul class="recovery-errors">${link.issues.map(message=>`<li>${E(I.message(message))}</li>`).join('')}</ul>`:''}</div><button class="button ${link.enabled?'':'outline'}" type="button" role="switch" aria-checked="${link.enabled}" aria-labelledby="device-link-label" data-action="control-link-toggle" data-command="${link.enabled?'device-link-off':'device-link-on'}" ${busy||link.releasing?'disabled':''}>${I.h(link.enabled?'已开启':'已关闭')}</button></section>`;
}
let chooseVoiceRepair=false;
function voiceStart(s,v) {
 const I=window.DafeiyuI18n;
 if(chooseVoiceRepair&&drafts.voice){
   return `<div class="voice-repair-choice" role="group" aria-label="${I.h('有未保存修改')}"><small>${I.h('有未保存的识别设置。')}</small><button class="button" data-action="control-repair-saved">${I.h('按已保存设置修复')}</button><button class="button outline" data-action="control-repair-edit">${I.h('返回编辑')}</button></div>`;
 }
 const healthy=v.reachable&&v.ready&&v.streamReady&&v.nativeReady&&v.mouseBindingReady!==false;
 const preparing=v.reachable&&!v.ready&&!v.error&&!v.nativeError&&/加载|准备|修复|starting|loading/i.test(v.phase??'');
 if(preparing)return `<span class="control-muted" role="status">${E(I.message(v.phase))}</span>`;
 return button(s,v.reachable&&!healthy?'voice-restart':'voice-start',I.t(v.reachable&&!healthy?'修复语音':'启动语音'),healthy);
}
function form(s,group,title){
const meta=s.data.controls.groups[group];if(!meta?.available)return `<section class="card control-form"><h2>${title}</h2><p>${E(window.DafeiyuI18n.message(meta?.error??window.DafeiyuI18n.t("功能尚未就绪")))}</p></section>`;
if(group==='balance')rebaseBalance(meta);const dirty=!!drafts[group],values={...(drafts[group]?.values??meta.values),...(group==='balance'?{enabled:balancePending??meta.values.enabled}:{})};
const rowHtml=row=>{if(group==='voice'&&s.data.controls.voiceChannel==='live2d'&&!['holdMilliseconds','maxReplyCharacters','maxQueuedSentences'].includes(row[0]))return '';if(group==='balance'&&row[0]==='gt75Layout'&&balanceAvailability(s.data.controls)?.model!=='GT 75')return '';if(group==='balance'&&row[0]==='fullAmount'){const balance=s.data.controls.balance;const amount=balance?.live===false?null:balance?.view?.amount;if(Number.isFinite(amount))row=[...row.slice(0,4),Math.max(1,Math.ceil(amount*100)/100),...row.slice(5)];}return field(group,row,values);};
const advancedKeys=group==='voice'?new Set(['asrThreads','asrContext','maxQueuedSentences','holdMilliseconds']):group==='phone'?new Set(['mouseHoldMs','silenceMs','answerDepthMm']):new Set();
const advanced=schema[group].filter(row=>advancedKeys.has(row[0])).map(rowHtml).join('');
const groups=sections[group]??[[null,schema[group].map(row=>row[0])]];
const fields=groups.map(([name,keys])=>{
 const rows=keys.filter(key=>!advancedKeys.has(key)).map(key=>schema[group].find(row=>row[0]===key)).filter(Boolean).map(rowHtml).join('');
 const phoneSet=group==='phone'?`data-phone-set ${keys.some(key=>!advancedKeys.has(key)&&phoneFieldVisible(key,values))?'':'hidden'}`:'';
 return rows?`<fieldset class="control-group" ${phoneSet}>${name?`<legend>${name}</legend>`:''}${rows}</fieldset>`:'';
}).join('');
return `<section class="card control-form"><div class="control-section-heading"><h2>${title}</h2><span class="tag ${dirty?'amber':''}">${dirty?window.DafeiyuI18n.t("有未保存修改"):group==='voice'?window.DafeiyuI18n.t("应用语音后生效"):window.DafeiyuI18n.t("保存立即应用")}</span></div>${fields}${advanced?`<details class="control-details"><summary>${window.DafeiyuI18n.h("高级设置")}</summary>${advanced}</details>`:''}<div class="control-form-footer"><button class="button" data-action="control-save" data-group="${group}" ${!dirty||s.busy.has('control-save-'+group)?'disabled':''}>${['voice','balance'].includes(group)?window.DafeiyuI18n.t("保存并应用"):window.DafeiyuI18n.t("保存参数")}</button><button class="button ghost" data-action="control-reset" data-group="${group}" ${!dirty?'disabled':''}>${window.DafeiyuI18n.h("撤销修改")}</button>${group==='voice'&&!dirty?button(s,'voice-restart',window.DafeiyuI18n.t("重新应用已保存设置")):''}</div>${group==='voice'?window.DafeiyuI18n.markup("<p class=\"control-muted\">保存并应用会重新加载语音服务。麦克风、播放设备和字幕分别在上方子页设置。</p>"):''}</section>`;}
function health(title,status,detail,ready,action=''){const text=({running:window.DafeiyuI18n.t("运行中"),ready:window.DafeiyuI18n.t("已就绪"),idle:window.DafeiyuI18n.t("待命中"),listening:window.DafeiyuI18n.t("正在听你说"),thinking:window.DafeiyuI18n.t("思考中"),speaking:window.DafeiyuI18n.t("正在回复"),loading:window.DafeiyuI18n.t("加载中")})[status]??status;return `<article class="card control-health"><span class="control-dot ${ready?'is-ready':''}"></span><div><span>${title}</span><strong>${E(text)}</strong><small>${E(detail==='running'?window.DafeiyuI18n.t("设备状态同步中"):window.DafeiyuI18n.message(detail??''))}</small>${action?`<div class="control-buttons">${action}</div>`:''}</div></article>`;}
function gameActions(s,game,sync){
 const I=window.DafeiyuI18n;
 const inputUnavailable=game?.phase==='unavailable'||game?.lastResult==='shortcut-unavailable';
 if(!game?.active){
   const runtime=s.data.controls.runtime;
   const taskBusy=runtime?.rawState&&runtime.rawState!=='IDLE';
   const hint=!sync.ready?I.h('等待设备联动就绪后即可开始游戏。'):taskBusy?I.h('Harness 待命后即可开始游戏。'):inputUnavailable?I.h('上次未连接到游戏窗口或作答快捷键。请重新开始游戏。'):'';
   return button(s,'game-start',I.t('开始游戏'),!sync.ready||taskBusy)+(hint?`<small class="control-game-hint" role="status">${hint}</small>`:'');
 }
 const replay=['arming','intro','unavailable','celebration','round-win'].includes(game.phase)?'':button(s,'game-replay',I.t('重看本轮'),!sync.ready);
 return replay+button(s,'game-stop',I.t('退出游戏'),!sync.ready,'ghost')+(inputUnavailable?`<small class="control-game-hint" role="status">${I.h('游戏输入未就绪，请重新打开游戏')}</small>`:'');
}
function home(s){const c=s.data.controls,v=c.voice??{},r=c.sync??{},screenFailed=r.ready&&r.screen?.ready===false&&r.screen?.captionsReady===false;
return `<div class="control-health-grid">${health(window.DafeiyuI18n.t("语音聊天"),v.reachable?v.ready?(v.mouseBindingReady===false?window.DafeiyuI18n.t("后侧键待恢复"):v.nativeReady?window.DafeiyuI18n.t(v.streamReady?"可以说话":"等待 Harness 文字流"):v.nativeError?window.DafeiyuI18n.t("等待鼠标连接"):window.DafeiyuI18n.t("输入设备未就绪")):v.phase??window.DafeiyuI18n.t("准备中"):window.DafeiyuI18n.t(c.voiceDesired===true?"需要修复":c.voiceDesired===false?"已关闭":"未启动"),v.error??v.mouseBindingError??(v.nativeError?(v.nativeError.includes('asleep')?window.DafeiyuI18n.t("鼠标休眠，轻动鼠标可自动重连"):v.nativeError.split('\n')[0]):null)??(v.tts?.name??(v.ttsProvider==='breezeblue'?window.DafeiyuI18n.t("BreezeBlue 云端音色"):window.DafeiyuI18n.t("本地语音服务"))),v.ready&&v.nativeReady&&v.streamReady&&v.mouseBindingReady!==false,v.ready&&v.nativeReady&&v.streamReady&&v.mouseBindingReady!==false?'':voiceStart(s,v))}${health(window.DafeiyuI18n.t("设备联动"),!r.running?window.DafeiyuI18n.t("未启动"):r.reconnecting||r.ready!==true?window.DafeiyuI18n.t("正在连接"):window.DafeiyuI18n.t(screenFailed?"部分可用":"联动已就绪"),screenFailed?window.DafeiyuI18n.message(r.screen.error??"音箱屏幕未就绪，其他设备可继续使用"):r.running?r.phase:window.DafeiyuI18n.t("启动后可控制屏幕、灯光和互动"),r.running&&r.ready===true&&!r.reconnecting&&!screenFailed)}${health(s.data.connections.qq.provider==='aurabot'?'QQ · Aurabot':window.DafeiyuI18n.t("QQ 接收服务"),s.data.connections.qq.ready?window.DafeiyuI18n.t("已连接"):s.data.connections.qq.reachable?window.DafeiyuI18n.t("服务可访问"):window.DafeiyuI18n.t("暂不可访问"),s.data.connections.qq.detail??window.DafeiyuI18n.t("登录状态未知"),s.data.connections.qq.ready===true)}</div>
<section class="card control-play"><div><h2>${window.DafeiyuI18n.h("陪她玩一会儿")}</h2><p class="control-muted">${window.DafeiyuI18n.h("手动演示会播放声音和灯光，忙碌时由联动程序安排。")}</p></div><div class="control-play-groups"><div><strong>${window.DafeiyuI18n.h("陪伴")}</strong><div class="control-buttons">${button(s,'pet',window.DafeiyuI18n.t("摸摸大肥鱼"),!r.running)}${button(s,'beg-demo',window.DafeiyuI18n.t('测试主动求摸摸'),!r.ready||c.game?.active||c.runtime?.displayState&&c.runtime.displayState!=='IDLE','ghost')}</div></div><div><strong>${window.DafeiyuI18n.h("颜色记忆游戏")}</strong><div class="control-buttons">${gameActions(s,c.game,r)}</div></div><div><strong>${window.DafeiyuI18n.h("奖励演示")}</strong><div class="control-buttons">${button(s,'fireworks-demo',window.DafeiyuI18n.t("演示通关烟花"),!r.ready||c.game?.active||c.runtime?.rawState&&c.runtime.rawState!=='IDLE','ghost')}</div></div></div></section>
<div class="control-runtime-grid"><section class="card"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("语音聊天")}</h2><span class="tag">${v.reachable?window.DafeiyuI18n.t("后台已启动"):window.DafeiyuI18n.t("等待启动")}</span></div><p class="control-muted">${jump('bindings','陪伴互动')} · ${window.DafeiyuI18n.h('后侧键按住说话')}</p><div class="control-buttons">${button(s,'voice-interrupt',window.DafeiyuI18n.t("打断回复"),!v.reachable)}${button(s,'voice-stop',window.DafeiyuI18n.t("停止语音"),!v.reachable,'ghost')}</div></section><section class="card"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("屏幕与陪伴")}</h2><span class="tag">${({text:window.DafeiyuI18n.t("文字模式"),animation:window.DafeiyuI18n.t("动画＋任务状态"),manual:window.DafeiyuI18n.t("实体键浏览"),pages:window.DafeiyuI18n.t("快捷页模式")})[r.mode]??window.DafeiyuI18n.t("等待联动")}</span></div><div class="control-buttons">${button(s,'sync-start',window.DafeiyuI18n.t("启动联动"),r.running,'')}${button(s,'screen-animation',window.DafeiyuI18n.t("动画＋任务状态"),!r.ready||r.screen?.ready===false)}${button(s,'screen-text',window.DafeiyuI18n.t("状态文字"),!r.ready||r.screen?.ready===false)}${button(s,r.attentionEnabled?'attention-off':'attention-on',r.attentionEnabled?window.DafeiyuI18n.t("暂停主动讨摸摸"):window.DafeiyuI18n.t("恢复主动讨摸摸"),!r.running,'ghost')}${button(s,'sync-stop',window.DafeiyuI18n.t("停止并恢复设备"),!(r.running||r.supervised||r.reconnecting||r.startup?.phase==='starting'),'ghost')}</div></section></div>
<div class="control-buttons"><button class="button outline" data-view="control" data-panel-tab="phone">${window.DafeiyuI18n.h("语音与电话")}</button><button class="button outline" data-view="control" data-panel-tab="speaker">${window.DafeiyuI18n.h("切换音箱页面")}</button><button class="button outline" data-view="devices">${window.DafeiyuI18n.h("设备状态")}</button></div>
<div class="note-panel">${r.supervised?window.DafeiyuI18n.t("自动恢复守护已启用 · 已自动重启 ")+r.supervisor.restarts+window.DafeiyuI18n.t(" 次"):window.DafeiyuI18n.t("设备联动守护等待启动")}${r.connection?.error?' · '+E(window.DafeiyuI18n.message(r.connection.error)):''}</div>${c.savedAt?`<div class="note-panel">${window.DafeiyuI18n.h("最近保存 ·")} ${E(window.DafeiyuI18n.message(c.savedAt.message))} · ${E(new Date(c.savedAt.at).toLocaleString(window.DafeiyuI18n.locale))}</div>`:''}`;}
function footer(s,group,label=window.DafeiyuI18n.t("保存参数"),extra=''){const dirty=!!drafts[group];return `<div class="control-form-footer"><button class="button" data-action="control-save" data-group="${group}" ${!dirty||s.busy.has('control-save-'+group)?'disabled':''}>${label}</button><button class="button ghost" data-action="control-reset" data-group="${group}" ${!dirty?'disabled':''}>${window.DafeiyuI18n.h("撤销修改")}</button>${extra}</div>`;}
function shortcutCaps(value){
 const parts=String(value??'').slice(0,100).split('+').map(key=>key.trim()).filter(Boolean).slice(0,8);
 return parts.length?parts.map((key,i)=>`<span class="shortcut-chord-part">${i?'<span class="shortcut-plus" aria-hidden="true">+</span>':''}<kbd>${E(key)}</kbd></span>`).join(''):`<span class="control-muted">${window.DafeiyuI18n.h('尚未读取')}</span>`;
}
function shortcutHeading(icon,title){return `<div class="shortcut-section-heading"><span class="shortcut-section-icon" data-shortcut-symbol="${icon}" aria-hidden="true"></span><h3>${window.DafeiyuI18n.h(title)}</h3></div>`;}
function shortcutEditor(group,key,value,label,disabled=false){
 const id='ctl-'+group+'-'+key;
 return `<div class="shortcut-binding-row"><label for="${id}" class="shortcut-field-label">${E(label)}</label><div class="shortcut-editor" data-shortcut-editor><input id="${id}" name="${key}" type="text" ${group==='bindings'?'data-control-group="bindings"':''} data-shortcut-input data-shortcut-group="${group}" data-shortcut-label="${E(label)}" value="${E(value)}" readonly ${disabled?'disabled':''} autocomplete="off" spellcheck="false" aria-describedby="shortcut-input-help shortcut-recording-status"><span class="shortcut-key-preview" data-binding-preview="${key}" aria-hidden="true">${shortcutCaps(value)}</span></div></div>`;
}
function bindingShortcut(values,key,label){const row=schema.bindings.find(item=>item[0]===key);return shortcutEditor('bindings',key,values[key]??'',label?window.DafeiyuI18n.t(label):row[1]);}
function shortcutsDirty(){return !!drafts.bindings||!!shortcutDrafts.voice||!!shortcutDrafts.phone;}
function shortcutsFooter(s){const I=window.DafeiyuI18n,disabled=!shortcutsDirty()||s.busy.has('control-shortcuts-save');return `<div class="control-form-footer shortcut-save-footer"><p id="shortcut-recording-status" role="status" aria-live="polite">${I.h(shortcutNotice||'点击快捷键框，再按下新的组合键。')}</p><div class="control-buttons"><button class="button ghost" data-action="control-shortcuts-reset" ${disabled?'disabled':''}>${I.h('撤销修改')}</button><button class="button" data-action="control-shortcuts-save" ${disabled?'disabled':''}>${I.h('保存快捷键')}</button></div></div>`;}
function shortcutFeedback(message,el){
 shortcutNotice=message;
 const status=document.querySelector?.('#shortcut-recording-status');if(status)status.textContent=window.DafeiyuI18n.t(message);
 const form=el?.closest?.('.control-form');if(!form)return;
 const save=form.querySelector('[data-action="control-shortcuts-save"]')??form.querySelector('[data-action="control-save"]');if(save)save.disabled=!shortcutsDirty();
 const reset=form.querySelector('[data-action="control-shortcuts-reset"]')??form.querySelector('[data-action="control-reset"]');if(reset)reset.disabled=!shortcutsDirty();
 const tag=form.querySelector('.tag');if(tag){tag.textContent=window.DafeiyuI18n.t(shortcutsDirty()?'有未保存修改':'保存立即应用');if(shortcutsDirty())tag.classList.add('amber');else tag.classList.remove?.('amber');}
}
function capturedShortcut(event){
 if(event.repeat||['Control','Alt','Shift','Meta','AltGraph'].includes(event.key))return {};
 if(event.metaKey||event.getModifierState?.('AltGraph'))return {error:'请使用 Ctrl 或 Shift 组合，避免占用系统快捷键。'};
 const code=event.code??'',key=/^(?:Key|Digit|Numpad)([A-Z0-9])$/.exec(code)?.[1]??(/^F([1-9]|1\d|2[0-4])$/.test(code)?code:null);
 if(!key||!event.ctrlKey&&!event.shiftKey)return {error:'请按 Ctrl 或 Shift 搭配字母、数字或 F1～F24。'};
 const chord=[event.ctrlKey&&'Ctrl',event.altKey&&'Alt',event.shiftKey&&'Shift',key].filter(Boolean).join('+');
 if(/^Ctrl\+[CVXZASWFTNOPRH]$/.test(chord))return {error:'请避开常用的编辑或系统快捷键。'};
 return {chord};
}
function shortcutConflict(el,chord){
 const c=lastState?.data.controls,group=el.dataset.shortcutGroup,key=el.name;
 const normalize=value=>{const p=String(value??'').toUpperCase().split('+');return [...p.slice(0,-1).sort(),p.at(-1)].join('+');};
 const all={bindings:drafts.bindings?.values??c?.groups.bindings?.values,phone:{hotkey:shortcutDrafts.phone?.values.hotkey??c?.groups.phone?.values.hotkey},voice:{voiceHotkey:shortcutDrafts.voice?.values.voiceHotkey??c?.groups.voice?.values.voiceHotkey??c?.voice?.voiceHotkey}};
 return Object.entries(all).some(([g,values])=>Object.entries(values??{}).some(([k,value])=>!k.startsWith('mouse')&&(g!==group||k!==key)&&normalize(value)===normalize(chord)));
}
function cancelShortcutRecording(message){
 const record=shortcutRecording;if(!record)return;shortcutRecording=null;
 clearInterval(record.renew);clearTimeout(record.timeout);clearTimeout(record.release);
 delete record.el.dataset.recording;record.el.removeAttribute?.('aria-busy');
 const preview=record.el.closest?.('[data-shortcut-editor]')?.querySelector?.('[data-binding-preview]');if(preview)preview.innerHTML=shortcutCaps(record.el.value);
 if(message)shortcutFeedback(message,record.el);
 void record.request('/controls/shortcut-capture',{operation:'end',id:record.id}).catch(()=>{});
}
let shortcutRequest;
async function beginShortcutRecording(el,request=shortcutRequest){
 if(!el||el.disabled||!request)return;
 cancelShortcutRecording();
 const id=globalThis.crypto?.randomUUID?.()??(globalThis.crypto?.getRandomValues?Array.from(globalThis.crypto.getRandomValues(new Uint8Array(18)),byte=>byte.toString(16).padStart(2,'0')).join(''):null);if(!id){shortcutFeedback('浏览器不支持安全的按键录入，请更新浏览器。',el);return;}
 const record={el,id,request,phase:'preparing'};shortcutRecording=record;el.dataset.recording='preparing';el.setAttribute?.('aria-busy','true');
 const preview=el.closest('[data-shortcut-editor]').querySelector('[data-binding-preview]');preview.textContent=window.DafeiyuI18n.t('正在准备按键录入…');
 try{
  await request('/controls/shortcut-capture',{operation:'begin',id});
  if(shortcutRecording!==record){void request('/controls/shortcut-capture',{operation:'end',id}).catch(()=>{});return;}
  record.phase='recording';el.dataset.recording='recording';el.removeAttribute?.('aria-busy');preview.textContent=window.DafeiyuI18n.t('请按下快捷键');
  shortcutFeedback('按下新组合键，或按 Esc 取消。',el);
  record.renew=setInterval(()=>{void request('/controls/shortcut-capture',{operation:'renew',id}).catch(()=>{if(shortcutRecording===record)cancelShortcutRecording('按键录入已中断，请重新点击。');});},2000);
  record.timeout=setTimeout(()=>{if(shortcutRecording===record)cancelShortcutRecording('录入已取消，原快捷键未变。');},30000);
 }catch(error){if(shortcutRecording===record){cancelShortcutRecording();shortcutFeedback(window.DafeiyuI18n.message(error.message),el);}}
}
function shortcutKeydown(event){
 const el=event.target;
 if(!el?.matches?.('[data-shortcut-input]')||el.disabled)return;
 const record=shortcutRecording;
 if(!record||record.el!==el){if(['Enter',' '].includes(event.key)){event.preventDefault();void beginShortcutRecording(el);}return;}
 if(event.key==='Tab'){cancelShortcutRecording(record.phase==='finishing'?'录入已结束，未保存的修改仍保留。':'录入已取消，原快捷键未变。');return;}
 event.preventDefault();event.stopPropagation();
 if(event.key==='Escape'){cancelShortcutRecording(record.phase==='finishing'?'录入已结束，未保存的修改仍保留。':'录入已取消，原快捷键未变。');el.blur?.();return;}
 if(record.phase!=='recording')return;
 const result=capturedShortcut(event);if(result.error){shortcutFeedback(result.error,el);return;}if(!result.chord)return;
 if(shortcutConflict(el,result.chord)){shortcutFeedback('这组按键已用于其他功能，请换一组。',el);return;}
 const group=el.dataset.shortcutGroup,key=el.name;
 if(el.value!==result.chord){
  el.value=result.chord;
  if(group==='bindings')edit({target:el},lastState);
  else{const meta=lastState.data.controls.groups[group];if(!shortcutDrafts[group])shortcutDrafts[group]={revision:meta.revision,values:{}};shortcutDrafts[group].values[key]=result.chord;}
 }
 record.phase='finishing';delete el.dataset.recording;
 const preview=el.closest('[data-shortcut-editor]').querySelector('[data-binding-preview]');preview.innerHTML=shortcutCaps(el.value);
 shortcutFeedback('快捷键已修改，点击保存后生效。',el);
 // Keep global listeners released until the physical keys have been released.
 record.release=setTimeout(()=>{if(shortcutRecording===record)cancelShortcutRecording();},1500);
}
document.addEventListener?.('keydown',shortcutKeydown,true);
document.addEventListener?.('keyup',event=>{if(shortcutRecording?.phase==='finishing'&&!event.ctrlKey&&!event.altKey&&!event.shiftKey&&!event.metaKey)cancelShortcutRecording();},true);
document.addEventListener?.('focusout',event=>{if(shortcutRecording?.el===event.target)cancelShortcutRecording('录入已结束，未保存的修改仍保留。');});
document.addEventListener?.('visibilitychange',()=>{if(document.hidden)cancelShortcutRecording();});
window.addEventListener?.('blur',()=>cancelShortcutRecording());
window.addEventListener?.('pagehide',()=>cancelShortcutRecording());
function bindings(s){
 const I=window.DafeiyuI18n,c=s.data.controls,h=c.hotkeys,v=c.voice??{},meta=c.groups.bindings;
 const values=drafts.bindings?.values??meta.values,dirty=shortcutsDirty();
 const live=h?.ready&&Date.now()-h.observedAt<10000,longReady=v.reachable&&v.ready&&v.nativeReady&&v.mouseBindingReady!==false,recovery=c.mouseBindings;
 const voiceKey=shortcutDrafts.voice?.values.voiceHotkey??c.groups.voice?.values?.voiceHotkey??v.voiceHotkey;
 const phoneKey=shortcutDrafts.phone?.values.hotkey??(c.groups.phone?.available===false?null:c.groups.phone?.values?.hotkey);
 const channelKey=(group,key,label,value)=>c.groups[group]?.available?shortcutEditor(group,key,value??'',I.t(label)):readOnly(label,value);
 const readOnly=(label,key)=>`<div class="shortcut-binding-row"><strong class="shortcut-field-label">${I.h(label)}</strong><output class="shortcut-readonly" ${key?`aria-label="${E(key)}"`:''}>${shortcutCaps(key)}</output></div>`;
 const mouseFields=schema.bindings.filter(row=>row[0].startsWith('mouse')).map(row=>field('bindings',row,values)).join('');
 return `<div class="shortcut-bindings-page"><section class="control-form shortcut-bindings-form" aria-label="${I.h('自定义绑定')}"><div class="control-section-heading shortcut-page-heading"><div><h2>${I.h('快捷键与鼠标动作')}</h2><p class="control-muted" id="shortcut-input-help">${I.h('点击快捷键框，再按下新的组合键。Esc 取消，保存后生效。')}</p></div><span class="tag ${dirty?'amber':''}">${I.h(dirty?'有未保存修改':'保存立即应用')}</span></div><p class="shortcut-listener-state" role="status">${I.h(live?'快捷键监听已就绪':'快捷键监听未就绪')}</p>
 <fieldset class="card shortcut-touch-card"><legend>${I.h('摸摸与陪伴')}</legend><div class="shortcut-touch-top"><div>${shortcutHeading('keyboard-normal.png','摸摸大肥鱼')}<p class="control-muted">${I.h('从左到右依次按下 F1 到 F12，摸摸她的头。')}</p></div>${bindingShortcut(values,'pet','备用摸摸快捷键')}</div><div class="shortcut-sequence" aria-label="${I.h('从 F1 依次按到 F12')}">${Array.from({length:3},(_,group)=>`<div class="shortcut-key-group">${Array.from({length:4},(_,i)=>`<kbd>F${group*4+i+1}</kbd>`).join('')}</div>`).join('')}</div></fieldset>
 <div class="shortcut-bindings-grid"><section class="card shortcut-voice-card">${shortcutHeading('voice-normal.png','语音与电话')}${channelKey('voice','voiceHotkey','发语音',voiceKey)}${channelKey('phone','hotkey','拨号／挂断快捷键',phoneKey)}<p class="control-muted">${I.h('点击框后按下组合键。语音与电话设置会同步更新。')}</p><div class="control-buttons">${jump('phone','语音与电话')}${jump('voice','模型与识别')}</div><div class="shortcut-voice-status"><div class="control-section-heading"><h4>${I.h('后侧键长按说话')}</h4><span class="shortcut-listener-state">${I.h(longReady?'语音已就绪':v.reachable?'等待语音就绪':'语音未启动')}</span></div><p class="control-muted">${longReady?I.h('按住后侧键说话，松开提交；短按执行当前设置的动作。'):v.reachable?E(I.message(v.mouseBindingError??v.nativeError??v.error??v.phase??I.t('正在准备语音，请稍候。'))):I.h('短按宏可以使用；长按说话需要先启动语音服务。')}</p>${longReady?'':voiceStart(s,v)}${recovery?.error&&Date.now()-recovery.at<10000?`<p role="status">${E(I.message(recovery.error))}</p>`:''}</div></section>
 <fieldset class="card shortcut-game-card"><legend>${I.h('颜色记忆游戏')}</legend>${shortcutHeading('play-metal.svg','颜色记忆游戏')}${bindingShortcut(values,'gameToggle')}${bindingShortcut(values,'gameReplay')}<div class="shortcut-answer-heading"><h4>${I.h('按颜色作答')}</h4><span class="control-muted">${I.h('仅游戏时使用。')}</span></div><div class="shortcut-answer-grid">${[['color1','红'],['color2','黄'],['color3','蓝'],['color4','绿']].map(([key,label])=>`<div class="shortcut-answer shortcut-answer-${key}">${bindingShortcut(values,key,label)}</div>`).join('')}</div></fieldset>
 <fieldset class="card shortcut-mouse-card"><legend>${I.h('鼠标侧键')}</legend>${shortcutHeading('mouse-normal.png','鼠标动作')}<div class="shortcut-mouse-fields">${mouseFields}</div></fieldset></div>
 ${shortcutsFooter(s)}</section>
 <section class="card shortcut-companion-test"><div><h3>${I.h('陪伴测试')}</h3><p class="control-muted">${I.h('立即测试主动求摸摸，八秒内按摸摸键回应；未回应不扣好感度。')}</p></div><div class="control-buttons">${button(s,'beg-demo',I.t('测试主动求摸摸'),!c.sync?.ready||c.game?.active,'outline')}</div></section>
 <details class="control-details shortcut-help"><summary>${I.h('摸摸与好感度')}</summary><p>${I.h('连续从 F1 按到 F12 即可摸摸。好感度初始 20%，普通摸摸 +2，应邀摸摸 +3，接来电 +4，未接来电 −2，求摸摸超时 −1。')}</p></details><details class="control-details shortcut-help"><summary>${I.h('现有鼠标宏与兼容快捷键说明')}</summary><p>${I.h('鼠标继续使用已安装的宏入口，无需重新录制。Ctrl+Alt+G 与 Ctrl+Alt+F9 为兼容入口；如更换侧键功能，请先给原功能另选快捷键。后侧键在语音就绪时可长按说话；语音退出后恢复短按宏，短按动作单独设置。游戏窗口中的直接数字输入继续保留。')}</p></details>${h?.bindingError?`<div class="note-panel" role="status">${E(I.message(h.bindingError))}</div>`:''}</div>`;
}
function syncDevices(s){
const c=s.data.controls,g=c.groups.syncDevices,list=c.syncInventory??{},devices=list.devices??[],fresh=list.available&&!list.stale&&Number.isFinite(list.checkedAt)&&Date.now()-list.checkedAt>=0&&Date.now()-list.checkedAt<15000;
if(!g?.available)return `<section class="card"><h2>${window.DafeiyuI18n.h("参与同步的设备")}</h2><p class="control-muted">${window.DafeiyuI18n.h("正在准备设备清单。")}</p></section>`;
const values=drafts.syncDevices?.values??g.values,ids=values.deviceIds??devices.filter(d=>d.selected).map(d=>d.id),types=window.DafeiyuI18n.live({keyboard:window.DafeiyuI18n.t("键盘"),speaker:window.DafeiyuI18n.t("音箱"),mouseDock:window.DafeiyuI18n.t("鼠标底座"),headsetDock:window.DafeiyuI18n.t("耳机底座")});
return `<section class="card control-form"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("参与同步的设备")}</h2><span class="tag">${drafts.syncDevices?window.DafeiyuI18n.t("有未保存修改"):fresh?window.DafeiyuI18n.phrase("devicesOnline",devices.filter(d=>d.connected).length):window.DafeiyuI18n.t('上次识别')+' '+window.DafeiyuI18n.number(devices.length)}</span></div><p class="control-muted">${window.DafeiyuI18n.h("勾选要跟随任务的设备，所有选中设备使用同一套迈从神光同步灯效。")}</p>${!fresh?`<p class="control-muted">${window.DafeiyuI18n.h("上次读取")} · ${Number.isFinite(list.checkedAt)?E(new Date(list.checkedAt).toLocaleString(window.DafeiyuI18n.locale)):window.DafeiyuI18n.h("尚未读取")}</p>`:''}${!list.available?`<p role="status">${E(window.DafeiyuI18n.message(list.error??window.DafeiyuI18n.t("等待连接 M HUB，保留上次清单。")))}</p>`:''}<div class="sync-device-grid">${devices.filter(d=>d.connected||ids.includes(d.id)).map(d=>`<label class="sync-device ${d.connected?'':'is-offline'}"><input type="checkbox" data-control-group="syncDevices" data-device-id="${E(d.id)}" ${ids.includes(d.id)?'checked':''} aria-label="${window.DafeiyuI18n.h("参与同步：")}${E(d.name)}"><span><strong>${E(d.name)}</strong><small>${E(types[d.type]??window.DafeiyuI18n.t("灯光设备"))} · ${!fresh?window.DafeiyuI18n.t("状态待确认"):d.connected?window.DafeiyuI18n.t("已连接"):window.DafeiyuI18n.t("未连接，保留选择")}</small></span></label>`).join('')||window.DafeiyuI18n.markup("<p class=\"control-muted\">暂未检测到支持神光同步的设备。</p>")}</div>${footer(s,'syncDevices',window.DafeiyuI18n.t("保存同步设备"),window.DafeiyuI18n.markup("<button class=\"button ghost\" data-action=\"control-run\" data-command=\"sync-devices-refresh\">重新检测设备</button>"))}</section>`;
}
function lightStateCard(s,key,label,description,style,effects){
 const {h}=window.DafeiyuI18n;
 const editing=expandedLights.has(key), selected=selectedLight===key;
 const unavailable=!s.data.controls.sync.running||s.data.controls.sync.ready===false||s.busy.has('control-run');
 return `<article class="task-light-card" data-light-state="${key}" data-selected="${selected}" data-editing="${editing}">
  <header class="task-card-heading"><h3><i style="background:${E(style.color)}"></i>${label}</h3>
  <button type="button" class="button outline small" data-action="control-preview" data-state="${key}" ${unavailable?'disabled':''}>${h('试用 8 秒')}</button></header>
  <p class="control-muted">${description}</p>
  <button type="button" class="button ghost light-edit-toggle" data-action="control-light-edit" data-state="${key}" aria-controls="light-fields-${key}" aria-expanded="${editing}">${editing?h('收起参数'):h('编辑参数')}</button>
  <div id="light-fields-${key}" class="light-fields">
   <div class="task-card-group"><h4>${h('灯光效果')}</h4>
    <label>${h('迈从预设')}<select data-control-group="taskLights" name="${key}.effect" aria-label="${label}${h('灯效')}">${effects.map(([id,name])=>`<option value="${id}" ${style.effect===id?'selected':''}>${name}</option>`).join('')}</select></label>
    <label>${h('颜色')}<input type="color" data-control-group="taskLights" name="${key}.color" value="${E(style.color)}" aria-label="${label}${h('灯光颜色')}"></label>
    <label>${h('亮度 · %')}<input type="number" min="1" max="100" required data-control-group="taskLights" name="${key}.brightness" value="${E(style.brightness)}" aria-label="${label}${h('亮度')}"></label>
    <label>${h('速度 · 1～5')}<input type="number" min="1" max="5" required data-control-group="taskLights" name="${key}.speed" value="${E(style.speed??1)}" aria-label="${label}${h('速度')}"></label>
   </div>
   <div class="task-card-group"><h4>${h('屏幕提示')}</h4>
    <label>${h('屏幕文字')}<input required maxlength="48" type="text" data-control-group="taskLights" name="${key}.label" value="${E(style.label)}" aria-label="${label}${h('屏幕文字')}"></label>
   </div>
  </div></article>`;
}
function stateLights(s){
 const {t,h}=window.DafeiyuI18n,c=s.data.controls,r=c.runtime,values=drafts.taskLights?.values??c.groups.taskLights.values;
 const live=r?.at<=Date.now()&&Date.now()-r.at<10000;
 const preview=live&&r.preview&&(!r.preview.until||r.preview.until>Date.now());
 const states=[['IDLE',t('待命'),t('空闲时恢复设备原灯效；这里的待命效果仅供试用。')],['BUSY',t('处理中'),t('任务期间临时接管，结束后恢复原灯效。')],['ATTENTION',t('需要你'),t('真正失败、等待确认或长时间失联时提醒。')]];
 const effects=[['steady',t('常亮')],['breathing',t('呼吸')],['center-breathing',t('中心呼吸')],['expansion',t('扩散')],['wave',t('波浪')],['rainbow',t('彩虹')]];
 const pages={fish:t('大肥鱼动画'),status:t('任务状态'),balance:t('余额'),clock:t('时间'),affinity:t('好感度')};
 const overlays={voice:t('语音字幕'),game:t('游戏中'),interaction:t('互动中'),manual:t('手动浏览'),off:t('已关闭')};
 const screen=live?(r.screenFeedback?.text??overlays[r.screenFeedback?.phase]??(r.screenMode==='pages'?pages[r.shortcutPage]:r.screenMode==='text'?t('状态文字'):t('大肥鱼动画'))):t('等待回执');
 const lights=live?(r.taskLighting?.active===false?t('各设备原灯效'):names[r.displayState]??t('互动中')):t('等待联动');
 const picker=states.map(([key,label])=>`<button type="button" class="button outline" data-action="control-light-select" data-state="${key}" aria-pressed="${selectedLight===key}">${label}</button>`).join('');
 return `<section class="section-header"><div><h2>${h('Harness 任务与神光同步')}</h2><p>${h('当前灯光：')}${E(lights)} ${h('· 小屏：')}${E(screen??t('快捷页'))}${preview?h(' · 正在试用'):''}</p></div>
  ${preview?button(s,'task-light-stop',t('结束试用并恢复'),!c.sync.running):''}</section>
  <section class="card control-form light-settings-form">
   <div class="control-section-heading"><h2>${h('灯光效果')}</h2><span class="tag ${drafts.taskLights?'amber':''}">${drafts.taskLights?h('有未保存修改'):h('保存立即应用')}</span></div>
   <div role="group" class="light-state-picker" aria-label="${h('任务状态')}">${picker}</div>
   <div class="task-light-grid">${states.map(([key,label,description])=>lightStateCard(s,key,label,description,values[key],effects)).join('')}</div>
   ${footer(s,'taskLights')}
  </section>${syncDevices(s)}
  <details class="control-details"><summary>${h('状态判定与运行信息')}</summary><p>${h('直接使用 M HUB 神光同步预设。选择彩虹可让多色流动；其余预设使用你设置的颜色。')}</p><p>${h('任务自动切屏，完成提示 6 秒、待命提示 3 秒后恢复原页面。语音和游戏优先。')}</p><p>${h('工具重试保持处理中，只有终止错误才显示报错。连接心跳正常时保持当前状态。')}</p><p>${h('本次运行已过滤')} ${r?.taskDiagnostics?.retriedTools??0} ${h('次可继续执行的工具错误提示。')}</p></details>`;
}
function balanceAvailability(c){
 const keyboard=c.balanceKeyboard??c.balance?.keyboard;
 return keyboard?.available===true&&['GT 75','Ace 75 8K'].includes(keyboard.model)&&[20,28].includes(keyboard.segments)?keyboard:null;
}
function balanceLive(s){const c=s.data.controls,b=c.balance,g=c.groups.balance,keyboard=balanceAvailability(c),view=b?.view;
 const live=!!b&&!!keyboard&&b.live!==false&&Date.now()>=b.updatedAt&&Date.now()-b.updatedAt<5000&&(!g.controlVersion||g.controlVersion===b.controlVersion)&&(!b.keyboard||b.keyboard.model===keyboard?.model);
 const reason=({'connection-unavailable':window.DafeiyuI18n.t("设备联动已断开"),'stale-status':window.DafeiyuI18n.t("设备回执已过期"),disabled:window.DafeiyuI18n.t("已关闭"),'game-active':window.DafeiyuI18n.t("任务或游戏临时占用灯光"),'balance-unavailable':window.DafeiyuI18n.t("余额暂不可读取"),'manual-change':window.DafeiyuI18n.t("已由 M HUB 手动接管；重新勾选即可恢复余额条"),'sync-takeover':window.DafeiyuI18n.t("神光同步临时占用灯光，结束后自动恢复"),'unsupported-keyboard':window.DafeiyuI18n.t("请连接已适配的键盘"),'multiple-keyboards':window.DafeiyuI18n.t("检测到多台适配键盘，请只保留一台后使用")})[b?.reason];
 const mirrored=keyboard?.model==='GT 75'&&(b?.layout?.mode??g.values.gt75Layout)==='mirrored';
 const count=mirrored?10:keyboard?.segments,units=view?.zeroAlert?8:view&&count?Math.max(view.amount>0?1:0,Math.round(Math.max(0,Math.min(1,view.ratio))*count*8)):0,lit=Math.min(count??0,Math.ceil(units/8));
 const history=Boolean(view&&!live);
 const receiptLabel=live&&view?.stale?window.DafeiyuI18n.t('上次记录'):live?window.DafeiyuI18n.t('当前灯带'):history?window.DafeiyuI18n.t('上次记录'):window.DafeiyuI18n.t('等待设备回执');
 const receiptTime=history&&Number.isFinite(b?.updatedAt)?new Date(b.updatedAt).toLocaleString(window.DafeiyuI18n.locale):'';
 const strip=label=>`<div class="balance-segments" style="grid-template-columns:repeat(${count},minmax(0,1fr))" aria-label="${E(label)}">${Array.from({length:count},(_,i)=>`<i style="background:${view&&i<lit&&(history||b.visible)?(view.ratio>.5?'#00FF00':view.ratio>.2?'#FFB400':'#FF0000'):'#d9dfd8'}"></i>`).join('')}</div>`;
 const preview=mirrored?`<div class="balance-strip-rows" aria-label="${window.DafeiyuI18n.h("GT75 左右同步余额预览")}">${[window.DafeiyuI18n.t("左侧"),window.DafeiyuI18n.t("右侧")].map(side=>`<div class="balance-strip-row"><span>${side}</span>${strip(side+window.DafeiyuI18n.t("余额灯带预览"))}</div>`).join('')}</div><small class="control-muted balance-strip-direction">${window.DafeiyuI18n.h("两侧同向增长 · 每行从左到右对应实物从上到下")}</small>`:strip((keyboard?.model??'')+window.DafeiyuI18n.t(" 余额灯带预览"));
 return `<div class="${history?'balance-receipt-history':'balance-receipt'}"><p class="balance-receipt-status">${E(receiptLabel)}${receiptTime?' · '+E(receiptTime):''}</p><div class="balance-numbers"><div><small>${window.DafeiyuI18n.h("最近账户余额")}</small><strong>${view?'¥'+window.DafeiyuI18n.number(view.amount,{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}</strong></div><div><small>${history?window.DafeiyuI18n.h("上次记录"):window.DafeiyuI18n.h("实际灯带比例")}</small><strong>${keyboard&&(history||b?.visible)&&Number.isFinite(view?.ratio)?window.DafeiyuI18n.number(view.ratio*100,{minimumFractionDigits:1,maximumFractionDigits:1})+'%':'—'}</strong></div><div><small>${window.DafeiyuI18n.h("设备应用的满格金额")}</small><strong>${Number.isFinite(b?.fullAmount)?'¥'+window.DafeiyuI18n.number(b.fullAmount,{minimumFractionDigits:2,maximumFractionDigits:2}):'—'}</strong></div></div>${keyboard?`${preview}${view?.zeroAlert?'<p>'+window.DafeiyuI18n.h('零余额：红灯仅作提醒，不代表余额进度。')+'</p>':''}<p>${E(keyboard.model)} · ${mirrored?window.DafeiyuI18n.t("双侧同步 · 每侧 10 颗"):count+window.DafeiyuI18n.t(" 颗灯珠 · 连续进度")} · ${live?(b.visible?`${window.DafeiyuI18n.h("已显示 ·")} ${mirrored?window.DafeiyuI18n.t("每侧约"):window.DafeiyuI18n.t("约")} ${lit} / ${count} ${window.DafeiyuI18n.h("段 · 亮度")} ${b.brightness??'—'}%`:E(reason??window.DafeiyuI18n.t("当前未显示"))):E(reason||window.DafeiyuI18n.t("等待设备实时回执"))}${g.controlVersion&&g.controlVersion!==b?.controlVersion?window.DafeiyuI18n.t(" · 新参数等待应用"):''}</p>`:'<p class="balance-unavailable-message">'+E(c.balanceKeyboard?.reason==='multiple-keyboards'?window.DafeiyuI18n.t("检测到多台适配键盘，请只保留一台后使用。"):window.DafeiyuI18n.t("未连接已适配键盘，余额灯带暂不可用。连接后自动恢复，已有参数会保留。"))+'</p>'}<small class="control-muted">${window.DafeiyuI18n.h("余额读取：")}${view?E(new Date(view.checkedAt).toLocaleTimeString(window.DafeiyuI18n.locale,{hour12:false})):'—'} ${window.DafeiyuI18n.h("· 设备回执：")}${b?E(new Date(b.updatedAt).toLocaleTimeString(window.DafeiyuI18n.locale,{hour12:false})):'—'}</small>${b?.error?`<p>${E(window.DafeiyuI18n.message(b.error))}</p>`:''}${b?.cacheWarning?`<p role="status">${E(window.DafeiyuI18n.message(b.cacheWarning))}</p>`:''}</div>`;
}

function balance(s){const available=!!balanceAvailability(s.data.controls);
return `<div class="balance-page${available?'':' is-unavailable'}" data-balance-page><section class="section-header"><div><h2>${window.DafeiyuI18n.h("DeepSeek 余额灯带")}</h2><p>${window.DafeiyuI18n.h("显示账户金额占满格金额的比例，不是剩余 Token 数。每分钟刷新余额。")}</p></div>${button(s,'balance-refresh',window.DafeiyuI18n.t("立即刷新余额"),!available||!s.data.controls.sync.running)}</section>${window.DafeiyuCompanion?.renderBalanceSource?.(s)??''}<section class="card balance-live" data-balance-live>${balanceLive(s)}</section><fieldset class="balance-settings-gate" ${available?'':'disabled'}>${form(s,'balance',window.DafeiyuI18n.t("灯带参数"))}</fieldset><details class="control-details"><summary>${window.DafeiyuI18n.h("余额灯带的控制与恢复规则")}</summary><p>${window.DafeiyuI18n.h("根据已连接键盘自动匹配原生灯图；未连接或型号尚未适配时禁用操作并保留参数。保存后直接更新亮起长度和亮度，无需重启联动。满格金额不得低于当前余额；高于满格的 50% 显示绿色，20%～50% 显示黄色，低于或等于 20% 使用纯红警示；页面预览与实物一致。断网后继续显示上次余额并标记。零余额保留一颗红灯提醒。启用余额灯带时会自动关闭 M HUB 常驻神光同步。任务、电话、游戏和烟花临时优先，结束后恢复余额条；手动修改氛围灯会取消勾选，再次启用立即恢复。")}</p></details></div>`;}

function audio(s){const c=s.data.controls,g=c.groups.audio;if(!g?.available)return `<section class="card"><h2>${window.DafeiyuI18n.h("音频配置暂时不可用")}</h2><p role="status">${E(window.DafeiyuI18n.message(g?.error??window.DafeiyuI18n.t("配置文件无法读取，原文件已保留。")))}</p></section>`;const v=drafts.audio?.values??g.values,list=c.audioDevices?.devices??[];
const selector=direction=>{const current=list.find(d=>d[direction]&&d.name===v[direction+'Name']&&d.api===v[direction+'Api'])??list.find(d=>d[direction]&&d.name.includes(v[direction+'Name'])&&d.api===v[direction+'Api']);const available=list.filter(d=>d[direction]);
const byName=new Map();
for(const device of available){
 const previous=byName.get(device.name);
 if(!previous||device===current||previous!==current&&device.api==='Windows WASAPI')byName.set(device.name,device);
}
const rows=window.DafeiyuI18n.live([{name:'__default__',api:'MME',label:window.DafeiyuI18n.t("跟随 Windows 默认设备")},...(audioAdvanced?available:byName.values())]);return `<label class="audio-select"><strong>${direction==='input'?window.DafeiyuI18n.t("语音识别用麦克风"):window.DafeiyuI18n.t("声音播放设备")}</strong><select data-control-group="audio" data-audio-direction="${direction}" aria-label="${direction==='input'?window.DafeiyuI18n.t("语音识别用麦克风"):window.DafeiyuI18n.t("声音播放设备")}">${!current&&v[direction+'Name']!=='__default__'?`<option value="" disabled selected>${E(v[direction+'Name'])} ${window.DafeiyuI18n.h("· 未连接，请检测设备")}</option>`:''}${rows.map(d=>`<option value="${E(JSON.stringify({name:d.name,api:d.api}))}" ${current===d||d.name===v[direction+'Name']&&d.name==='__default__'?'selected':''}>${E(d.label??(audioAdvanced?d.name+' · '+d.api:d.name))}</option>`).join('')}</select></label>`;};
return `<section class="section-header"><div><h2>${window.DafeiyuI18n.h("录音与播放设备")}</h2><p>${c.audioDevices?.stale?window.DafeiyuI18n.t("这是上次检测的设备清单，请重新检测以确认当前连接。"):window.DafeiyuI18n.t("直接选择检测到的设备。")}${window.DafeiyuI18n.h("不会更改 Windows 的默认设备。")}</p></div><button class="button outline" data-action="control-audio-refresh">${window.DafeiyuI18n.h("重新检测设备")}</button></section><section class="card control-form"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("音频路由")}</h2><span class="tag">${window.DafeiyuI18n.h("单独应用，不重载语音模型")}</span></div>${selector('input')}${selector('output')}<button type="button" class="button outline" data-action="control-audio-advanced" aria-pressed="${audioAdvanced}">${audioAdvanced?window.DafeiyuI18n.t("简化设备列表"):window.DafeiyuI18n.t("显示高级音频接口")}</button><div class="control-form-footer"><button class="button" data-action="control-audio-apply">${drafts.audio?window.DafeiyuI18n.t("保存并应用"):window.DafeiyuI18n.t("重新应用已保存设备")}</button><button class="button outline" data-action="control-audio-test">${window.DafeiyuI18n.h("试听所选播放设备")}</button><button class="button ghost" data-action="control-reset" data-group="audio" ${!drafts.audio?'disabled':''}>${window.DafeiyuI18n.h("撤销修改")}</button></div><p class="control-muted">${window.DafeiyuI18n.h("“保存并应用”先保存当前选择，再短暂停止本轮回复并切换麦克风。播放设备用于语音回复、摸摸和游戏语音；小屏字幕继续显示在 K20 GT。")}</p><p class="control-muted">${window.DafeiyuI18n.h("已保存麦克风：")}${E(g.values.inputName==='__default__'?window.DafeiyuI18n.t("跟随 Windows 默认设备"):g.values.inputName)} · ${E(g.values.inputApi)}<br>${window.DafeiyuI18n.h("已保存播放设备：")}${E(g.values.outputName==='__default__'?window.DafeiyuI18n.t("跟随 Windows 默认设备"):g.values.outputName)} · ${E(g.values.outputApi)}</p></section>`;}
function localVoiceLink(){
 const host=globalThis.location?.hostname;
 if(host&&!['127.0.0.1','localhost','[::1]','app'].includes(host))return '<span class="control-muted">'+window.DafeiyuI18n.h('语音控制在当前页面使用')+'</span>';
 return '<a class="button outline" href="http://127.0.0.1:18780/" target="_blank" rel="noopener">'+window.DafeiyuI18n.h('打开语音聊天 ↗')+'</a>';
}
function legacyVoice(s){const c=s.data.controls;if(!c.groups.voice?.available)return `<section class="card"><h2>${window.DafeiyuI18n.h("语音配置暂时不可用")}</h2><p role="status">${E(window.DafeiyuI18n.message(c.groups.voice?.error??window.DafeiyuI18n.t("配置文件无法读取，原文件已保留。")))}</p></section>`;const v=c.voice??{},info=c.voiceInfo??{},chat=info.conversation??{},rec=info.recognition??{},cfg=c.groups.voice.values;
if(c.voiceChannel==='live2d'){
 const I=window.DafeiyuI18n;
 return `<section class="section-header"><div><h2>${I.h('语音对话')}</h2><p>${I.h('后侧键按住说话')} · ${jump('phone','语音与电话')}</p></div>${localVoiceLink()}</section>
 <section class="card"><div class="control-section-heading"><h2>${I.h('Live2D 语音通道')}</h2><span class="tag">${I.h(v.streamReady?'已连接':'等待连接')}</span></div>
 <p>${I.h('语音消息、电话和视频陪玩共用 AuraBot 的桌宠后台会话。')}</p>
 <p>${I.h('正在使用的语音识别')} · ${E(v.asrProvider||'SenseVoice')}<br>${I.h('正在使用的回复音色')} · ${E(v.ttsVoice||v.ttsProvider||'—')}</p>
 <nav class="call-links">${jump('audio','麦克风与播放')} ${jump('tts','语音合成')} ${jump('captions','屏幕字幕')}</nav></section>
 <section class="card"><div class="control-section-heading"><h2>${I.h('语音运行状态')}</h2><span class="tag">${E(I.message(v.phase??'未运行'))}</span></div>
 ${v.channelError||v.error||v.nativeError?`<p role="status">${E(I.message(v.channelError||v.error||v.nativeError))}</p>`:''}
 <p class="control-muted" data-device-voice-status role="status">${E(deviceVoiceStatus(v))}</p>
 <div class="control-buttons">${voiceStart(s,v)}${button(s,'voice-interrupt',I.t('打断回复'),!v.reachable)}${button(s,'voice-stop',I.t('停止语音'),!v.reachable,'ghost')}</div></section>
 ${form(s,'voice',I.t('录音与回复设置'))}`;
}
const model=({'deepseek-flash':'DeepSeek Flash','deepseek-reasoner':'DeepSeek Reasoner','deepseek-chat':'DeepSeek Chat'})[chat.model]??chat.model??window.DafeiyuI18n.t("等待会话模型记录");
const provider=chat.provider==='deepseek-account'?window.DafeiyuI18n.t("DeepSeek 账号"):chat.provider??window.DafeiyuI18n.t("尚未读取");
const ttsProvider=v.reachable?v.ttsProvider:cfg.ttsProvider;
const asr=({'fish-buddy-sensevoice-int8':'SenseVoice Small · INT8','fish-buddy-sensevoice-fp32':'SenseVoice Small · FP32','fish-buddy-paraformer-int8':'Paraformer · INT8','qwen3-asr-1.7b':'Qwen3-ASR · 1.7B','doubao-ime':window.DafeiyuI18n.t("豆包输入法")})[v.asrProvider]??v.asrProvider??window.DafeiyuI18n.t("尚未启动");
return `<section class="section-header"><div><h2>${window.DafeiyuI18n.h("语音对话")}</h2><p>${window.DafeiyuI18n.h('后侧键按住说话')} · ${jump('phone','语音与电话')}</p></div>${localVoiceLink()}</section><section class="card voice-model"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("对话模型")}</h2><span class="tag">${E(chat.source??window.DafeiyuI18n.t("等待读取"))}</span></div><strong class="voice-model-name">${E(model)}</strong><p>${E(provider)} · ${E(chat.title??window.DafeiyuI18n.t("请先选择鱼搭子陪伴会话"))}${chat.reasoningEffort?window.DafeiyuI18n.t(" · 思考强度 ")+E(chat.reasoningEffort):''}</p><p class="control-muted">${window.DafeiyuI18n.h("语音接入这个 Harness 会话，模型随会话设置。本页读取会话最近一轮或待应用的模型，不会改动其他会话。")}</p></section><div class="control-runtime-grid"><section class="card"><h2>${window.DafeiyuI18n.h("正在使用的语音识别")}</h2><strong>${E(asr)}</strong><p class="control-muted">${E(v.asrDevice??'—')} ${window.DafeiyuI18n.h("· 语言：")}${rec.language==='zh'?window.DafeiyuI18n.t("中文"):E(rec.language??'—')}<br>${window.DafeiyuI18n.h("已保存档位：")}${E(cfg.fishBuddyModel??'—')} · ${cfg.fishBuddyFollowSelection?window.DafeiyuI18n.t("跟随鱼搭子选择"):window.DafeiyuI18n.t("使用本页指定档位")}<br>${window.DafeiyuI18n.h("实际档位：")}${E(v.asrModelTier??'—')}</p></section><section class="card"><h2>${v.reachable?window.DafeiyuI18n.t("正在使用的回复音色"):window.DafeiyuI18n.t("已保存的回复音色")}</h2><strong>${E(v.ttsVoice??(ttsProvider==='breezeblue'?info.tts?.cloudName:info.tts?.localName)??window.DafeiyuI18n.t("等待启动"))}</strong><p class="control-muted">${E(v.tts?.name??(ttsProvider==='breezeblue'?'BreezeBlue':window.DafeiyuI18n.t("本地 IndexTTS2")))} · ${v.tts?.streaming?window.DafeiyuI18n.t("实时音频流"):window.DafeiyuI18n.t("逐句生成")}<br>${v.streamReady?window.DafeiyuI18n.t("Harness 文字流已连接"):window.DafeiyuI18n.t("等待 Harness 文字流")} ${window.DafeiyuI18n.h("· 小屏同步显示字幕")}</p></section></div><section class="card"><div class="control-section-heading"><h2>${window.DafeiyuI18n.h("语音运行状态")}</h2><span class="tag">${E(window.DafeiyuI18n.message(v.phase??window.DafeiyuI18n.t("未运行")))}</span></div><p class="control-muted">${v.playback?.ready===false?window.DafeiyuI18n.t("播放设备正在恢复"):(v.ready?window.DafeiyuI18n.t("语音模型已加载"):window.DafeiyuI18n.t("语音模型未就绪"))} · ${v.nativeReady&&v.mouseBindingReady!==false?window.DafeiyuI18n.t("鼠标说话已就绪"):window.DafeiyuI18n.t("等待输入设备或鼠标连接")}</p>${v.error?`<p role="status">${E(window.DafeiyuI18n.message(v.error))}</p>`:''}${v.mouseBindingError?`<p role="status">${E(window.DafeiyuI18n.message(v.mouseBindingError))}</p>`:''}<p class="control-muted" data-device-voice-status role="status">${E(deviceVoiceStatus(v))}</p>${cfg.asrProvider==='fish-buddy'&&rec.selectedInstalled===false?`<p role="status">${window.DafeiyuI18n.h("当前识别模型")} ${E(rec.effectiveName??rec.effectiveTier)} ${window.DafeiyuI18n.h("的文件未找到，请先在鱼搭子中下载对应模型，或选择已安装的识别引擎。")}</p>`:''}<div class="control-buttons">${voiceStart(s,v)}${button(s,'voice-interrupt',window.DafeiyuI18n.t("打断回复"),!v.reachable)}${button(s,'voice-stop',window.DafeiyuI18n.t("停止语音"),!v.reachable,'ghost')}</div></section>${form(s,'voice',window.DafeiyuI18n.t("识别与回复设置"))}<div class="note-panel">${window.DafeiyuI18n.h("麦克风和声音播放设备在“麦克风与播放”中设置。识别引擎和线程保存并应用后生效；回复音色在“语音合成”中设置；未应用前，上方仍显示实际运行中的模型。")}</div>`;}
function speaker(s){
 const {h,t}=window.DafeiyuI18n,c=s.data.controls,r=c.runtime;
 const fresh=Number.isFinite(r?.at)&&Date.now()-r.at>=0&&Date.now()-r.at<10000;
 const mode=fresh?r.screenMode??c.sync.mode:c.sync.mode;
 const pageNames={fish:t('大肥鱼动画'),status:t('任务状态'),balance:t('DeepSeek 余额'),clock:t('时间'),affinity:t('好感度')};
 const modes=[['pages',t('自定义快捷页')],['manual',t('浏览音箱内置主题')],['animation',t('动画与任务跟随')],['text',t('仅状态文字')]];
 const saved=c.groups.screenPages.values;
 const order=Object.keys(pageNames).filter(key=>saved[key]!==false).map(key=>pageNames[key]);
 const page=fresh?pageNames[r.shortcutPage]:null;
 const pending=modes.some(([value])=>s.busy.has('control-run-screen-'+value));
 const screen=c.sync.screen,unavailable=!c.sync.running||c.sync.ready===false||screen?.ready===false||pending;
 const options=modes.map(([value,label])=>`<label class="speaker-mode-option"><input type="radio" name="speaker-display-mode" data-action="control-screen-mode" value="${value}" ${value===mode?'checked':''} ${unavailable?'disabled':''}><span>${E(label)}</span></label>`).join('');
 return `<section class="section-header"><div><h2>${h('音箱屏幕与快捷页')}</h2><p>${h('单击灯光图标键切屏，双击切灯效，长按约 1.5 秒开关屏幕及灯光。')}</p></div></section>
  <section class="card">
   ${screen?.ready===false?`<p class="control-muted" role="status">${E(window.DafeiyuI18n.message(String(screen.error||'音箱屏幕未就绪，正在单独重连。').split(/\r?\n/,1)[0]))}</p>`:''}
   <fieldset class="speaker-mode-options"><legend>${h('显示模式')}</legend>${options}</fieldset>
   ${mode==='pages'?`<p>${h('当前快捷页：')}${E(page??t('等待回执'))}</p><p class="control-muted">${h('轮换顺序')} · ${E(order.join(' → '))}</p>`:''}
   ${fresh&&r.heldScreen&&mode==='manual'?`<p>${h('当前主题：')}${r.heldScreen.theme===8?t('大肥鱼自定义画面'):t('内置主题 ')+(r.heldScreen.theme+1)}</p>`:''}
   <div class="control-buttons"><strong>${h('快捷操作')}</strong>
    ${button(s,'screen-page-next',t('下一页'),unavailable||mode!=='pages')}
    ${button(s,'screen-animation-next',t('随机换一段动画'),unavailable||mode==='manual')}
    ${button(s,'device-default-theme',t('恢复默认大肥鱼主题'),!c.sync.running)}
   </div>${r?.screenCycleError?`<p role="status">${E(window.DafeiyuI18n.message(r.screenCycleError))}</p>`:''}
  </section>
  ${speakerPreviews(s)}
  <details class="control-details"><summary>${h('高级：固件内置主题与实体键行为')}</summary>
   <p>${h('至少保留两页；从时间页返回动画可能需要重新上传，请等待设备回执。动画每天零点和电脑重启后随机轮换，也可手动换片。屏幕空闲并显示动画页时才会上传。')}</p>
   <section class="section-header"><div><h2>${h('实体键循环清单')}</h2><p>${h('以下设置用于浏览固件内置主题；至少保留两组和大肥鱼动画。')}</p></div></section>
   ${form(s,'screenCycle',t('固件屏幕主题'))}
   <div class="note-panel">${h('实体键由固件先切内置主题，仍可能短暂闪现；软件下一页或鼠标“音箱下一页”动作直接切功能页，可避开这一步。当前固件只验证出一个自定义动画存储区，五种功能页由电脑联动管理，需要本机后台运行。')}</div>
  </details>`;
}
function captions(s){const c=s.data.controls,last=c.runtime?.subtitle,status=c.sync.ready&&last&&last.active!==false&&Date.now()-last.at>=0&&Date.now()-last.at<15000?last:null;
return `<section class="section-header"><div><h2>${window.DafeiyuI18n.h("语音字幕")}</h2><p>${window.DafeiyuI18n.h("长句滚动或完整分页，按语音进度显示。字幕按完整一句安排；超长句连续分段，前一段看完再切换。")}</p></div>${button(s,'subtitle-preview',window.DafeiyuI18n.t("试用长字幕"),!c.sync.running)}</section><section class="card caption-preview"><small>${window.DafeiyuI18n.h("设备字幕状态")}</small><strong>${status?(status.scrolling?window.DafeiyuI18n.t("正在使用原生左滚动"):window.DafeiyuI18n.t("静态／分页显示")):window.DafeiyuI18n.t("等待语音字幕")}</strong><p class="control-muted">${status?.nativeUnsupported?window.DafeiyuI18n.t("当前固件未确认滚动设置，已采用完整分页。"):window.DafeiyuI18n.t("支持短句静态、长句左滚和完整分页。语音保持连续播放，字幕按阅读时长顺序展示，末句不会随声音结束立即消失。")} ${window.DafeiyuI18n.h("设备使用内置字库，未提供导入得意黑字体的入口。")}</p>${c.voice?.captionError?`<p role="status">${window.DafeiyuI18n.h("字幕显示异常：")}${E(window.DafeiyuI18n.message(c.voice.captionError))}</p>`:""}</section><div class="control-settings-grid">${form(s,'subtitles',window.DafeiyuI18n.t("屏幕字幕"))}</div>`;}
function voice(s){return window.DafeiyuCompanion?.render(s)??legacyVoice(s);}
function render(s,renderDevices){
 const c=s.data.controls;
 if(tab==='wallpaper')return window.DafeiyuWallpapers.render(s);
 if(tab==='live2d')return window.DafeiyuLive2d.render(s);
 if(tab==='voice'&&(!c||c.error)&&window.DafeiyuCompanion)return window.DafeiyuCompanion.render(s);
 const restart='<button class="button" data-action="plugin-restart">'+window.DafeiyuI18n.h('重启插件')+'</button>';
 if(!c||c.error)return '<section class="card"><h2>'+window.DafeiyuI18n.h('后台状态读取失败')+'</h2><p>'+E(window.DafeiyuI18n.message(c?.error??''))+'</p>'+restart+'</section>';
 const sync=c.sync??{},startup=sync.startup;
 const starting=startup?.phase==='starting'&&Date.now()-startup.at<45000;
 const needsRecovery=c.deviceLink?.enabled!==false&&!sync.ready;
 const recentStartupFailure=startup?.phase==='failed'&&Number.isFinite(startup.at)&&Date.now()-startup.at>=0&&Date.now()-startup.at<120000;
 const reason=sync.connection?.error??(recentStartupFailure?startup.message:null)??sync.supervisor?.connectionRepair?.error??({'stale-process':window.DafeiyuI18n.t('联动心跳已过期，请恢复联动'),'process-identity-unknown':window.DafeiyuI18n.t('无法确认旧进程身份，请查看运行诊断')})[sync.reason]??sync.reason;
 const result=s.data.recovery;
 const failures=['partial','failed'].includes(result?.phase)&&Array.isArray(result.results)?result.results.filter(item=>item?.ok===false&&typeof item.message==='string'):[];
 const failureDetails=failures.length?'<ul class="recovery-errors">'+failures.map(item=>'<li>'+E(window.DafeiyuI18n.message(item.message))+'</li>').join('')+'</ul>':'';
 const recovery=needsRecovery?
  '<section class="note-panel control-recovery" role="status"><strong>'+window.DafeiyuI18n.h(starting?'正在启动设备联动':sync.reconnecting?'正在自动恢复设备联动':'设备联动需要恢复')+'</strong><p>'+E(window.DafeiyuI18n.message(reason??window.DafeiyuI18n.t('网页仍可设置参数；恢复联动后可试用灯光和屏幕。')))+'</p>'+failureDetails+'<div class="control-buttons">'+button(s,'sync-start',window.DafeiyuI18n.t('恢复联动'),starting)+restart+'</div></section>':'';
 const voiceTabs=['phone','live2d','voice','tts','audio','captions'];
 const lightTabs=['states','balance','notices','devices'];
 const group=voiceTabs.includes(tab)?voiceTabs:lightTabs.includes(tab)?lightTabs:[];
 const subnav=group.length?'<div class="control-subtabs" data-section="'+(lightTabs.includes(tab)?'lighting':'voice')+'" role="navigation" aria-label="'+window.DafeiyuI18n.h('当前功能分类')+'">'+group.map(key=>'<button class="'+(tab===key?'selected':'')+'" aria-current="'+(tab===key?'page':'false')+'" data-action="control-tab" data-tab="'+key+'">'+titles[key]+'</button>').join('')+'</div>':'';
 const required={phone:['phone'],bindings:['bindings'],states:['taskLights'],balance:['balance'],speaker:['screenPages'],audio:['audio'],voice:window.DafeiyuCompanion?[]:['voice'],captions:['subtitles']};
 const broken=(required[tab]??[]).find(key=>!c.groups?.[key]?.available||!c.groups[key].values);
 let body;
 if(broken)body='<section class="card"><h2>'+window.DafeiyuI18n.h("配置暂时不可用")+'</h2><p>'+E(window.DafeiyuI18n.message(c.groups?.[broken]?.error??''))+'</p></section>';
 else try{body=({home,bindings,live2d:state=>window.DafeiyuLive2d.render(state),states:stateLights,notices:state=>form(state,'notifications',window.DafeiyuI18n.t('任务提示音')),voice,tts:state=>window.DafeiyuTts.render(state),audio,captions,balance,speaker,phone,devices:renderDevices})[tab](s);}
 catch(error){body='<section class="card"><h2>'+window.DafeiyuI18n.h('当前功能暂时不可用')+'</h2><p role="status">'+E(window.DafeiyuI18n.message(error.message))+'</p>'+restart+'</section>';}
 return subnav+(tab==='home'?deviceLinkSwitch(s):'')+recovery+(sync.settingsError?'<div class="note-panel" role="status">'+E(window.DafeiyuI18n.message(sync.settingsError))+'</div>':'')+body;
}
function edit(event,s){if(window.DafeiyuWallpapers?.edit(event,s))return;if(window.DafeiyuLive2d?.edit(event,s))return;if(window.DafeiyuCompanion?.edit(event,s))return;if(window.DafeiyuTts?.edit?.(event,s))return;const el=event.target,group=el.dataset.controlGroup;
if(el.id==='screen-weather-query'){weatherQuery=el.value;return;}
if(!group||group==='balance'&&el.name==='enabled')return;if(!drafts[group]){const m=s.data.controls.groups[group];drafts[group]={revision:m.revision,values:structuredClone(m.values),original:structuredClone(m.values)};}
if(el.dataset.deviceId){const list=s.data.controls.syncInventory?.devices??[],ids=drafts[group].values.deviceIds??list.filter(d=>d.selected).map(d=>d.id);drafts[group].values.deviceIds=el.checked?[...new Set([...ids,el.dataset.deviceId])]:ids.filter(id=>id!==el.dataset.deviceId);}
else if(el.dataset.audioDirection){if(!el.value)return;const d=JSON.parse(el.value),direction=el.dataset.audioDirection;drafts[group].values[direction+'Name']=d.name;drafts[group].values[direction+'Api']=d.api;}
else{const value=el.type==='checkbox'?el.checked:el.type==='number'||group==='subtitles'&&el.name==='captionFontSize'?Number(el.value):el.value;if(group==='taskLights'&&el.name.includes('.')){const [key,field]=el.name.split('.');drafts[group].values[key][field]=value;if(field==='color')el.closest('article').querySelector('h3 i').style.background=value;}else drafts[group].values[el.name]=value;}
const keyPreview=el.closest?.('[data-shortcut-editor]')?.querySelector?.('[data-binding-preview]');
if(keyPreview)keyPreview.innerHTML=shortcutCaps(el.value);
if(group==='bindings'){shortcutFeedback('快捷键已修改，点击保存后生效。',el);return;}
const f=el.closest('.control-form');
if(group==='phone'&&['autoEnabled','retryCount','mouseHoldEnabled','deepAnswer'].includes(el.name)) updatePhoneGroups(f,drafts.phone.values);
const apply=f.querySelector('[data-action="control-save"]')??f.querySelector('[data-action="control-audio-apply"]');
apply.disabled=false;
if(group==='audio')apply.textContent=window.DafeiyuI18n.t("保存并应用");
if(group==='voice'){
 const restart=f.querySelector('[data-command="voice-restart"]');
 if(restart)restart.hidden=true;
}f.querySelector('[data-action="control-reset"]').disabled=false;f.querySelector('.tag').textContent=window.DafeiyuI18n.t("有未保存修改");f.querySelector('.tag').classList.add('amber');}
async function save(ctx,group){const draft=drafts[group];if(!draft)return null;const submitted=JSON.stringify(draft.values);try{const result=await ctx.request('/controls/settings',{group,revision:draft.revision,values:group==='balance'?{fullAmount:draft.values.fullAmount,brightness:draft.values.brightness,...(draft.values.gt75Layout?{gt75Layout:draft.values.gt75Layout}:{})}:draft.values});if(drafts[group]===draft&&JSON.stringify(draft.values)===submitted)delete drafts[group];else if(drafts[group]){const latest=(await ctx.request('/state')).controls.groups[group];drafts[group].revision=latest.revision;drafts[group].original=structuredClone(latest.values);}return result;}catch(error){if(group==='bindings'&&error.message.includes('已恢复原绑定')){const latest=(await ctx.request('/state')).controls.groups.bindings;if(JSON.stringify(latest.values)===JSON.stringify(draft.original))draft.revision=latest.revision;}throw error;}}
function action(button,ctx){if(window.DafeiyuWallpapers?.action(button,ctx))return true;if(window.DafeiyuLive2d?.action(button,ctx,lastState))return true;if(window.DafeiyuCompanion?.action(button,ctx,lastState))return true;if(window.DafeiyuTts?.action?.(button,ctx))return true;const a=button.dataset.action;if(!a?.startsWith('control-'))return false;
if(a==='control-shortcuts-reset'){cancelShortcutRecording();delete drafts.bindings;delete shortcutDrafts.voice;delete shortcutDrafts.phone;shortcutNotice='';ctx.render();return true;}
if(a==='control-shortcuts-save'){void ctx.perform('control-shortcuts-save',async()=>{cancelShortcutRecording();const messages=[];for(const group of ['bindings','phone','voice']){try{if(group==='bindings'){if(drafts.bindings)messages.push((await save(ctx,group)).message);}else{const draft=shortcutDrafts[group];if(draft){const value=JSON.stringify(draft.values);const result=await ctx.request('/controls/settings',{group,revision:draft.revision,values:draft.values});messages.push(result.message);if(shortcutDrafts[group]===draft&&JSON.stringify(draft.values)===value)delete shortcutDrafts[group];}}}catch(error){throw Error((messages.length?window.DafeiyuI18n.t('部分设置已保存；未完成的修改已保留。')+' ':'')+window.DafeiyuI18n.message(error.message));}}shortcutNotice='快捷键已保存。';return {message:messages.join('；')||window.DafeiyuI18n.t('快捷键已保存。')};},r=>r.message);return true;}
if(a==='control-tab'){ctx.navigate('control/'+button.dataset.tab);return true;}
if(a==='control-screen-mode'){
 const mode=button.value;
 if(button.checked&&['pages','manual','animation','text'].includes(mode)){
  const c=lastState.data.controls,r=c.runtime;
  const current=r?.at<=Date.now()&&Date.now()-r.at<10000?r.screenMode??c.sync.mode:c.sync.mode;
  if(mode!==current)void ctx.perform('control-run-screen-'+mode,()=>ctx.request('/controls/action',{action:'screen-'+mode}),result=>result.message);
 }
 return true;
}
if(a==='control-light-select'||a==='control-light-edit'){
 const key=button.dataset.state;
 if(!['IDLE','BUSY','ATTENTION'].includes(key))return true;
 selectedLight=key;
 if(a==='control-light-edit'){
  if(expandedLights.has(key))expandedLights.delete(key);else expandedLights.add(key);
 }
 ctx.render();
 document.querySelector('[data-action="'+a+'"][data-state="'+key+'"]')?.focus?.({preventScroll:true});
 return true;
}
if(a==='control-reset'){delete drafts[button.dataset.group];ctx.render();return true;}
if(a==='control-save'){const group=button.dataset.group;if(!drafts[group])return true;
 const invalid=[...button.closest('.control-form').querySelectorAll('input,select,textarea')].find(e=>!e.validity.valid);
 if(invalid){
  if(group==='taskLights'){
   selectedLight=invalid.name.split('.')[0];expandedLights.add(selectedLight);ctx.render();
   document.querySelector('.light-fields [name="'+invalid.name+'"]')?.reportValidity();
  }else{
   const detail=invalid.closest('details');if(detail)detail.open=true;invalid.reportValidity();
  }
  return true;
 }
 void ctx.perform('control-save-'+group,async()=>{
 const result=await save(ctx,group);
 if(group!=='voice')return result;
 try{return await ctx.request('/controls/action',{action:'voice-restart'});}
 catch(error){throw new Error(window.DafeiyuI18n.t("设置已保存，尚未应用：")+error.message);}
},r=>r.message);}
else if(a==='control-preview'){const v=drafts.taskLights?.values??ctx.data?.controls?.groups.taskLights.values;const style=v?.[button.dataset.state]??JSON.parse(JSON.stringify(lastState.data.controls.groups.taskLights.values[button.dataset.state]));void ctx.perform('control-run',()=>ctx.request('/controls/preview',{state:button.dataset.state,style}),r=>r.message);}
else if(a==='control-balance-toggle'){const enabled=button.checked;balancePending=enabled;void ctx.perform('balance-toggle',async()=>{try{return await ctx.request('/controls/action',{action:enabled?'balance-enable':'balance-disable'});}finally{balancePending=null;}},r=>r.message);}
else if(a==='control-audio-advanced'){audioAdvanced=!audioAdvanced;ctx.render();}
else if(a==='control-audio-refresh')void ctx.perform('control-run',()=>ctx.request('/controls/audio-devices',{operation:'refresh'}),window.DafeiyuI18n.t("音频设备已重新检测"));
else if(a==='control-audio-test'){const v=drafts.audio?.values??lastState.data.controls.groups.audio.values;void ctx.perform('control-run',()=>ctx.request('/controls/audio-devices',{operation:'test',values:{outputName:v.outputName,outputApi:v.outputApi}}),r=>r.message);}
else if(a==='control-audio-apply')void ctx.perform('control-run',async()=>{const saved=await save(ctx,'audio');
try{return await ctx.request('/controls/action',{action:'audio-apply'});}
catch(error){if(!saved)throw error;throw new Error(window.DafeiyuI18n.t("设备选择已保存，尚未应用：")+error.message);}},r=>r.message);
else if(a==='control-weather-search'){
 weatherNotice='';weatherQuery=document.querySelector('#screen-weather-query')?.value.trim()??'';
 weatherResults=null;
 void ctx.perform('weather',async()=>{
  const result=await ctx.request('/controls/weather',{operation:'search',query:weatherQuery});weatherResults=result.locations;
 });
}
else if(a==='control-weather-bind')void ctx.perform('weather',async()=>{
 const result=await ctx.request('/controls/weather',{operation:'bind',id:Number(button.dataset.id)});
 weatherNotice=result.message;weatherResults=null;return result;
},r=>r.message);
else if(a==='control-weather-toggle')void ctx.perform('weather',async()=>{const result=await ctx.request('/controls/weather',{operation:'toggle',enabled:button.dataset.enabled==='true'});weatherNotice=result.message;return result;},r=>r.message);
else if(a==='control-run'&&button.dataset.command==='voice-restart'&&drafts.voice){chooseVoiceRepair=true;ctx.render();}
else if(a==='control-repair-edit'){
 chooseVoiceRepair=false;
 const focusEditor=()=>document.getElementById?.('ctl-voice-asrProvider')?.focus();
 if(tab==='voice'){ctx.render();focusEditor();}
 else{window.addEventListener?.('hashchange',()=>requestAnimationFrame(focusEditor),{once:true});ctx.navigate('control/voice');}
}
else if(a==='control-repair-saved'){chooseVoiceRepair=false;void ctx.perform('control-run-voice-restart',()=>ctx.request('/controls/action',{action:'voice-restart'}),r=>r.message);}
else if(a==='control-link-toggle')void ctx.perform('device-link',()=>ctx.request('/controls/action',{action:button.dataset.command}),r=>r.message);
else if(a==='control-run')void ctx.perform('control-run-'+button.dataset.command,()=>ctx.request('/controls/action',{action:button.dataset.command}),r=>r.message);return true;}
function rebaseBalance(meta){const d=drafts.balance;if(!d||d.revision===meta.revision)return;if(['fullAmount','brightness','gt75Layout'].every(k=>d.original[k]===meta.values[k])){d.revision=meta.revision;d.original={...meta.values};d.values.enabled=meta.values.enabled;}}
function deviceVoiceStatus(v){const job=v?.deviceCommand?.job;return job?window.DafeiyuI18n.t("设备动画：")+(job.label??job.phase)+(job.error?' · '+job.error:''):window.DafeiyuI18n.t("支持语音制作、应用和停止设备动画；普通聊天继续使用当前对话模型。");}
function reconcile(s){const status=document.querySelector('[data-device-voice-status]');if(status)status.textContent=deviceVoiceStatus(s.data.controls?.voice);
const c=s.data.controls,meta=c?.groups?.balance;if(!meta?.available)return;rebaseBalance(meta);const el=document.querySelector('[data-action="control-balance-toggle"]');if(el&&balancePending===null)el.checked=meta.values.enabled;
 const page=document.querySelector('[data-balance-page]');if(page?.classList){const available=!!balanceAvailability(c);page.classList.toggle('is-unavailable',!available);const gate=page.querySelector('.balance-settings-gate');if(gate)gate.disabled=!available;const refresh=page.querySelector('[data-command="balance-refresh"]');if(refresh)refresh.disabled=!available||!c.sync.running;const preview=page.querySelector('[data-balance-live]');if(preview)preview.innerHTML=balanceLive(s);}
}
function capturedAnswerKey(event){
 if(event.repeat||event.ctrlKey||event.altKey||event.shiftKey||event.metaKey)return null;
 const code=event.code??'';
 if(/^Key[A-Z]$/.test(code))return code.slice(3);
 if(/^Digit[0-9]$/.test(code))return code.slice(5);
 if(/^F([1-9]|1[0-2])$/.test(code))return code;
 return ({Space:'Space',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down'})[code]??null;
}
document.addEventListener?.('keydown',event=>{
 const el=event.target;if(!el?.matches?.('[data-debug-key-input]')||el.disabled)return;
 event.preventDefault();event.stopPropagation();
 if(event.key==='Escape'){el.setCustomValidity('');el.blur();return;}
 const key=capturedAnswerKey(event);
 if(!key){el.setCustomValidity(window.DafeiyuI18n.t('请按一个字母、数字、F1～F12、空格或方向键，不要带组合键'));el.reportValidity();return;}
 el.setCustomValidity('');el.value=key;edit({target:el},lastState);el.blur();
},true);
let lastState;
document.querySelector('.brand small').textContent=window.DafeiyuI18n.t("管理后台");
document.querySelector('.sidebar-bottom').innerHTML=window.DafeiyuI18n.markup("<span class=\"small-dot\"></span> 本机控制台<small>语音 · 陪伴 · 设备<br>日常设置，在这里调好。</small>");
window.DafeiyuControls={capturedAnswerKey,capturedShortcut,shortcutKeydown,beginShortcutRecording,cancelShortcutRecording,setShortcutRequest:request=>{shortcutRequest=request;},shortcutClick:event=>{const el=event.target?.closest?.('[data-shortcut-input]');if(!el||el.disabled||!['bindings','voice','phone'].includes(el.dataset.shortcutGroup))return false;void beginShortcutRecording(el);return true;},reconcile,voiceStart,setTab:key=>{cancelShortcutRecording();tab=Object.hasOwn(titles,key)?key:'home';},getTab:()=>tab,title:()=>titles[tab],render:(s,renderDevices)=>{lastState=s;return render(s,renderDevices);},edit,action};
})();
