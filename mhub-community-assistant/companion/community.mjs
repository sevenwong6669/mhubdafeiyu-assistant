// Reuse the project's existing search/preview/consent/write implementation.
// The tiny host below replaces the old external AuraBot module host.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createMhubModule} from '../aurabot-adapter.mjs';
import {communitySearchHint} from '../community-voice.mjs';
export function internalCommunity(service,{moduleFactory=createMhubModule}={}){const handlers=new Map(),events=new Map(),dir=path.join(service.dir,'community'),hub={lastBotToOwner:null};fs.mkdirSync(dir,{recursive:true});const owner=()=>service.config.read().qq.owner||'10000',outputs=new AsyncLocalStorage();
 const api={dataDir:name=>path.join(dir,name),isOwner:id=>String(id)===owner(),config:()=>({ownerQQ:owner(),enabled:true,dryRun:false}),on:(type,fn)=>events.set(type,fn),route:(route,fn)=>handlers.set(route,fn),tool(){},context(){},command(){},defineTool:value=>value,
  ask:args=>service.ai.ask(args),sendText:async(chatId,text)=>{outputs.getStore()?.push(text);hub.lastBotToOwner={at:Date.now(),text,chatId};const recipient=owner();if(service.qq?.online&&service.config.read().qq.enabled&&chatId==='private:'+recipient)return service.qq.send(recipient,text);return {message_id:randomUUID()};},core:{hub,http:{body:async req=>req.input}}};
 moduleFactory({hostFile:path.join(service.dir,'host.json')}).setup(api);
 return {async active(){return (await handlers.get('/voice-community-context')({headers:{'x-pet-token':service.token}})).active===true;},async turn(text,id){return outputs.run([],()=>handlers.get('/voice-community')({headers:{'x-pet-token':service.token},input:{text,id}}));},async message(text){if(!communitySearchHint(text)&&!await this.active())return null;const lines=[];return outputs.run(lines,async()=>{const handled=await events.get('message')?.({kind:'private',chatId:'private:'+owner(),userId:owner(),text});return handled?lines.join('\n'):null;});}};
}
