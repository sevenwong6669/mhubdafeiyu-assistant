import {shortcut,DEFAULT_BINDINGS} from '../control-settings.mjs';
export const DEFAULT_PHONE={enabled:true,autoEnabled:false,startTime:'09:00',endTime:'22:00',dailyLimit:3,ringSeconds:30,retryCount:1,retryMinutes:5,minGapMinutes:60,onlyWhenIdle:true,mouseHoldEnabled:true,mouseHoldMs:1000,hotkey:'Ctrl+Alt+F8',silenceMs:1000,ringVolume:25,deepAnswer:true,answerDepthMm:4,debugAnswerKey:'F11'};
export function validatePhone(value,base=DEFAULT_PHONE){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_PHONE,k)))throw Error('电话设置包含未知参数');
 const v={...base,...value};
 for(const k of ['enabled','autoEnabled','onlyWhenIdle','mouseHoldEnabled','deepAnswer'])if(typeof v[k]!=='boolean')throw Error('电话开关格式不正确');
 for(const k of ['startTime','endTime'])if(typeof v[k]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v[k]))throw Error('来电时间请使用 24 小时制');
 for(const [k,min,max] of [['dailyLimit',1,20],['ringSeconds',10,90],['retryCount',0,3],['retryMinutes',1,120],['minGapMinutes',5,1440],['mouseHoldMs',500,3000],['silenceMs',400,5000],['ringVolume',0,60]])if(!Number.isInteger(v[k])||v[k]<min||v[k]>max)throw Error('电话参数超出范围：'+k);
 if(!Number.isFinite(v.answerDepthMm)||v.answerDepthMm<1||v.answerDepthMm>4)throw Error('接听行程需为 1～4 mm');
 if(typeof v.debugAnswerKey!=='string'||!/^([A-Z0-9]|F([1-9]|1[0-2])|Space|Left|Right|Up|Down)$/.test(v.debugAnswerKey))throw Error('调试接听键无效');
 v.hotkey=shortcut(v.hotkey);if(Object.values(DEFAULT_BINDINGS).includes(v.hotkey))throw Error('电话快捷键与现有互动入口冲突');return v;
}
export const phoneActive=s=>['dialing','incoming','connecting','connected'].includes(s?.phase);
export function withinWindow(date,start,end){const n=date.getHours()*60+date.getMinutes(),m=s=>Number(s.slice(0,2))*60+Number(s.slice(3));const a=m(start),b=m(end);return a===b||a<b?n>=a&&n<b||a===b:n>=a||n<b;}
export const dayKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export class PhoneSchedule{
 constructor(saved={},clock=()=>new Date()){this.clock=clock;this.data={date:'',count:0,nextAt:0,retryAt:0,retries:0,...saved};}
 roll(){const date=dayKey(this.clock());if(this.data.date!==date)this.data={date,count:0,nextAt:0,retryAt:0,retries:0};}
 due(settings,busy=false){this.roll();const now=this.clock();if(!settings.enabled||!settings.autoEnabled||busy&&settings.onlyWhenIdle||!withinWindow(now,settings.startTime,settings.endTime)||this.data.count>=settings.dailyLimit)return false;if(this.data.retryAt)return now.getTime()>=this.data.retryAt;if(!this.data.nextAt)this.data.nextAt=now.getTime()+settings.minGapMinutes*60000;return now.getTime()>=this.data.nextAt;}
 started(settings,{retry=false}={}){this.roll();this.data.count++;this.data.retryAt=0;this.data.nextAt=this.clock().getTime()+settings.minGapMinutes*60000;if(!retry)this.data.retries=0;}
 ended(reason,settings){if(reason==='unanswered'&&this.data.retries<settings.retryCount&&this.data.count<settings.dailyLimit&&withinWindow(this.clock(),settings.startTime,settings.endTime)){this.data.retries++;this.data.retryAt=this.clock().getTime()+settings.retryMinutes*60000;}else{this.data.retryAt=0;this.data.retries=0;}}
}
