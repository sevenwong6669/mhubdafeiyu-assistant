import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createPanelListener} from '../scripts/start-panel.mjs';
import {createNativeProxy} from '../native-proxy.mjs';

function panel(){const window={},context=vm.createContext({window,structuredClone});vm.runInContext(fs.readFileSync(new URL('../panel/companion.js',import.meta.url),'utf8'),context);const api=window.DafeiyuCompanion,state={data:{companion:{config:{revision:'v1',values:{chat:{mode:'auto',baseUrl:'https://api.deepseek.com/v1',model:'model',vision:false,system:'original'},asr:{},pet:{},image:{},qq:{}}},qq:{}}}};const edit=(key,value)=>api.edit({target:{dataset:{companion:key},value,type:'text'}},state);return {api,state,edit};}
test('internal settings retain newer input while an earlier save is pending and advance only the saved revision',async()=>{
 const {api,state,edit}=panel();edit('chat.system','first edit');edit('apiKey','key-before-save');let resolve,pending,payload;
 const ctx={render(){},request:async(route,data)=>{payload=data;return new Promise(r=>{resolve=r;});},perform:(_key,run)=>{pending=run();}};
 api.action({dataset:{action:'companion-save'}},ctx,state);edit('chat.system','newer edit');resolve({revision:'v2'});await pending;
 assert.equal(payload.values.chat.system,'first edit');assert.equal(payload.apiKey,'key-before-save');assert.match(api.render(state),/newer edit/);assert.doesNotMatch(api.render(state),/key-before-save/);
 ctx.request=async(route,data)=>{payload=data;return {revision:'v3'};};api.action({dataset:{action:'companion-save'}},ctx,state);await pending;assert.equal(payload.revision,'v2');assert.equal(payload.values.chat.system,'newer edit');assert.equal(payload.apiKey,undefined);
});
test('opening an existing hidden pet explicitly sends show and model discovery cannot use an unsaved service target',async()=>{
 const {api,state,edit}=panel(),calls=[];let pending;const ctx={render(){},request:async(route,data)=>{calls.push([route,data]);return {};},perform:(_key,run)=>{pending=run();}};
 api.action({dataset:{action:'companion-launch'}},ctx,state);await pending;assert.deepEqual(calls.map(x=>x[1].action),['launch','show']);calls.length=0;
 edit('chat.baseUrl','https://different.test/v1');api.action({dataset:{action:'companion-models'}},ctx,state);assert.equal(calls.length,0);assert.match(api.render(state),/请先保存 API/);
});
test('real HTTP listener accepts a normal telephone recording but retains the settings request cap',async t=>{
 let received=0;const server=createServer(createPanelListener({port:0,lanAccess:async()=>null,health:()=>({}),handler:async req=>{received=(await req.arrayBuffer()).byteLength;return Response.json({ok:true});}}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port+'/api/mhub-community/companion/';
 // An OS-selected ephemeral port can be on Fetch's blocked-port list. This
 // test exercises the HTTP listener, so use HTTP directly rather than letting
 // unrelated browser port policy make a valid listener test fail at random.
 const post=(url,body)=>new Promise((resolve,reject)=>{
  const req=httpRequest(url,{method:'POST'},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));res.once('error',reject);});
  req.setTimeout(5000,()=>req.destroy(Error('Local HTTP test timed out')));req.once('error',reject);req.end(body);
 });
 const recording=JSON.stringify({action:'turn',wav:Buffer.alloc(64000).toString('base64')});assert.equal(await post(base+'call?trace=1',recording),200);assert.equal(received,Buffer.byteLength(recording));assert.equal(await post(base+'settings','x'.repeat(16001)),413);
});
test('Harness proxy accepts the same valid companion payload as the web listener',async()=>{
 const received=[];
 const proxy=createNativeProxy({owner:'fixture',stateDir:'.',fetchImpl:async(_url,{body})=>{
  received.push(body.byteLength);
  return Response.json({ok:true});
 }});
 const base='dsh-app://app/api/mhub-community/companion/';
 const body=JSON.stringify({text:'鱼'.repeat(3000)});
 assert(Buffer.byteLength(body)>8000);
 const reply=await proxy(new Request(base+'chat',{method:'POST',body}));
 assert.equal(reply.status,200);
 assert.deepEqual(received,[Buffer.byteLength(body)]);
 assert.equal((await proxy(new Request(base+'settings',{method:'POST',body:'x'.repeat(16001)}))).status,413);
 assert.equal(received.length,1);
});
test('closing a request releases its long-poll via the same abort signal',async t=>{
 const entered=Promise.withResolvers(),ended=Promise.withResolvers();
 const server=createServer(createPanelListener({port:0,lanAccess:async()=>null,health:()=>({}),handler:async req=>{
  req.signal.addEventListener('abort',()=>ended.resolve(),{once:true});
  entered.resolve();
  await ended.promise;
  return Response.json({ok:true});
 }}));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{ended.resolve();server.closeAllConnections();server.close();});
 const request=httpRequest('http://127.0.0.1:'+server.address().port+'/api/mhub-community/live2d/events');
 request.on('error',()=>{});request.end();
 await entered.promise;
 request.destroy();
 await Promise.race([ended.promise,new Promise((_,reject)=>{
  const timer=setTimeout(()=>reject(Error('Request did not cancel on disconnect')),2000);timer.unref();
 })]);
});
