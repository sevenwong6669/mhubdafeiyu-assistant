import fs from 'node:fs';
import path from 'node:path';

export function readVersionStatus(stateDir,version){
 const read=file=>{
  try{return JSON.parse(fs.readFileSync(path.join(stateDir,file),'utf8').replace(/^\uFEFF/,''));}
  catch{return null;}
 };
 const stamp=read('loaded-version.json');
 const candidates=[stamp?.loadedVersion,stamp?.runtimeVersion,stamp?.version,stamp,read('companion/native-host-status.json')?.runtimeVersion];
 const loadedVersion=candidates.find(v=>typeof v==='string'&&/^[a-f0-9]{16}$/.test(v))??null;
 return {loadedVersion,restartRequired:loadedVersion!==null&&loadedVersion!==version};
}
