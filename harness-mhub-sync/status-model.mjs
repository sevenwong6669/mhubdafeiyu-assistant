import {SOURCE_STALE_MS} from './harness-events.mjs';
export const BUSY_STATES=new Set(['THINKING','WORKING']);
const STATES=new Set(['IDLE','THINKING','WORKING','WAITING','SUCCESS','ERROR','DISCONNECTED']);
export class HarnessStatus {
  constructor(clock=Date.now){this.clock=clock;this.base='IDLE';this.sessionId=null;this.sourceAt=0;this.lastDataAt=clock();this.pulseUntil=0;this.pulseState=null;this.reconciledSeq=-1;this.corrections=0;this.retriedTools=0;this.lastRetryAt=0;}
  touchTransport(){this.lastDataAt=this.clock();}
  consume(message){
    const now=this.clock();this.lastDataAt=now;
    if(!message||!['state','pulse'].includes(message.kind)||!STATES.has(message.state))return;
    const at=Number.isFinite(message.timestamp)?message.timestamp:now;
    if(at<this.sourceAt)return;
    this.sourceAt=at;
    const id=/^session-[a-f0-9-]{36}$/i.test(message.sessionId||'')?message.sessionId:null;
    if(id!==this.sessionId)this.reconciledSeq=-1;
    this.sessionId=id;
    if(message.kind==='pulse'){
      this.base=STATES.has(message.resumeState)?message.resumeState:'IDLE';
      // A tool attempt can fail while the agent continues the same task.
      // Such a pulse explicitly says to resume THINKING/WORKING; it is not
      // a terminal turn failure and must not flash the red task alarm.
      if(message.state==='ERROR'&&BUSY_STATES.has(this.base)){
        this.retriedTools++;this.lastRetryAt=now;this.pulseUntil=0;this.pulseState=null;return;
      }
      if(BUSY_STATES.has(this.base))this.sessionId=null;
      this.pulseState=message.state;this.pulseUntil=now+5000;
    }else{
      this.base=message.state;this.pulseUntil=0;this.pulseState=null;
    }
  }
  reconcile(meta){
    if(!meta||meta.sessionId!==this.sessionId||meta.turnActive!==false||meta.lastEndAt<this.sourceAt||meta.lastEndSeq<=this.reconciledSeq)return false;
    this.reconciledSeq=meta.lastEndSeq;this.sourceAt=meta.lastEndAt;this.corrections++;
    const state=meta.reason==='completed'||meta.reason==='aborted'?'IDLE':meta.reason==='blocked'?'WAITING':'ERROR';
    this.base=state;this.pulseUntil=0;this.pulseState=null;
    if(meta.reason==='completed'&&this.clock()-meta.lastEndAt<5000){this.pulseState='SUCCESS';this.pulseUntil=meta.lastEndAt+5000;}
    return true;
  }
  visual(mergeBusy=true){
    if(this.clock()-this.lastDataAt>SOURCE_STALE_MS)return 'DISCONNECTED';
    const raw=this.clock()<this.pulseUntil?this.pulseState:this.base;
    return mergeBusy&&BUSY_STATES.has(raw)?'BUSY':raw;
  }
}

// The companion's visual feed merges typed, QQ and voice sessions. A turn can
// emit THINKING before its user/message is committed, so keep it pending until
// the local Harness journal confirms a message from the desktop user.
export class TypedTaskEvents {
  constructor(model,metadata){this.model=model;this.metadata=metadata;this.pending=new Map();this.startAt=0;}
  enqueue(message){
    if(message?.source==='mhub-internal'&&message.directInput===true&&Number.isFinite(message.timestamp)){
      this.model.consume(message);this.startAt=0;return;
    }
    if(!['state','pulse'].includes(message?.kind)||!STATES.has(message.state)||
      !/^session-[a-f0-9-]{36}$/i.test(message.sessionId||'')||!Number.isFinite(message.timestamp))return;
    const previous=this.pending.get(message.sessionId);
    if(!previous||previous.timestamp<=message.timestamp)this.pending.set(message.sessionId,message);
    if(this.pending.size>32)this.pending.delete(this.pending.keys().next().value);
  }
  async poll(onAccepted=()=>{}){
    const now=this.model.clock();
    for(const [id,message] of this.pending){
      if(now-message.timestamp>5000){this.pending.delete(id);continue;}
      const meta=await this.metadata.read(id).catch(()=>null);
      const turn=meta?.turns.findLast(entry=>entry.lastStartAt<=message.timestamp);
      if(!turn||this.pending.get(id)!==message)continue;
      if(message.kind==='state'&&BUSY_STATES.has(message.state)&&turn.lastEndAt&&turn.lastEndAt<=message.timestamp)continue;
      if(!turn.directInput&&!turn.lastEndAt)continue;
      this.pending.delete(id);
      if(!turn.directInput||message.timestamp<this.model.sourceAt)continue;
      if(turn.lastEndAt&&message.timestamp-turn.lastEndAt>5000)continue;
      this.startAt=turn.lastStartAt;
      this.model.consume(message);
      onAccepted(message);
    }
    if(!this.model.sessionId||!this.startAt)return false;
    const meta=await this.metadata.read(this.model.sessionId).catch(()=>null);
    const turn=meta?.turns.find(entry=>entry.lastStartAt===this.startAt);
    return turn?.directInput===true&&this.model.reconcile(turn);
  }
  visual(){
    const raw=this.model.visual(false);
    return raw==='DISCONNECTED'&&this.model.base==='IDLE'?'IDLE':raw;
  }
}
