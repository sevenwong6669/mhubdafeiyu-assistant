import test from 'node:test';
import assert from 'node:assert/strict';
import {AuraBotLocator,qqConnection} from '../qq-connection.mjs';
const value=()=>({ok:true,config:{enabled:true,dryRun:false,botQQ:'123',token:'never-return-this'},onebot:{state:'connected',login:{uin:'123'}}});
const read=file=>file.endsWith('qq-provider.json')?'{"provider":"aurabot"}':'{"origin":"http://127.0.0.1:18782"}';
test('AuraBot status discovers an owned host port without treating the internal task source as Harness',async()=>{
 const calls=[],locator=new AuraBotLocator({discover:async()=>({harnessPorts:[27123,3188,18782,-1,70000]})});
 const result=await qqConnection({stateDir:'test',read,locator,probe:async url=>{calls.push(url);return url.includes(':27123/')?{reachable:true,value:value()}:{reachable:true,value:{ok:false}};}});
 assert.equal(result.ready,true);assert.equal(result.origin,'http://127.0.0.1:27123');assert.equal(calls.some(url=>url.includes(':18782/')),false);assert.equal(calls.length,2);assert.equal(JSON.stringify(result).includes('never-return-this'),false);
});
test('a cached AuraBot port is checked live and follows a host port change',async()=>{
 let port=27123,discoveries=0;const locator=new AuraBotLocator({discover:async()=>{discoveries++;return {harnessPorts:[port]};}}),probe=async url=>url.includes(':'+port+'/')?{reachable:true,value:value()}:{reachable:false};
 assert.equal((await qqConnection({stateDir:'test',read,locator,probe})).ready,true);assert.equal((await qqConnection({stateDir:'test',read,locator,probe})).ready,true);assert.equal(discoveries,1);
 port=27124;assert.equal((await qqConnection({stateDir:'test',read,locator,probe})).origin,'http://127.0.0.1:27124');assert.equal(discoveries,2);
});
test('simultaneous state requests share discovery, and repeated failures back off',async()=>{
 let now=100000,calls=0,release;const locator=new AuraBotLocator({clock:()=>now,discover:()=>{calls++;return new Promise(r=>{release=r;});}}),probe=async()=>({reachable:false});
 const a=qqConnection({stateDir:'test',read,locator,probe}),b=qqConnection({stateDir:'test',read,locator,probe});await new Promise(setImmediate);release({harnessPorts:[]});assert.equal((await a).ready,false);await b;assert.equal(calls,1);
 await qqConnection({stateDir:'test',read,locator,probe});assert.equal(calls,1);now+=30001;const c=qqConnection({stateDir:'test',read,locator,probe});await new Promise(setImmediate);release({harnessPorts:[]});await c;assert.equal(calls,2);
});
test('ambiguous AuraBot listeners and a wrong logged-in account cannot be reported ready',async()=>{
 const locator=new AuraBotLocator({discover:async()=>({harnessPorts:[27123,27124]})});for(let i=0;i<2;i++){const result=await qqConnection({stateDir:'test',read,locator,probe:async()=>({reachable:true,value:value()})});assert.equal(result.ready,false);assert.equal(result.detail,'AuraBot 端点不唯一。');}
 const wrong=value();wrong.onebot.login.uin='456';assert.equal((await qqConnection({stateDir:'test',read,locator:new AuraBotLocator({discover:async()=>({harnessPorts:[27123]})}),probe:async()=>({reachable:true,value:wrong})})).loginVerified,false);
});
test('AuraBot status distinguishes a disconnected gateway, connecting and unverified login',async()=>{
 const locator=new AuraBotLocator({discover:async()=>({harnessPorts:[27123]})});
 const observed=value();
 const probe=async()=>({reachable:true,value:observed});
 for(const [state,detail] of [
  ['disconnected','AuraBot 未连接 QQ 网关'],
  ['connecting','Aurabot 正在连接 QQ'],
  ['connected','AuraBot 已连接网关，QQ 登录尚未核对'],
 ]){
  observed.onebot={state,login:null};
  const status=await qqConnection({stateDir:'test',read,locator,probe});
  assert.equal(status.connected,state==='connected');
  assert.equal(status.ready,false);
  assert.equal(status.detail,detail);
 }
});
test('missing source metadata can use owned ports but malformed external origins are never contacted',async()=>{
 const missing=file=>file.endsWith('qq-provider.json')?'{"provider":"aurabot"}':(()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});})();
 const locator=new AuraBotLocator({discover:async()=>({harnessPorts:[27123]})});assert.equal((await qqConnection({stateDir:'test',read:missing,locator,probe:async()=>({reachable:true,value:value()})})).ready,true);
 let called=false;const invalid=file=>file.endsWith('qq-provider.json')?'{"provider":"aurabot"}':'{"origin":"http://untrusted.invalid:1234"}';assert.equal((await qqConnection({stateDir:'test',read:invalid,probe:async()=>{called=true;}})).ready,false);assert.equal(called,false);
});

test('offline AstrBot and a missing logged-in QQ process have different status text',async()=>{
 const astr=await qqConnection({stateDir:'test',read:()=>'{"provider":"astrbot"}',probe:async()=>({reachable:false})});
 assert.equal(astr.detail,'AstrBot 未连接。');
 const aura=value();
 aura.onebot={state:'disconnected',problem:'未发现机器人账号的 QQ 进程'};
 const result=await qqConnection({stateDir:'test',read,locator:new AuraBotLocator({discover:async()=>({harnessPorts:[27123]})}),probe:async()=>({reachable:true,value:aura})});
 assert.equal(result.detail,'未发现登录机器人账号的 QQ 进程。');
 assert.equal(result.ready,false);
});
