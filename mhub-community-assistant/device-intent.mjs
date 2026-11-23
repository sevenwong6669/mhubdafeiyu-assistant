import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {requireDeviceLink} from '../harness-mhub-sync/device-link-mode.mjs';
const file=new URL('../harness-mhub-sync/device-intent.json',import.meta.url);
let local=0;
export function intentToken(){try{return JSON.parse(fs.readFileSync(file,'utf8')).token??'initial';}catch(e){if(e.code==='ENOENT')return 'initial';throw e;}}
export function captureIntent(){return {local,token:intentToken()};}
export function cancelLocalIntent(){local++;}
export function invalidateIntent(syncRoot){cancelLocalIntent();const target=syncRoot?pathToFileURL(path.join(syncRoot,'device-intent.json')):file;const temp=new URL(String(target)+'.'+randomUUID()+'.tmp');fs.writeFileSync(temp,JSON.stringify({token:randomUUID(),at:Date.now()}));fs.renameSync(temp,target);}
export function checkIntent(intent){requireDeviceLink();if(intent&&(intent.local!==local||intent.token!==intentToken()))throw Error('自动应用已取消，素材已保留。');}
