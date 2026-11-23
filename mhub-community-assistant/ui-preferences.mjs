import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const languages=new Set(['zh-CN','ru','en','fr','it']);
export function saveUiLanguage(stateDir,locale){if(!languages.has(locale))throw Error('Invalid interface language');fs.mkdirSync(stateDir,{recursive:true});const file=path.join(stateDir,'ui-preferences.json'),temp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify({version:1,locale}));fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}return {ok:true,locale};}
