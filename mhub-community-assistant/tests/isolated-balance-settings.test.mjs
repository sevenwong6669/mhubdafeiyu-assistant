import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {CompanionConfig,DEFAULT_COMPANION,atomicJson} from '../companion/config.mjs';
import {CompanionAI} from '../companion/ai.mjs';
import {CompanionService} from '../companion/service.mjs';
import {BalanceBar} from '../../harness-mhub-sync/balance-bar.mjs';
const ready=amount=>({status:'ready',checkedAt:Date.now(),source:'harness-account',balances:[{currency:'CNY',total:String(amount)}]});
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-balance-'));t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const config=new CompanionConfig(dir,{crypt:async s=>s}),ai=new CompanionAI(config,options),service=Object.create(CompanionService.prototype);
 Object.assign(service,{config,ai,asr:{phase:'unprepared'},turns:new Map()});
 return {dir,config,ai,service,save:async balance=>{const snap=config.snapshot();return service.saveSettings({values:{...snap.values,balance},revision:snap.revision});}};
}
test('source-only save preserves a running reply and the existing conversation',async t=>{
 const {config,ai,service,save}=fixture(t);await save({source:'account',provider:''});
 const snap=config.snapshot();snap.values.chat.mode='api';snap.values.chat.model='test';await config.save({values:snap.values,revision:snap.revision});
 ai.history.set('voice',[{role:'user',content:'earlier'},{role:'assistant',content:'remembered'}]);
 let finish;ai.api=()=>new Promise(r=>finish=r);const abort=new AbortController();service.turns.set('reply',{abort});
 const reply=ai.reply('still talking',{signal:abort.signal});await save({source:'api',provider:'second'});
 assert.equal(abort.signal.aborted,false);assert.equal(ai.history.get('voice').length,2);
 finish({choices:[{message:{content:'finished normally'}}]});assert.equal((await reply).reply,'finished normally');assert.equal(ai.history.get('voice').length,4);
});
test('a locked cache cannot prevent generation invalidation or let a late old request replace the new source',async t=>{
 const io={...fs,rmSync:()=>{throw Object.assign(Error('locked'),{code:'EPERM'});}};
 const {ai,save,dir}=fixture(t,{cacheIO:io});await save({source:'account',provider:''});
 let finishOld,finishNew;ai.harness=(_op,input)=>new Promise(r=>{if(input.source==='account')finishOld=r;else finishNew=r;});
 const old=ai.balance();await save({source:'api',provider:'second'});const current=ai.balance(),inflight=ai.balancePending;
 finishOld(ready(99));assert.equal((await old).status,'superseded');assert.equal(ai.balancePending,inflight);
 finishNew(ready(2));assert.equal((await current).balances[0].total,'2');assert.equal(ai.lastBalance.balances[0].total,'2');
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'balance-last-good.json'),'utf8'));assert.equal(saved.selection,ai.balanceSelection());assert.equal(saved.value.balances[0].total,'2');
});
test('source epochs survive A to B to A and prevent an undeleted old cache loading after restart',async t=>{
 const {ai,config,save,dir}=fixture(t);await save({source:'account',provider:''});ai.harness=async()=>ready(9);await ai.balance();
 const cached=fs.readFileSync(path.join(dir,'balance-last-good.json'));const epoch=config.read().balance.cacheEpoch;
 await save({source:'api',provider:'second'});await save({source:'account',provider:''});assert.notEqual(config.read().balance.cacheEpoch,epoch);
 fs.writeFileSync(path.join(dir,'balance-last-good.json'),cached);const restarted=new CompanionAI(config);restarted.harness=async()=>{throw Error('offline');};
 const result=await restarted.balance();assert.equal(result.status,'error');assert.equal(result.retained,undefined);
});
test('cache persistence failures remain visible without losing a successful balance or a saved revision',async t=>{
 let fail=true;const {ai,save}=fixture(t,{writeCache:()=>{if(fail)throw Error('disk locked');}});
 const saved=await save({source:'account',provider:''});assert(saved.revision);ai.harness=async()=>ready(7);
 const first=await ai.balance();assert.equal(first.status,'ready');assert.match(first.cacheWarning,/尚未保存/);
 fail=false;const second=await ai.balance({force:true});assert.equal(second.cacheWarning,undefined);assert.equal(second.balances[0].total,'7');
});
function panel(){
 const timers=[],calls=[],state={data:{companion:{config:{revision:'r1',values:structuredClone(DEFAULT_COMPANION)}}}},window={};
 vm.runInNewContext(fs.readFileSync(new URL('../panel/companion.js',import.meta.url),'utf8'),{window,structuredClone,setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout(){}});
 let pending;const ctx={render(){},perform:(_key,run)=>{pending=run();},request:async(route)=>{calls.push(route);if(route.endsWith('/settings'))return {revision:'r2'};throw Error('offline');}};
 return {api:window.DafeiyuCompanion,state,ctx,calls,timers,run:async()=>{window.DafeiyuCompanion.action({dataset:{action:'companion-balance-source-save'}},ctx,state);return pending;},retry:async()=>{timers.shift()();return pending;}};
}
test('saved source plus a failed read stays saved and retry issues no second write',async()=>{
 const p=panel(),result=await p.run();assert.equal(result.saved,true);assert.equal(result.balanceUpdated,false);assert.match(result.message,/已保存.*暂未更新/);assert.equal(p.state.data.companion.config.revision,'r2');
 await p.retry();assert.equal(p.calls.filter(x=>x.endsWith('/settings')).length,1);assert.equal(p.calls.filter(x=>x.endsWith('/balance-refresh')).length,2);
});
test('HTTP-success business failures and retained stale balances never claim a fresh update',async()=>{
 for(const value of [{status:'error',message:'not ready'},{...ready(4),stale:true,retained:true}]){
  const p=panel();p.ctx.request=async route=>route.endsWith('/settings')?{revision:'r2'}:value;
  const result=await p.run();assert.equal(result.saved,true);assert.equal(result.balanceUpdated,false);assert.match(result.message,/暂未更新/);
 }
});
test('a successful fresh read gives a separate saved-and-updated receipt',async()=>{
 const p=panel();p.ctx.request=async route=>route.endsWith('/settings')?{revision:'r2'}:ready(4);
 const result=await p.run();assert.equal(result.balanceUpdated,true);assert.match(result.message,/余额已更新/);assert.equal(p.timers.length,0);
});
test('read retries are bounded, acknowledge the saved revision, and never repeat settings writes',async()=>{
 const p=panel();await p.run();let last;for(let i=0;i<3;i++)last=await p.retry();
 assert.equal(p.timers.length,0);assert.equal(p.calls.filter(x=>x.endsWith('/settings')).length,1);assert.equal(p.calls.filter(x=>x.endsWith('/balance-refresh')).length,4);assert.match(last.message,/请稍后重新读取/);assert.equal(p.state.data.companion.config.revision,'r2');
});
test('a newer save makes the old queued retry harmless',async()=>{
 const p=panel();await p.run();p.ctx.request=async route=>{p.calls.push(route);return route.endsWith('/settings')?{revision:'r3'}:ready(4);};
 await p.run();const before=p.calls.length;await p.retry();assert.equal(p.calls.length,before);assert.equal(p.state.data.companion.config.revision,'r3');
});
test('a failed settings write is never called saved and never schedules a balance retry',async()=>{
 const p=panel();p.ctx.request=async()=>{throw Error('save rejected');};await assert.rejects(p.run(),/save rejected/);assert.equal(p.timers.length,0);assert.equal(p.state.data.companion.config.revision,'r1');
});
test('a balance notification failure does not turn committed settings into a failed save',async t=>{
 const {service,save}=fixture(t);service.onBalanceChanged=async()=>{throw Error('controller offline');};const result=await save({source:'account',provider:''});assert(result.revision);assert.match(result.message,/已保存.*暂未更新/);
});
test('a failed atomic rename preserves the previous value and cleans its temporary file',t=>{
 const {dir}=fixture(t),file=path.join(dir,'sample.json');atomicJson(file,{old:true});const rename=fs.renameSync;
 try{fs.renameSync=()=>{throw Object.assign(Error('locked'),{code:'EPERM'});};assert.throws(()=>atomicJson(file,{new:true}),/locked/);}finally{fs.renameSync=rename;}
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{old:true});assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')).length,0);
});
test('cache warnings remain visible in balance status without turning working lights into a failure',async()=>{
 const bar=new BalanceBar({writeStatus:async()=>{}});bar.snapshot={...ready(5),cacheWarning:'cache pending'};bar.settings={enabled:true,fullAmount:10,brightness:40,currency:'CNY'};bar.ambient={sync:async()=>({available:true,model:'GT 75',segments:20,active:true,paletteReadback:'verified'})};
 const status=await bar.syncAmbient();assert.equal(status.visible,true);assert.equal(status.cacheWarning,'cache pending');assert.equal(status.error,null);
});
test('legacy Harness selection keeps its existing not-configured status contract',async t=>{
 const {ai,config}=fixture(t),snap=config.snapshot();snap.values.chat.mode='harness';await config.save({values:snap.values,revision:snap.revision});ai.harness=async()=>{throw Error('host unavailable');};
 assert.equal((await ai.balance()).status,'not-configured');
});
