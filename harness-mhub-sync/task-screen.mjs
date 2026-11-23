const busy=new Set(['THINKING','WORKING','BUSY']);
const attention={WAITING:'等待你确认',ERROR:'任务出错',DISCONNECTED:'正在重连',ATTENTION:'需要你'};

// Screen feedback is independent of the three lighting states. It never
// uploads images, and advances its timers even while voice or a game owns it.
export class TaskScreen {
  constructor(clock=Date.now){this.clock=clock;this.raw=null;this.completedUntil=0;this.idleUntil=0;this.endLabel='完成啦';}
  update(raw,styles={}){
    const now=this.clock(),previous=this.raw;
    if(raw!==previous){
      if(busy.has(raw)||attention[raw]){this.completedUntil=0;this.idleUntil=0;}
      else if(raw==='SUCCESS'){
        this.endLabel='完成啦';this.completedUntil=now+6000;this.idleUntil=this.completedUntil+3000;
      }else if(raw==='IDLE'){
        if(busy.has(previous)){
          // Without a completion event do not mislabel a cancelled task as a success.
          this.endLabel='任务已结束';this.completedUntil=now+6000;this.idleUntil=this.completedUntil+3000;
        }else if(previous!==null&&previous!=='SUCCESS')this.idleUntil=now+3000;
      }
      this.raw=raw;
    }
    if(busy.has(raw))return {phase:'working',label:styles.BUSY?.label??'任务中',mode:'text'};
    if(attention[raw])return {phase:'attention',label:styles.ATTENTION?.label&&styles.ATTENTION.label!=='需要你'?styles.ATTENTION.label:attention[raw],mode:'text'};
    if(now<this.completedUntil)return {phase:'completed',label:this.endLabel,mode:'text'};
    if(now<this.idleUntil)return {phase:'idle',label:styles.IDLE?.label??'待命中',mode:'text'};
    return null;
  }
}

export function taskScreenPlan({mode,state,gameState,celebrating,preview,feedback,voice=false,manual=false,screenOff=false}){
  const interaction=/^(PET|BEG)/.test(state),blocked=voice||manual||screenOff;
  const overlay=!blocked&&!gameState&&!interaction&&mode!=='manual'?(preview?{phase:'preview',label:preview.style.label,mode:'text'}:feedback):null;
  return {overlay,phase:voice?'voice':gameState?'game':interaction?'interaction':manual||mode==='manual'?'manual':screenOff?'off':overlay?.phase??'base',
    mode:celebrating?'animation':gameState?'text':overlay?'text':['pages','manual'].includes(mode)?'animation':mode,
    suppressScreen:screenOff||mode==='manual'||mode==='pages'&&!overlay&&!preview,
    renderPage:mode==='pages'&&!blocked&&!gameState&&!interaction&&!overlay&&!preview};
}
