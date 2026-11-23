import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceRoot=fileURLToPath(new URL('./',import.meta.url));
const entries=['supervisor.mjs','optimized.mjs','runtime-version.mjs','voice-chat/server.mjs','Hotkey-Bindings.ps1','voice-chat/Start.ps1','../mhub-community-assistant/scripts/start-panel.mjs','../mhub-community-assistant/native-host.mjs'];
const helperDirs=['.','phone','voice-chat'];
// Follow JS imports and include native workers which are launched as processes,
// not imported. Configuration, generated assets, logs and models never affect
// the code version (or cause a restart when the user edits a setting).
export function runtimeSources(root=sourceRoot){
 const files=new Set(),pending=entries.map(file=>path.resolve(root,file));
 for(const dir of helperDirs){
  const base=path.resolve(root,dir);
  for(const item of fs.readdirSync(base,{withFileTypes:true}))if(item.isFile()&&/\.(?:py|ps1|cs)$/i.test(item.name)&&! /^(?:test|probe|verify|inspect|check|measure|make|render)/i.test(item.name))pending.push(path.join(base,item.name));
 }
 while(pending.length){
  const file=pending.pop();if(files.has(file))continue;files.add(file);
  if(!/\.[cm]?js$/i.test(file))continue;
  const source=fs.readFileSync(file,'utf8');
  const imports=source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"\r\n]+)['"]/g);
  for(const match of imports){const specifier=match[1].split(/[?#]/,1)[0];if(/\.[cm]?js$/.test(specifier))pending.push(path.resolve(path.dirname(file),specifier));}
 }
 return [...files].sort();
}
export function runtimeVersion(root=sourceRoot){
 const hash=createHash('sha256');
 for(const file of runtimeSources(root)){const bytes=fs.readFileSync(file);hash.update(path.relative(root,file).replaceAll('\\','/')).update('\0').update(String(bytes.length)).update('\0').update(bytes);}
 return hash.digest('hex').slice(0,16);
}
export function controllerOverdue(health,pid,startedAt,now,slow=false){
 const fresh=health?.pid===pid&&now-health.at>=0&&now-health.at<45000;
 const progress=health?.lastProgressAt??startedAt;
 const backingOff=health?.connection?.failures>0&&Number.isFinite(health.connection.nextRetryAt)&&now<=health.connection.nextRetryAt+30000;
 return now-startedAt>(slow?180000:60000)&&(!fresh||!backingOff&&now-progress>180000);
}
