import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const hostFile=fileURLToPath(new URL('../mhub-community-assistant/state/companion/host.json',import.meta.url));
export async function playLive2dTouch(file=hostFile){try{const h=JSON.parse(await fs.readFile(file,'utf8'));if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(h.baseUrl)||h.api!=='/api/mhub-community/companion'||!/^[a-f0-9]{64}$/.test(h.token))return false;const r=await fetch(h.baseUrl+h.api+'/play',{method:'POST',headers:{'content-type':'application/json','x-pet-token':h.token},body:JSON.stringify({name:'害羞'}),signal:AbortSignal.timeout(1500),redirect:'error'});return r.ok&&(await r.json()).ok===true;}catch{return false;}}
