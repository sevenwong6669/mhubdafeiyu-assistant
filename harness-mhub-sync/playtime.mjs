export const COLORS=['RED','YELLOW','BLUE','GREEN'];
export const PLAY_STYLES={
  BEG:{label:'摸摸我嘛，好不好',color:'#FF4F92',effect:'breathing'},
  GAME_ARMING:{label:'准备小游戏',color:'#B8A4FF'},GAME_INTRO:{label:'看音箱记顺序',color:'#B8A4FF'},
  GAME_ROUND:{label:'记住颜色数量',color:'#B8A4FF'},GAME_COUNTDOWN:{label:'准备',color:'#B8A4FF'},
  GAME_RED:{label:'1',color:'#FF0000',brightness:50},GAME_YELLOW:{label:'2',color:'#FFFF00',brightness:50},
  GAME_BLUE:{label:'3',color:'#0000FF',brightness:50},GAME_GREEN:{label:'4',color:'#00FF00',brightness:50},
  GAME_GAP:{label:'记住顺序',color:'#000000'},GAME_TURN:{label:'轮到你啦',color:'#B8A4FF',effect:'breathing'},
  GAME_WIN:{label:'答对啦',color:'#30EE88',effect:'breathing'},GAME_LOSE:{label:'再试一次嘛',color:'#FF4F92'},
  GAME_CELEBRATE:{label:'通关啦！真棒',color:'#FFD23F',brightness:50},
  GAME_UNAVAILABLE:{label:'游戏输入未就绪',color:'#FF9F32'},
  GAME_PAUSED:{label:'按R重看一次',color:'#B8A4FF'},
};
export function nightQuiet(now=Date.now()){
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',hour:'numeric',hourCycle:'h23'}).format(now));
  return hour>=23||hour<8;
}
export class Attention {
  constructor(clock=Date.now,interval=20*60000){this.clock=clock;this.interval=interval;this.nextAt=clock()+interval;this.until=0;this.idleSince=clock();}
  interact(){this.nextAt=this.clock()+this.interval;this.until=0;}
  request(base,context={},force=false){
    const now=this.clock();
    if(base!=='IDLE'){this.until=0;this.idleSince=now;return false;}
    if(this.until>now)return false;
    if(!force&&(now<this.nextAt||now-this.idleSince<5*60000||context.active!==true||context.fullscreen!==false||context.quiet!==false))return false;
    this.until=now+8000;this.nextAt=now+this.interval;return true;
  }
  visual(base){if(base!=='IDLE'){this.until=0;return null;}return this.clock()<this.until?'BEG':null;}
}
export class MemoryGame {
  constructor(clock=Date.now,random=Math.random){this.clock=clock;this.random=random;this.phase=null;this.voices=[];this.sequence=[];this.randomHistory=[];this.round=0;this.position=0;this.lastResult=null;this.showMs=1500;this.gapMs=650;this.durations={};}
  get active(){return this.phase!==null;}
  get celebrating(){return this.phase==='celebration';}
  setDurations(clips){for(const [name,clip] of Object.entries(clips||{}))if(Number.isFinite(clip.seconds)&&clip.seconds>0&&clip.seconds<20)this.durations[name]=clip.seconds*1000;}
  voiceDelay(name,fallback){return Math.max(1000,(this.durations[name]||fallback)+650);}
  rememberSequence(sequence){
    if(!Array.isArray(sequence)||sequence.length<2||sequence.length>4||sequence.some((x,i)=>!Number.isInteger(x)||x<0||x>3||i>0&&x===sequence[i-1]))return;
    this.randomHistory.push([...sequence]);this.randomHistory=this.randomHistory.slice(-8);
  }
  newSequence(length){
    let choices=[[]];
    for(let i=0;i<length;i++)choices=choices.flatMap(prefix=>[0,1,2,3].filter(x=>x!==prefix.at(-1)).map(x=>[...prefix,x]));
    choices=choices.filter(candidate=>
      !this.randomHistory.some(previous=>previous.length>=length&&candidate.every((x,i)=>x===previous[i]))&&
      !(this.sequence.length>0&&this.sequence.length<length&&this.sequence.every((x,i)=>x===candidate[i])));
    if(!choices.length)throw Error('No fresh game sequences');
    this.sequence=[...choices[Math.min(choices.length-1,Math.floor(this.random()*choices.length))]];
    this.rememberSequence(this.sequence);
  }
  start(base){
    if(base!=='IDLE'||this.active)return false;
    this.newSequence(2);this.round=1;
    this.position=0;this.showIndex=0;this.voices=[];this.celebrationReady=false;this.celebrationDemo=false;
    this.phase='arming';this.startedAt=this.clock();this.until=this.startedAt+10000;this.lastResult=null;return true;
  }
  cancel(reason='owner'){this.phase=null;this.voices=[];this.lastResult=reason;}
  announce(){this.phase='round-intro';this.position=0;this.showIndex=0;const voice='game-count-'+this.sequence.length+'.wav';this.voices.push(voice);this.until=this.clock()+this.voiceDelay(voice,4000);}
  replay(){if(!this.active||['arming','intro','unavailable','celebration','round-win'].includes(this.phase)||this.clock()-(this.lastReplayAt??-Infinity)<750)return false;this.lastReplayAt=this.clock();this.voices=[];this.announce();return true;}
  show(index){this.phase='show';this.showIndex=index;this.until=this.clock()+this.showMs;}
  finish(win){
    if(win&&this.round===3){this.beginCelebration(false);return;}
    this.phase=win?'round-win':'lose';const voice=win?'game-win.wav':'game-lose.wav';this.until=this.clock()+this.voiceDelay(voice,win?3500:4000);this.voices.push(voice);this.lastResult=win?'correct':'wrong';
  }
  beginCelebration(demo){this.phase='celebration';this.celebrationDemo=demo;this.celebrationReady=false;this.until=Infinity;this.voices=[];this.lastResult=demo?'reward-demo':'correct';}
  demoCelebration(base){if(base!=='IDLE'||this.active)return false;this.beginCelebration(true);return true;}
  markCelebrationStarted(durationMs=10000){
    if(!this.celebrating||this.celebrationReady)return false;
    this.celebrationReady=true;this.until=this.clock()+durationMs;this.voices.push('game-fireworks.wav');return true;
  }
  answer(value){
    if(!['input','feedback','paused'].includes(this.phase)||!Number.isInteger(value)||value<0||value>3)return false;
    if(value!==this.sequence[this.position]){this.finish(false);return true;}
    this.position++;this.echo=value;this.until=this.clock()+350;this.inputDeadline=this.clock()+30000;
    if(this.position===this.sequence.length)this.finish(true);else this.phase='feedback';return true;
  }
  tick(base,{keysReady=false,panelReady=false,voiceBusy=false}={}){
    const now=this.clock();if(!this.active)return;
    if(base!=='IDLE'){this.cancel('task-priority');return;}
    if(this.celebrating){if(this.celebrationReady&&now>=this.until&&!voiceBusy)this.cancel(this.celebrationDemo?'demo-completed':'completed');return;}
    if(['intro','round-intro','round-win','lose'].includes(this.phase)&&voiceBusy){this.until=Math.max(this.until,now+200);return;}
    if(this.phase==='arming'){
      if(keysReady||panelReady){this.phase='intro';this.until=now+this.voiceDelay('game-start.wav',10000);this.voices.push('game-start.wav');}
      else if(now>=this.until){this.phase='unavailable';this.until=now+3000;this.lastResult='shortcut-unavailable';}
    }else if(this.phase==='input'||this.phase==='feedback'){
      if(now>=this.inputDeadline){this.phase='paused';this.lastResult='timeout';}
      else if(this.phase==='feedback'&&now>=this.until)this.phase='input';
    }else if(now>=this.until){
      if(this.phase==='intro')this.announce();
      else if(this.phase==='round-intro'){this.phase='countdown';this.countdown=3;this.until=now+1000;}
      else if(this.phase==='countdown'){if(--this.countdown>0)this.until=now+1000;else this.show(0);}
      else if(this.phase==='show'){this.phase='gap';this.until=now+this.gapMs;}
      else if(this.phase==='gap'){
        this.showIndex++;
        if(this.showIndex<this.sequence.length)this.show(this.showIndex);
        else{this.phase='input';this.position=0;this.inputDeadline=now+30000;this.voices.push('game-turn.wav');}
      }else if(this.phase==='round-win'){
        if(this.round>=3){this.cancel('completed');}
        else{this.round++;this.newSequence(this.round+1);this.announce();}
      }else if(this.phase==='lose')this.replay();
      else if(this.phase==='unavailable')this.cancel(this.lastResult);
    }
  }
  visual(){
    if(this.phase==='show')return 'GAME_'+COLORS[this.sequence[this.showIndex]];
    if(this.phase==='feedback')return 'GAME_'+COLORS[this.echo];
    return {celebration:'GAME_CELEBRATE',arming:'GAME_ARMING',intro:'GAME_INTRO','round-intro':'GAME_ROUND',countdown:'GAME_COUNTDOWN',gap:'GAME_GAP',input:'GAME_TURN','round-win':'GAME_WIN',lose:'GAME_LOSE',paused:'GAME_PAUSED',unavailable:'GAME_UNAVAILABLE'}[this.phase]||null;
  }
  screenLabel(){
    const total=this.sequence.length;
    if(['show','gap'].includes(this.phase))return `${this.showIndex+1}/${total}`;
    if(this.phase==='round-intro')return `记住 ${total} 个颜色`;
    if(this.phase==='countdown')return `准备 ${this.countdown}`;
    if(['input','feedback'].includes(this.phase))return `作答 ${this.position}/${total}`;
    if(this.phase==='round-win')return this.round===3?'全部答对啦':`第${this.round}轮 答对啦`;
    return PLAY_STYLES[this.visual()]?.label||'';
  }
  drainVoices(){return this.voices.splice(0);}
  describe(){return {active:this.active,phase:this.phase,celebrating:this.celebrating,celebrationReady:this.celebrationReady===true,celebrationDemo:this.celebrationDemo===true,round:this.round,sequence:this.sequence,randomHistory:this.randomHistory,position:this.position,showIndex:this.showIndex,countdown:this.countdown,screenLabel:this.screenLabel(),lastResult:this.lastResult};}
}
