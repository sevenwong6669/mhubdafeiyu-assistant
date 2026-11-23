import fs from 'node:fs/promises';
import {uptime} from 'node:os';
import {randomInt} from 'node:crypto';
import {writeJson} from './resilience.mjs';

const assets=new URL('assets/residents/',import.meta.url);
const stateFile=new URL('resident-rotation.json',import.meta.url);
const localDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',dateStyle:'short'});

export class ResidentRotation {
  async init(){
    this.catalog=JSON.parse(await fs.readFile(new URL('catalog.json',assets),'utf8'));
    this.boot=Date.now()-uptime()*1000;
    try{this.current=JSON.parse(await fs.readFile(stateFile,'utf8'));}
    catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  }
  day(){return localDay.format(new Date());}
  due(){return this.requested||this.current?.day!==this.day()||
    Math.abs(this.boot-(this.current?.boot??0))>120000;}
  select(){
    if(this.pending)return this.pending;
    const previous=this.catalog.find(clip=>clip.id===this.current?.id);
    if(previous&&!this.due())return previous;
    let remaining=this.catalog.filter(clip=>clip.id!==previous?.id&&this.current?.remaining?.includes(clip.id));
    if(!remaining.length)remaining=this.catalog.filter(clip=>clip.id!==previous?.id);
    if(!remaining.length)remaining=this.catalog;
    const clip=remaining[randomInt(remaining.length)];
    this.pending={...clip,remaining:remaining.filter(item=>item.id!==clip.id).map(item=>item.id)};
    return this.pending;
  }
  async applied(clip){
    const record={id:clip.id,label:clip.label,day:this.day(),boot:this.boot,
      remaining:clip.remaining??this.current?.remaining??[],at:Date.now()};
    await writeJson(stateFile,record);
    this.current=record;this.pending=null;this.requested=false;
  }
}
