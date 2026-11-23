import fs from 'node:fs/promises';

export const DEFAULT_BINDINGS={pet:'Ctrl+Alt+F9',gameToggle:'Ctrl+Alt+G',gameReplay:'Ctrl+Alt+R',color1:'Ctrl+Alt+1',color2:'Ctrl+Alt+2',color3:'Ctrl+Alt+3',color4:'Ctrl+Alt+4',mouseFrontAction:'game-toggle',mouseRearAction:'pet'};
export const TASK_STATES=['IDLE','THINKING','WORKING','WAITING','SUCCESS','ERROR','DISCONNECTED','BUSY','ATTENTION'];
export const SIMPLE_STATES=['IDLE','BUSY','ATTENTION'];
export const LIGHT_EFFECTS=['steady','breathing','center-breathing','expansion','wave','rainbow'];
export function simpleTaskState(raw){return ['THINKING','WORKING','BUSY'].includes(raw)?'BUSY':['WAITING','ERROR','DISCONNECTED','ATTENTION'].includes(raw)?'ATTENTION':'IDLE';}
export const DEFAULT_LIGHTS={simple:true,separateBusy:false,phaseHoldMs:1800,
  IDLE:{label:'待命中',color:'#00AAFF',brightness:20,effect:'steady'},
  THINKING:{label:'思考中',color:'#00E5FF',brightness:20,effect:'breathing'},
  WORKING:{label:'工作中',color:'#FFD000',brightness:20,effect:'breathing'},
  WAITING:{label:'等你确认',color:'#FF8800',brightness:25,effect:'breathing'},
  SUCCESS:{label:'完成啦',color:'#00FF66',brightness:25,effect:'breathing'},
  ERROR:{label:'遇到问题',color:'#FF2448',brightness:25,effect:'breathing'},
  DISCONNECTED:{label:'连接中',color:'#9B83FF',brightness:15,effect:'steady'},
  BUSY:{label:'处理中',color:'#00E5FF',brightness:20,effect:'breathing'},
  ATTENTION:{label:'需要你',color:'#FF8800',brightness:25,effect:'breathing'}};
export const MOUSE_ACTIONS=['pet','game-toggle','game-replay','fireworks-demo','screen-page-next','none'];
export function shortcut(value){
  if(typeof value!=='string')throw Error('请输入快捷键组合。');
  const pieces=value.replace(/\s/g,'').split('+'),key=pieces.pop()?.toUpperCase();
  const mods=new Set(pieces.map(x=>({ctrl:'Ctrl',control:'Ctrl',alt:'Alt',shift:'Shift',win:'Win'})[x.toLowerCase()]));
  if(!mods.size||mods.has(undefined)||mods.size!==pieces.length||!/^([A-Z0-9]|F([1-9]|1\d|2[0-4]))$/.test(key))throw Error('快捷键需含 Ctrl、Alt、Shift 或 Win，并搭配字母、数字或 F1～F24。');
  if(mods.has('Win')||mods.size===1&&mods.has('Alt'))throw Error('请使用 Ctrl 或 Shift 组合，避免占用系统快捷键。');
  const normalized=[...['Ctrl','Alt','Shift'].filter(x=>mods.has(x)),key].join('+');
  if(['CTRL+C','CTRL+V','CTRL+X','CTRL+Z','CTRL+A','CTRL+S','CTRL+W','CTRL+F','CTRL+T','CTRL+N','CTRL+O','CTRL+P','CTRL+R','CTRL+H'].includes(normalized.toUpperCase()))throw Error('请避开常用的编辑或系统快捷键。');
  return normalized;
}
export function validateBindings(values){
  const result={...DEFAULT_BINDINGS,...values},seen=new Map();
  for(const key of Object.keys(values))if(!Object.hasOwn(DEFAULT_BINDINGS,key))throw Error('未知的按键设置。');
  for(const key of Object.keys(DEFAULT_BINDINGS)){
    if(key.startsWith('mouse')){if(!MOUSE_ACTIONS.includes(result[key]))throw Error('鼠标动作无效。');continue;}
    result[key]=shortcut(result[key]);if(seen.has(result[key]))throw Error('两个功能不能使用相同的快捷键。');seen.set(result[key],key);
  }
  // Existing on-board macros keep stable ingress chords; the dispatch action is configurable.
  for(const [chord,action] of [['Ctrl+Alt+G',result.mouseFrontAction],['Ctrl+Alt+F9',result.mouseRearAction]]){
    const key=seen.get(chord),kind={pet:'pet',gameToggle:'game-toggle',gameReplay:'game-replay'}[key];
    if(key&&kind!==action)throw Error(chord+' 是现有鼠标宏入口，请为该功能选择其他快捷键，或保持鼠标动作一致。');
  }
  return result;
}
export function validateLights(values){
  const result=structuredClone(DEFAULT_LIGHTS);
  for(const [key,value] of Object.entries(values)){
    if(!Object.hasOwn(result,key))throw Error('未知的状态灯光设置。');
    if(key==='simple'||key==='separateBusy'){if(typeof value!=='boolean')throw Error('状态区分开关无效。');result[key]=value;}
    else if(key==='phaseHoldMs'){if(!Number.isInteger(value)||value<500||value>10000)throw Error('灯光防抖时长需为 500～10000 毫秒。');result[key]=value;}
    else result[key]=validateStyle({...result[key],...value});
  }
  return result;
}
export function validateStyle(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(x=>!['color','brightness','effect','label','speed','colorMode'].includes(x)))throw Error('状态灯光参数无效。');
  if(!/^#[\da-f]{6}$/i.test(value.color)||!Number.isInteger(value.brightness)||value.brightness<1||value.brightness>100||!LIGHT_EFFECTS.includes(value.effect)||typeof value.label!=='string'||!value.label.trim()||Buffer.byteLength(value.label,'utf8')>48||/[\x00-\x1f]/.test(value.label)||value.speed!==undefined&&(!Number.isInteger(value.speed)||value.speed<1||value.speed>5)||value.colorMode!==undefined&&!['solid','rainbow'].includes(value.colorMode))throw Error('请检查颜色、亮度、灯效速度及屏幕文字（最多 48 字节）。');
  return {...value,color:value.color.toUpperCase()};
}
export class StableTaskState{
  constructor(clock=Date.now){this.clock=clock;this.current=null;this.changedAt=0;this.candidate=null;this.since=0;}
  select(raw,{simple=false,separateBusy=true,phaseHoldMs=1800}={}){
    const next=simple?simpleTaskState(raw):!separateBusy&&['THINKING','WORKING'].includes(raw)?'BUSY':raw,now=this.clock();
    if(next===this.current){this.candidate=null;return this.current;}
    if(!this.current||!['THINKING','WORKING','BUSY'].includes(next)||!['THINKING','WORKING','BUSY'].includes(this.current)){this.current=next;this.changedAt=now;this.candidate=null;return next;}
    if(this.candidate!==next){this.candidate=next;this.since=now;}
    if(now-this.since>=Math.min(600,phaseHoldMs)&&now-this.changedAt>=phaseHoldMs){this.current=next;this.changedAt=now;this.candidate=null;}
    return this.current;
  }
}
export class LiveControlSettings{
  constructor(root=new URL('./',import.meta.url)){this.root=root;this.lights=structuredClone(DEFAULT_LIGHTS);this.version=null;this.last=0;this.error=null;}
  async poll(){
    if(Date.now()-this.last<400)return false;this.last=Date.now();
    try{const value=JSON.parse((await fs.readFile(new URL('task-lights.json',this.root),'utf8')).replace(/^\uFEFF/,''));if(value.controlVersion===this.version)return false;const {controlVersion,...config}=value;this.lights=validateLights(config);this.version=controlVersion;this.error=null;return true;}
    catch(e){if(e.code!=='ENOENT')this.error=e.message;return false;}
  }
}
