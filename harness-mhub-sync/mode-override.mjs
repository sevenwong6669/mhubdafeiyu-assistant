import {readFileSync} from 'node:fs';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {writeJson} from './resilience.mjs';

export const SCREEN_MODES=Object.freeze(['animation','text','manual','pages']);
const fileAt=(root,name)=>root instanceof URL?new URL(name,root):path.join(root,name);
export const modeOverrideFile=root=>fileAt(root,'mode-override.json');

export async function writeModeOverride(root,mode){
 if(!SCREEN_MODES.includes(mode))throw Error('Invalid screen mode');
 const file=modeOverrideFile(root);
 await writeJson(file instanceof URL?file:pathToFileURL(file),{mode});
 // The old plaintext name is a migration fallback only.
 await rm(fileAt(root,'mode.request'),{force:true}).catch(()=>{});
}

export function readModeOverride(root){
 let mode;
 try{
  mode=JSON.parse(readFileSync(modeOverrideFile(root),'utf8').replace(/^\uFEFF/,'')).mode;
 }catch(error){
  if(error.code!=='ENOENT')return null;
  try{mode=readFileSync(fileAt(root,'mode.request'),'utf8').trim();}catch{return null;}
 }
 return SCREEN_MODES.includes(mode)?mode:null;
}
