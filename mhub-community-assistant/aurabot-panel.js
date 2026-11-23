// Aurabot custom panel body: React, h, ui and call are supplied by Aurabot.
const {useState,useEffect}=React;
return function MhubCompanionPanel(){
 const [status,setStatus]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let disposed=false;call('/status').then(value=>{if(!disposed)setStatus(value);}).catch(e=>{if(!disposed)setError(e.message);});return()=>{disposed=true;};},[]);
 return h(ui.Card,{title:'迈从大肥鱼插件'},
   h('p',null,'已共用原迈从后台、社区资料和设备控制器。灯光、音箱屏幕、余额条、鼠标宏、语音与电话继续在原后台设置。'),
   h('p',{className:'ab-note'},status?.dryRun?'Aurabot 当前处于试运行：QQ 已连接时也不会发送回复。需在 Aurabot 聊天设置中关闭试运行，才会收到 QQ 回复；试运行不会阻止本机工具操作。':status?.enabled?'Aurabot 已启用。主人可在 QQ 私聊中询问桌面状态、试用灯光或查询社区配置。':error?'暂时无法读取模块状态：'+error:'正在读取 Aurabot 状态…'),
   h('a',{href:'http://127.0.0.1:18782/api/mhub-community/panel',target:'_blank',rel:'noopener noreferrer',className:'ab-btn'},'打开迈从大肥鱼插件'),
   h('p',{className:'ab-small ab-muted'},'可试着说：“看看我的桌面状态”、“试用八秒待命灯光”、“查查 Ace 75 的社区灯效”。只对主人私聊开放，群聊不控制桌面。'));
};
