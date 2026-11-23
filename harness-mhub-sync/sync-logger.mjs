import {appendFileSync,renameSync,statSync} from 'node:fs';

export function createSyncLogger(file,{limit=10*1024*1024}={}){
 return chunk=>{
  const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));
  let bytes=0;
  try{bytes=statSync(file).size;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(bytes&&bytes+data.length>limit)renameSync(file,new URL(file.href+'.previous'));
  appendFileSync(file,data.subarray(Math.max(0,data.length-limit)));
 };
}
