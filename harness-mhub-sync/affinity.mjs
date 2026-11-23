import fs from 'node:fs/promises';
import {writeJson} from './resilience.mjs';

export const AFFINITY_START=20;
export const AFFINITY_DELTA={touch:2,requestedTouch:3,missedTouch:-1,answeredCall:4,missedCall:-2};
const file=new URL('affinity.json',import.meta.url);
export const affinityText=value=>'♥ 好感度 '+value+'%';

export class Affinity {
  constructor({load=async()=>JSON.parse(await fs.readFile(file,'utf8')),save=value=>writeJson(file,value)}={}){
    this.load=load;this.save=save;this.value=AFFINITY_START;this.seen=[];
  }
  async init(){
    try{
      const record=await this.load();
      if(!Number.isInteger(record.value)||record.value<0||record.value>100||!Array.isArray(record.seen))throw Error('好感度记录无效');
      this.value=record.value;this.seen=record.seen;
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async apply(kind,id){
    if(!id||this.seen.includes(id)||!Object.hasOwn(AFFINITY_DELTA,kind))return false;
    const value=Math.max(0,Math.min(100,this.value+AFFINITY_DELTA[kind]));
    const seen=[...this.seen,id].slice(-256);
    await this.save({value,seen});
    this.value=value;this.seen=seen;
    return true;
  }
  async phone(call){
    if(call?.direction!=='incoming'||call.demo||!call.id)return;
    if(call.phase==='connected'||call.connectedAt||call.phase==='connecting')
      await this.apply('answeredCall','call:'+call.id);
    else if(call.phase==='ended'&&call.reason==='unanswered')
      await this.apply('missedCall','call:'+call.id);
  }
}
