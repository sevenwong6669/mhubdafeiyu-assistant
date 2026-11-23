import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';
const root=new URL('./',import.meta.url);
const pid=Number(await fs.readFile(new URL('run.pid',root),'utf8'));process.kill(pid,0);
const temporary=new URL('touch.manual.tmp',root);
await fs.writeFile(temporary,JSON.stringify({id:randomUUID(),at:Date.now()}));
await fs.rename(temporary,new URL('touch.request',root));
console.log('已轻轻摸摸大肥鱼。');
