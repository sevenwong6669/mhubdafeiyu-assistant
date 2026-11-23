import {PET_POOLS,PET_VOICE_FILES} from './pet-lines.mjs';
export const PET_STYLES={
  PET:{label:'才没有等你摸呢',color:'#FFAD5C',effect:'breathing'},
  PET_TEASE:{label:'哼，勉强让你摸',color:'#FF775C',effect:'breathing'},
  PET_AGAIN:{label:'再轻一点点嘛',color:'#FF4F92',effect:'breathing'},
  PET_SHY:{label:'才不是害羞',color:'#FF4F92',effect:'breathing'},
  PET_WORK:{label:'快去工作吧',color:'#FFD166',effect:'steady'},
  PET_SULK:{label:'哼，不理你了',color:'#805CFF',effect:'breathing'},
  PET_PEEK:{label:'偷偷看你一眼',color:'#C37CFF',effect:'breathing'},
  PET_BUSY:{label:'等我忙完这一下',color:'#FFD166',effect:'steady'},
};
const VISUAL={hello:'PET',tease:'PET_TEASE',soft:'PET_AGAIN',shy:'PET_SHY',work:'PET_WORK',sulk:'PET_SULK',peek:'PET_PEEK',reunion:'PET',busy:'PET_BUSY'};
export class PetInteraction {
  constructor(clock=Date.now,random=Math.random){
    this.clock=clock;this.random=random;this.last=-Infinity;this.lastIdle=-Infinity;this.lastBusy=-Infinity;
    this.count=0;this.busyCount=0;this.until=0;this.active=null;this.base=null;this.pending=false;this.pendingBase=null;
    this.events=new Map();this.bags={};this.recent=[];this.milestones=new Set();this.durations={};
    this.reunion=false;this.stage=null;this.lastLine=null;this.wasVoiceBusy=false;this.quietUntil=0;
  }
  setDurations(clips){for(const [file,row] of Object.entries(clips||{}))if(PET_VOICE_FILES.has(file)&&Number.isFinite(row.seconds)&&row.seconds>0&&row.seconds<20)this.durations[file]=row.seconds*1000;}
  band(){return this.count<=2?'hello':this.count<=5?'tease':this.count<=9?'soft':this.count<=13?'shy':this.count<=17?'work':this.count<=21?'sulk':'peek';}
  touch(base,event,{blocked=false}={}){
    const now=this.clock();
    if(!event||typeof event.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(event.id)||!Number.isFinite(event.at)||now-event.at>10000||event.at-now>2000)return {accepted:false};
    for(const [id,at] of this.events)if(now-at>10000)this.events.delete(id);
    if(this.events.has(event.id))return {accepted:false};
    this.events.set(event.id,event.at);if(this.events.size>96)this.events.delete(this.events.keys().next().value);
    if(blocked||!['IDLE','BUSY'].includes(base)||event.at-this.last<300)return {accepted:false,consumed:true};
    this.last=event.at;
    if(base==='IDLE'){
      if(event.at-this.lastIdle>=180000){this.reunion=this.count>=6;this.count=0;this.milestones.clear();}
      this.count=Math.min(999,this.count+1);this.lastIdle=event.at;
      this.stage=this.reunion&&this.count===1?'reunion':this.band();
    }else{this.busyCount=event.at-this.lastBusy>=180000?1:Math.min(999,this.busyCount+1);this.lastBusy=event.at;this.stage='busy';}
    this.pending=true;this.pendingBase=base;this.base=base;this.active=VISUAL[this.stage];this.until=now+4500;
    return {accepted:true,consumed:true,count:this.count,stage:this.stage,visual:this.active};
  }
  pick(stage){
    const pool=PET_POOLS[stage],last=this.recent.at(-1);
    if(['work','sulk'].includes(stage)&&!this.milestones.has(stage)){
      this.milestones.add(stage);this.bags[stage]=pool.slice(1).map(x=>x.file);return pool[0];
    }
    if(!this.bags[stage]?.length){
      const bag=pool.map(x=>x.file);for(let i=bag.length-1;i>0;i--){const j=Math.min(i,Math.floor(this.random()*(i+1)));[bag[i],bag[j]]=[bag[j],bag[i]];}this.bags[stage]=bag;
    }
    const bag=this.bags[stage];let i=bag.findIndex(file=>!this.recent.slice(-Math.min(2,pool.length-1)).includes(file));
    if(i<0)i=bag.findIndex(file=>file!==last);
    if(i<0){const alternative=pool.find(x=>x.file!==last);return alternative||pool[0];}
    const file=bag.splice(i,1)[0];return pool.find(x=>x.file===file);
  }
  poll(base,{blocked=false,voiceBusy=false}={}){
    const now=this.clock();
    if(blocked||!['IDLE','BUSY'].includes(base)||this.pending&&base!==this.pendingBase){this.pending=false;this.pendingBase=null;this.active=null;this.wasVoiceBusy=false;return null;}
    if(voiceBusy){this.wasVoiceBusy=true;if(this.active)this.until=Math.max(this.until,now+1000);return null;}
    if(this.wasVoiceBusy){this.wasVoiceBusy=false;this.quietUntil=now+180;}
    if(!this.pending||now<this.quietUntil)return null;
    this.stage=base==='BUSY'?'busy':this.reunion&&this.count===1?'reunion':this.band();
    const selected=this.pick(this.stage);this.recent.push(selected.file);this.recent=this.recent.slice(-6);
    this.pending=false;this.pendingBase=null;this.base=base;this.active=VISUAL[this.stage];
    const durationMs=this.durations[selected.file]||6000;this.until=now+Math.max(4500,durationMs+800);
    this.lastLine={voice:selected.file,text:selected.text,count:this.count,stage:this.stage};
    return {...this.lastLine,visual:this.active,durationMs};
  }
  visual(base){if(base!==this.base||this.clock()>=this.until){this.active=null;return base;}return this.active||base;}
  describe(){return {count:this.count,busyCount:this.busyCount,stage:this.stage,pending:this.pending,lastLine:this.lastLine};}
  snapshot(){return {version:2,count:this.count,busyCount:this.busyCount,last:this.last,lastIdle:this.lastIdle,lastBusy:this.lastBusy,events:[...this.events],bags:this.bags,recent:this.recent,milestones:[...this.milestones]};}
  restore(saved){
    if(saved?.version!==2)return;
    for(const key of ['count','busyCount'])if(Number.isInteger(saved[key])&&saved[key]>=0&&saved[key]<=999)this[key]=saved[key];
    for(const key of ['last','lastIdle','lastBusy'])if(Number.isFinite(saved[key])&&saved[key]<=this.clock()+2000)this[key]=saved[key];
    this.events=new Map((saved.events||[]).filter(row=>Array.isArray(row)&&typeof row[0]==='string'&&Number.isFinite(row[1])).slice(-96));
    this.recent=(saved.recent||[]).filter(x=>PET_VOICE_FILES.has(x)).slice(-6);
    for(const [stage,files] of Object.entries(saved.bags||{}))if(PET_POOLS[stage]&&Array.isArray(files))this.bags[stage]=files.filter(file=>PET_POOLS[stage].some(x=>x.file===file));
    this.milestones=new Set((saved.milestones||[]).filter(x=>['work','sulk'].includes(x)));
  }
}
