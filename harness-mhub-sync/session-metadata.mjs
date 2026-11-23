import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {zstdDecompressSync} from 'node:zlib';
export class SessionMetadata {
  constructor(root=path.join(os.homedir(),'.dsh','sessions')){this.root=path.resolve(root);this.files=new Map();this.cache=new Map();}
  async find(id){
    if(!/^session-[a-f0-9-]{36}$/i.test(id||''))return null;
    if(this.files.has(id))return this.files.get(id);
    for(const entry of (await fs.readdir(this.root,{withFileTypes:true})).slice(0,256)){
      if(!entry.isDirectory())continue;
      const file=path.join(this.root,entry.name,id,'session.v4.jsonl.zstd');
      try{
        const real=await fs.realpath(file),relative=path.relative(this.root,real);
        if(relative.startsWith('..')||path.isAbsolute(relative))continue;
        this.files.set(id,real);return real;
      }catch{}
    }
    return null;
  }
  async read(id){
    const file=await this.find(id);if(!file)return null;
    const stat=await fs.stat(file),key=stat.size+':'+stat.mtimeMs;
    if(this.cache.get(id)?.key===key)return this.cache.get(id).value;
    if(stat.size>33554432)return null;
    const buffer=await fs.readFile(file);
    const result={sessionId:id,turnActive:undefined,lastStartAt:0,lastEndAt:0,lastEndSeq:-1,reason:null,turns:[]};
    let turn;
    let offset=0,total=0,count=0;
    while(offset<buffer.length&&count++<50000){
      let frame;try{frame=zstdDecompressSync(buffer.subarray(offset),{info:true,maxOutputLength:8388608});}catch{break;}
      if(!frame.engine.bytesWritten)break;
      offset+=frame.engine.bytesWritten;total+=frame.buffer.length;if(total>134217728)return null;
      for(const line of frame.buffer.toString('utf8').split('\n')){
        let row;try{row=JSON.parse(line);}catch{continue;}
        const at=typeof row.time==='number'?row.time:Date.parse(row.time);
        if(!Number.isFinite(at))continue;
        if(row.type==='turn/start'){
          result.turnActive=true;result.lastStartAt=at;
          turn={sessionId:id,lastStartAt:at,turnActive:true,directInput:false,lastEndAt:0,lastEndSeq:-1,reason:null};
          result.turns.push(turn);
          if(result.turns.length>12)result.turns.shift();
        }
        if(row.type==='user/message'&&turn?.turnActive&&
          (row.data?.source??row.data?.message?.source)?.kind==='user')turn.directInput=true;
        if(row.type==='turn/end'){
          result.turnActive=false;result.lastEndAt=at;result.lastEndSeq=Number(row.seq);
          const kind=row.data?.reason?.kind||'completed';
          result.reason=['completed','aborted','blocked'].includes(kind)?kind:'error';
          if(turn)Object.assign(turn,{turnActive:false,lastEndAt:at,lastEndSeq:result.lastEndSeq,reason:result.reason});
        }
      }
    }
    if(this.cache.size>=64)this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id,{key,value:result});return result;
  }
}
