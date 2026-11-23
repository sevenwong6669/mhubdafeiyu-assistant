import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {prepareDriver,probeDriverPort} from '../../harness-mhub-sync/driver-startup.mjs';
import {bootVersions} from '../scripts/verify-after-boot.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('cold boot verification rejects old runtime versions and records from the preceding boot',()=>{
 const records=Object.fromEntries(['panel','voice','controller','supervisor','host'].map(k=>[k,{version:'new',startedAt:200}]));
 records.host={version:'0.11.0',runtimeVersion:'new',at:200};
 assert.equal(bootVersions('new',records,100).versionsMatch,true);
 records.host={version:'0.11.0',runtimeVersion:'old',at:200};assert.equal(bootVersions('new',records,100).versionsMatch,false);
 records.host={version:'0.11.0',runtimeVersion:'new',at:99};assert.equal(bootVersions('new',records,100).versionsMatch,false);
 records.host={version:'0.11.0',runtimeVersion:'new',at:200};delete records.voice;assert.equal(bootVersions('new',records,100).versionsMatch,false);
});
test('native host product versions are checked separately and cannot hide an explicit stale runtime hash',()=>{
 const records=Object.fromEntries(['panel','voice','controller','supervisor'].map(k=>[k,{version:'digest',startedAt:200}]));records.host={version:'0.11.0',at:200};
 assert.equal(bootVersions('digest',records,100).versionsMatch,false);
 assert.equal(bootVersions('digest',records,100,{hostProductVersion:'0.11.0'}).versionsMatch,true);
 assert.equal(bootVersions('digest',records,100,{hostProductVersion:'0.10.0'}).versionsMatch,false);
 records.host.runtimeVersion='old';assert.equal(bootVersions('digest',records,100,{hostProductVersion:'0.11.0'}).versionsMatch,false);
});
function fixture(extra={}){
 const state={ready:false,running:false,starts:0,releases:0,records:[],ports:0};
 const options={probeDebug:async()=>({ready:state.ready,state:state.ready?'ready':'unavailable'}),probeRuntime:async()=>({mhubRunning:state.running}),
 launch:async()=>{state.starts++;state.running=true;state.ready=true;return {executable:'test-driver',pid:55,startedAt:10};},
 persist:async value=>state.records.push(value),describeUnavailable:()=> 'existing driver unavailable',
 acquire:async()=>({release(){state.releases++;}}),portProbe:async()=>{state.ports++;return {available:true};},wait:()=>sleep(1),...extra};
 return {state,options,run:()=>prepareDriver(options)};
}
test('two simultaneous startup callers hold one lease through readiness and spawn once',async()=>{
 let held=false,launching=false,ready=false,starts=0,releases=0;
 const options={probeDebug:async()=>({ready,state:ready?'ready':'unavailable'}),probeRuntime:async()=>({mhubRunning:launching}),
 acquire:async()=>{if(held)return null;held=true;return {release(){releases++;held=false;}};},portProbe:async()=>({available:true}),wait:()=>sleep(2),
 describeUnavailable:()=> 'existing',launch:async()=>{starts++;launching=true;setTimeout(()=>{ready=true;},20);return {executable:'test-driver'};}};
 const [first,second]=await Promise.all([prepareDriver(options),prepareDriver(options)]);
 assert.equal(starts,1);assert.equal(releases,1);assert.equal(first.ready,true);assert.equal(second.ready,true);assert.equal(second.shared,true);
});
test('a fresh interface skips the lock, process enumeration, port bind and launch',async()=>{
 const f=fixture({acquire:async()=>{throw Error('must not acquire');},probeRuntime:async()=>{throw Error('must not enumerate');}});f.state.ready=true;
 assert.deepEqual(await f.run(),{ready:true,launched:false});assert.equal(f.state.starts,0);assert.equal(f.state.ports,0);
});
test('a driver appearing while acquiring the mutex is never launched twice',async()=>{
 const f=fixture();f.options.acquire=async()=>{f.state.running=true;return {release(){f.state.releases++;}};};
 await assert.rejects(f.run(),/existing driver/);assert.equal(f.state.starts,0);assert.equal(f.state.releases,1);
});
test('an external driver appearing after a port check is protected',async()=>{
 const f=fixture();f.options.portProbe=async()=>{f.state.running=true;return {available:true};};
 await assert.rejects(f.run(),/existing driver/);assert.equal(f.state.starts,0);assert.equal(f.state.releases,1);
});
test('a recent debug launch can initialize without being mislabeled or relaunched',async()=>{
 const f=fixture({clock:()=>1000});f.options.probeRuntime=async()=>({mhubRunning:true,mhubMain:[{debugRequested:true,startedAt:999}]});f.options.wait=async()=>{f.state.ready=true;};
 assert.equal((await f.run()).launched,false);assert.equal(f.state.starts,0);assert.equal(f.state.releases,1);
});
test('a recognized debug service can finish loading even when process arguments are unreadable',async()=>{
 const f=fixture({probeRuntime:async()=>{throw Error('must not enumerate');}});
 f.options.probeDebug=async()=>({ready:f.state.ready,state:f.state.ready?'ready':'initializing'});f.options.wait=async()=>{f.state.ready=true;};
 assert.equal((await f.run()).launched,false);assert.equal(f.state.starts,0);assert.equal(f.state.ports,0);assert.equal(f.state.releases,1);
});
test('temporary port exclusion backs off before launch, and writes ready only after the interface',async()=>{
 const f=fixture();let checks=0;
 f.options.portProbe=async()=>({available:++checks>=3,code:'EACCES'});
 await f.run();assert.equal(checks,3);assert.equal(f.state.starts,1);assert.deepEqual(f.state.records.map(x=>x.phase),['waiting-interface','ready']);
});
test('a blocked port has a finite retry budget and never spawns a driver',async()=>{
 let now=0;const f=fixture({clock:()=>now,wait:async ms=>{now+=ms;},portProbe:async()=>({available:false,code:'EACCES'})});
 await assert.rejects(f.run(),/49763.*EACCES/);assert.equal(f.state.starts,0);assert.equal(f.state.releases,1);assert(now>=6000&&now<=6400);
});
test('master-off or user cancellation during the port wait prevents launch and releases the mutex',async()=>{
 const abort=new AbortController(),f=fixture({signal:abort.signal,portProbe:async()=>({available:false,code:'EADDRINUSE'}),wait:async()=>abort.abort(Error('user stopped'))});
 await assert.rejects(f.run(),/user stopped/);assert.equal(f.state.starts,0);assert.equal(f.state.releases,1);
});
test('a waiting non-owner is cancellable and never launches or releases another owner',async()=>{
 const abort=new AbortController(),f=fixture({acquire:async()=>null,signal:abort.signal,wait:async()=>abort.abort(Error('cancelled'))});
 await assert.rejects(f.run(),/cancelled/);assert.equal(f.state.starts,0);assert.equal(f.state.releases,0);
});
test('a launch accepted without a listening interface persists failure and does not claim ready',async()=>{
 const abort=new AbortController(),f=fixture({signal:abort.signal,wait:async()=>abort.abort(Error('interface timeout'))});
 f.options.launch=async()=>{f.state.starts++;return {executable:'test-driver',pid:55};};
 await assert.rejects(f.run(),/interface timeout/);assert.deepEqual(f.state.records.map(x=>x.phase),['waiting-interface','failed']);assert.equal(f.state.releases,1);
});
test('foreign services and stale listening owners are protected',async()=>{
 const f=fixture({probeDebug:async()=>({ready:false,state:'occupied',error:'foreign service'})});await assert.rejects(f.run(),/foreign service/);assert.equal(f.state.starts,0);assert.equal(f.state.releases,0);
 const g=fixture({probeRuntime:async()=>({mhubRunning:false,debugListeners:[{pid:99,ownerAlive:false}]})});await assert.rejects(g.run(),/端口仍未释放/);assert.equal(g.state.starts,0);assert.equal(g.state.releases,1);
});
test('the native bind probe detects an occupied loopback port without disrupting its listener',async t=>{
 const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const result=await probeDriverPort({port:server.address().port});assert.equal(result.available,false);assert.equal(result.code,'EADDRINUSE');assert(server.listening);
 assert.deepEqual(await probeDriverPort({port:0}),{available:true});
});
test('separate Node processes share the Windows driver-startup mutex',{skip:process.platform!=='win32',timeout:25000},async t=>{
 const moduleUrl=new URL('../../harness-mhub-sync/process-lock.mjs',import.meta.url).href;
 const source=`import {acquireSupervisorLock} from ${JSON.stringify(moduleUrl)};const lease=await acquireSupervisorLock({name:'DafeiyuDriverStartupRegression'});console.log(lease?'OWNED':'BUSY');if(lease){process.stdin.resume();await new Promise(r=>process.stdin.once('end',r));lease.release();}`;
 const create=()=>spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const first=create();t.after(()=>{first.stdin.end();});let output='';first.stdout.on('data',v=>{output+=v;});
 const deadline=Date.now()+12000;while(!output.includes('OWNED')&&Date.now()<deadline)await sleep(20);assert.match(output,/OWNED/);
 const second=create();let other='';second.stdout.on('data',v=>{other+=v;});second.stdin.end();assert.deepEqual(await once(second,'exit'),[0,null]);assert.match(other,/BUSY/);
 first.stdin.end();assert.deepEqual(await once(first,'exit'),[0,null]);
});
