import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';
const kind=process.argv[2],value=process.argv[3]===undefined?0:Number(process.argv[3]);
if(!['fireworks-demo','game-start','game-stop','game-toggle','game-replay','color','beg-demo','attention-off','attention-on'].includes(kind))throw Error('Unknown interaction');
if(kind==='color'&&(!Number.isInteger(value)||value<0||value>3))throw Error('Choose colour 0..3');
const root=new URL('./',import.meta.url),pid=Number(await fs.readFile(new URL('run.pid',root),'utf8'));process.kill(pid,0);
const at=Date.now(),id=randomUUID(),dir=new URL('interaction-inbox/',root);await fs.mkdir(dir,{recursive:true});
const name=`${at}-000000-${id}.json`,temp=new URL(name+'.tmp',dir);
await fs.writeFile(temp,JSON.stringify({id,at,kind,value}));await fs.rename(temp,new URL(name,dir));
console.log('Interaction requested: '+kind);
