import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {resolveNodeExecutable,startHostBackend,createHostStatusWriter} from '../host-startup.mjs';
import {createNativeProxy} from '../native-proxy.mjs';
import {processIdentity} from '../process-identity.mjs';
import {PluginRecovery,recoveryTiming,RecoveryBudget,cancelStalledRecovery,RECOVERY_TOTAL_MS} from '../recovery.mjs';
import {RuntimeResume} from '../runtime-resume.mjs';
import {SyncStartup} from '../../harness-mhub-sync/startup.mjs';
import {automaticStopAllowsResume} from '../../harness-mhub-sync/device-link-mode.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-recovery-'));fs.mkdirSync(path.join(root,'state'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));return root;}
const put=(root,file,value)=>{const target=path.join(root,'state',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(value));};
function fakeSpawn(calls){return(exe,args)=>{calls.push({exe,args});const child=new EventEmitter();child.pid=222;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};}
test('startup selects an explicit Node path and never treats an Electron host as Node',t=>{
 const root=fixture(t);assert.equal(resolveNodeExecutable({root,env:{DAFEIYU_NODE_EXECUTABLE:'custom-node'},execPath:'harness.exe',exists:p=>p==='custom-node'}),'custom-node');
 assert.throws(()=>resolveNodeExecutable({root,env:{PATH:''},execPath:'DeepSeek Harness.exe',exists:()=>false}),/找不到 Node/);
 assert.throws(()=>resolveNodeExecutable({root,env:{DAFEIYU_NODE_EXECUTABLE:'gone'},exists:()=>false}),/路径不存在/);
});
test('a spawn receipt is not backend readiness; health must confirm the service',async t=>{
 const root=fixture(t),calls=[],states=[];let now=0,probes=0;
 const launch=await startHostBackend({root,spawnImpl:fakeSpawn(calls),resolveNode:()=>'/selected/node.exe',onState:s=>states.push(s),clock:()=>now,wait:async n=>{now+=n;},probe:async()=>++probes<3?null:{service:'dafeiyu-panel',ok:true,pid:333}});
 assert.equal(launch.accepted,true);assert.equal((await launch.ready).phase,'ready');assert.equal(probes,3);assert.equal(states[0].phase,'starting');assert.equal(states.at(-1).panelPid,333);assert(calls[0].args.includes('-NodePath'));assert(calls[0].args.includes('/selected/node.exe'));assert.equal(calls.length,1);
});
test('missing runtime, rejected spawn and health timeout retain specific startup failures',async t=>{
 const root=fixture(t);let state;
 const missing=await startHostBackend({root,resolveNode:()=>{throw Error('找不到 Node.js');},onState:s=>state=s});assert.equal(missing.accepted,false);assert.match(state.error,/Node/);
 const denied=await startHostBackend({root,resolveNode:()=>'/node',spawnImpl:()=>{throw Error('Windows 拒绝启动后台');},onState:s=>state=s});assert.equal(denied.accepted,false);assert.match(state.error,/拒绝/);
 let now=0;const timeout=await startHostBackend({root,resolveNode:()=>'/node',spawnImpl:fakeSpawn([]),clock:()=>now,wait:async n=>{now+=n;},budgetMs:2000,probe:async()=>null});assert.match((await timeout.ready).error,/启动超时/);
});
test('plugin disposal cancels startup observation instead of reporting false readiness',async t=>{
 const root=fixture(t),abort=new AbortController();const launch=await startHostBackend({root,signal:abort.signal,resolveNode:()=>'/node',spawnImpl:fakeSpawn([]),probe:async()=>{abort.abort(Error('stopped'));return null;}});assert.equal((await launch.ready).phase,'cancelled');
});
test('a late successful health reply cannot undo startup cancellation',async t=>{
 const root=fixture(t),abort=new AbortController();const launch=await startHostBackend({root,signal:abort.signal,resolveNode:()=>'/node',spawnImpl:fakeSpawn([]),probe:async()=>{abort.abort(Error('stopped'));return {service:'dafeiyu-panel',ok:true,pid:333};}});assert.equal((await launch.ready).phase,'cancelled');
});
test('a launch that never emits spawn or error has a bounded failure',async t=>{
 const root=fixture(t);const result=await startHostBackend({root,resolveNode:()=>'/node',spawnTimeoutMs:1,spawnImpl:()=>new EventEmitter()});assert.equal(result.accepted,false);assert.match((await result.ready).error,/无回应/);
});
test('native proxy exposes the stored startup failure without claiming the backend is recovering',async t=>{
 const root=fixture(t);put(root,'companion/native-host-status.json',{backend:{phase:'failed',error:'找不到 Node.js'}});
 const proxy=createNativeProxy({owner:'test',stateDir:path.join(root,'state'),fetchImpl:async()=>{throw Error('offline');}});
 const result=await proxy(new Request('dsh-app://app/api/mhub-community/state'));assert.equal(result.status,503);const body=await result.json();assert.equal(body.code,'BACKEND_START_FAILED');assert.match(body.error,/找不到 Node/);
});
test('a failed native identity inspection stays unknown without issuing a WMI query',async()=>{
 const calls=[];const value=await processIdentity(123,'some-script.mjs',{execImpl:async(...args)=>{calls.push(args);throw Error('denied');}});assert.equal(value.matches,null);assert.equal(calls.length,1);assert(calls[0][1].includes('-File'));assert(!calls[0][1].includes('-EncodedCommand'));
});
test('a matching recovery script with a different ticket is not the old task owner',async()=>{
 const script=path.resolve('mhub-community-assistant/scripts/recover-plugin.mjs'),execImpl=async()=>({stdout:JSON.stringify({pid:123,name:'node.exe',command:'"node.exe" "'+script+'" --ticket newer',startedAt:10})});
 assert.equal((await processIdentity(123,script,{execImpl,expectedTicket:'older'})).matches,false);
 assert.equal((await processIdentity(123,script,{execImpl,expectedTicket:'newer'})).matches,true);
});
test('recovery timing uses both a total deadline and fresh heartbeat, with bounded metadata',()=>{
 const owner={ticketId:'t',at:1000,deadlineAt:Infinity};assert.equal(recoveryTiming(owner,{ticketId:'t',heartbeatAt:2000},3000).stalled,false);
 assert.equal(recoveryTiming(owner,{ticketId:'t',heartbeatAt:2000},50000).stalled,true);
 assert.equal(recoveryTiming(owner,{ticketId:'t',heartbeatAt:RECOVERY_TOTAL_MS+1000},RECOVERY_TOTAL_MS+1000).stalled,true);
 assert.equal(recoveryTiming({...owner,deadlineAt:1e15},null,3000).deadlineAt,1000+RECOVERY_TOTAL_MS);
});
test('recovery budget aborts waits and prevents late side effects after cancellation',async()=>{
 let fire,now=0,cancel=false;const budget=new RecoveryBudget({deadlineAt:1000,clock:()=>now,cancelled:async()=>cancel,schedule:fn=>(fire=fn,1),clear(){}});
 await budget.check();cancel=true;await assert.rejects(budget.check(),/取消/);let changed=false;const late=async()=>{await budget.check();changed=true;};await assert.rejects(late(),/取消/);assert.equal(changed,false);budget.close();
 const timeout=new RecoveryBudget({deadlineAt:1000,clock:()=>now,schedule:fn=>(fire=fn,1),clear(){}});const pending=new Promise((_,reject)=>timeout.signal.addEventListener('abort',()=>reject(timeout.signal.reason)));fire();await assert.rejects(pending,/超时/);timeout.close();
});
test('a verified stalled worker exits before its lock is retired and a replacement can start',async t=>{
 const root=fixture(t),owner={ticketId:'old',pid:123,worker:true,at:0,startedAt:10};put(root,'recovery.lock',owner);put(root,'recovery-status.json',{ticketId:'old',phase:'releasing',at:0});let alive=true,kills=0,now=0;
 const identity=async()=>alive?{pid:123,matches:true,startedAt:10}:{pid:123,matches:false};
 const stopped=await cancelStalledRecovery({root,owner,identity,clock:()=>now,wait:async n=>{now+=n;},graceMs:200,terminate:async()=>{assert(fs.existsSync(path.join(root,'state/recovery.lock')));kills++;alive=false;}});
 assert.equal(stopped.stopped,true);assert.equal(kills,1);assert(!fs.existsSync(path.join(root,'state/recovery.lock')));assert(fs.existsSync(path.join(root,'state/recovery-interrupted.json')));
 let launches=0;const next=await new PluginRecovery({root,identity,launch:async()=>{launches++;return 456;}}).request();assert.notEqual(next.ticketId,'old');assert.equal(launches,1);
});
test('unknown worker identities remain protected while the user may recheck them',async t=>{
 const root=fixture(t);put(root,'recovery.lock',{ticketId:'unknown',pid:123,worker:true,at:Date.now()-RECOVERY_TOTAL_MS-1,startedAt:10});let launches=0,cancels=0;
 const recovery=new PluginRecovery({root,identity:async()=>({matches:null}),cancelStalled:async()=>{cancels++;},launch:async()=>{launches++;}});
 const state=await recovery.status();assert.equal(state.active,true);assert.equal(state.canRetry,false);assert.equal(state.canRecheck,true);assert.equal(state.phase,'stalled');assert.equal((await recovery.request()).ticketId,'unknown');assert.equal(launches,0);assert.equal(cancels,0);
});
test('PID reuse and a newer ticket cannot cause the new process or reservation to be stopped',async t=>{
 const root=fixture(t),owner={ticketId:'old',pid:123,worker:true,at:0};put(root,'recovery.lock',owner);let probes=0,kills=0,now=0;
 const result=await cancelStalledRecovery({root,owner,clock:()=>now,wait:async n=>{now+=n;},graceMs:100,identity:async()=>{probes++;if(probes===1)return {matches:true,startedAt:10};put(root,'recovery.lock',{ticketId:'new',pid:999,worker:true,at:0});return {matches:true,startedAt:20};},terminate:async()=>{kills++;}});
 assert.equal(kills,0);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/recovery.lock'),'utf8')).ticketId,'new');assert.equal(result.stopped,true);
});
test('an unacknowledged recovery launch times out without leaving an endless reservation',async t=>{
 const root=fixture(t);let late;const recovery=new PluginRecovery({root,launchBudgetMs:1,launch:()=>new Promise(resolve=>late=resolve)});
 await assert.rejects(recovery.request(),/启动等待超时/);assert.equal(fs.existsSync(path.join(root,'state/recovery.lock')),false);assert.equal((await recovery.status()).active,false);
 late(123);await Promise.resolve();assert.equal(fs.existsSync(path.join(root,'state/recovery.lock')),false);
});
test('a launch timeout cannot retire a lock already claimed by its running worker',async t=>{
 const root=fixture(t);const recovery=new PluginRecovery({root,launchBudgetMs:1,identity:async()=>({matches:true,startedAt:10}),launch:ticketId=>{put(root,'recovery.lock',{ticketId,pid:123,worker:true,startedAt:10,at:Date.now()});return new Promise(()=>{});}});
 const result=await recovery.request();assert(result.pending);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/recovery.lock'),'utf8')).ticketId,result.ticketId);assert.equal((await recovery.status()).active,true);
});
test('late startup status from an unloaded or superseded plugin cannot overwrite the newer instance',t=>{
 const root=fixture(t),file=path.join(root,'state/host.json'),old=createHostStatusWriter({file,version:'old'});old.record('attached',{phase:'starting'});
 const current=createHostStatusWriter({file,version:'new'});current.record('attached',{phase:'ready'});
 assert.equal(old.record('attached',{phase:'cancelled'}),false);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,'new');
 current.close();assert.equal(current.record('attached',{phase:'failed'}),false);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).backend.phase,'ready');
});
test('internal mutex loss preserves saved auto-start intent while explicit and unknown stop requests stay stopped',async t=>{
 const root=fixture(t),syncRoot=path.join(root,'sync'),stateRoot=path.join(root,'state');fs.mkdirSync(syncRoot);let calls=[];
 fs.writeFileSync(path.join(stateRoot,'runtime-intent.json'),JSON.stringify({sync:true,voice:true}));
 const make=()=>new RuntimeResume({syncRoot,stateRoot,startup:{request:async args=>calls.push(args),cancel(){}},status:async()=>({}),clock:()=>0});
 for(const value of ['stop','user-stop','','unknown']){fs.writeFileSync(path.join(syncRoot,'stop.request'),value);await make().tick();assert.equal(calls.length,0);assert.equal(automaticStopAllowsResume(syncRoot),false);}
 fs.writeFileSync(path.join(syncRoot,'stop.request'),'mutex-lost');await make().tick();assert.deepEqual(calls,[{automatic:true}]);assert.equal(fs.readFileSync(path.join(syncRoot,'stop.request'),'utf8'),'mutex-lost');
 calls=[];fs.writeFileSync(path.join(syncRoot,'device-link-mode.json'),'false');await make().tick();assert.equal(calls.length,0);
 fs.writeFileSync(path.join(syncRoot,'device-link-mode.json'),'{"enabled":true}');fs.writeFileSync(path.join(stateRoot,'runtime-intent.json'),'{"sync":false}');await make().tick();assert.equal(calls.length,0);
});
test('an internal release marker never bypasses live controller ownership or the active recovery reservation',async t=>{
 const root=fixture(t),syncRoot=path.join(root,'sync'),stateRoot=path.join(root,'state');fs.mkdirSync(syncRoot);fs.writeFileSync(path.join(syncRoot,'stop.request'),'mutex-lost');fs.writeFileSync(path.join(stateRoot,'runtime-intent.json'),'{"sync":true}');let calls=0,current={running:true,supervised:false},recovering=false;
 const resume=new RuntimeResume({syncRoot,stateRoot,startup:{request:async()=>calls++,cancel(){}},status:async()=>current,recovery:async()=>({active:recovering})});await resume.tick();assert.equal(calls,0);assert.equal(resume.state.phase,'unmanaged');current={};recovering=true;await resume.tick();assert.equal(calls,0);assert.equal(resume.state.phase,'recovering');
});
test('automatic startup consumes an internal stop only through the existing verified startup transaction',async t=>{
 const root=fixture(t);let starts=0;fs.writeFileSync(path.join(root,'stop.request'),'mutex-lost');
 const fetchImpl=async url=>Response.json(url.endsWith('/json/version')?{'Protocol-Version':'1.3',Browser:'Chrome/140.0.0.0',webSocketDebuggerUrl:'ws://127.0.0.1:49763/devtools/browser/test'}:url.endsWith('/json/list')?[{type:'page',url:'mchose-renderer://app/customPage/prod/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:49763/devtools/page/test'}]:{});
 const startup=new SyncStartup({root,isAlive:()=>false,probe:async()=>({controller:{matches:false},supervisor:{matches:false}}),fetchImpl,startSupervisor:async()=>++starts,driverStartup:{acquire:async()=>({release(){}}),portProbe:async()=>({available:true})}});
 await startup.request({automatic:true});await startup.pending;assert.equal(starts,1);assert.equal(fs.existsSync(path.join(root,'stop.request')),false);
});
test('a new explicit stop during automatic dependency checking cancels startup and remains on disk',async t=>{
 const root=fixture(t);let starts=0;fs.writeFileSync(path.join(root,'stop.request'),'mutex-lost');
 const startup=new SyncStartup({root,isAlive:()=>false,probe:async()=>{fs.writeFileSync(path.join(root,'stop.request'),'stop');return {controller:{matches:false},supervisor:{matches:false}};},fetchImpl:async()=>new Response('{}'),startSupervisor:async()=>++starts,driverStartup:{acquire:async()=>({release(){}}),portProbe:async()=>({available:true})}});
 await startup.request({automatic:true});await startup.pending;assert.equal(starts,0);assert.equal(fs.readFileSync(path.join(root,'stop.request'),'utf8'),'stop');assert.match(JSON.parse(fs.readFileSync(path.join(root,'startup-status.json'))).message,/已停止/);
});
test('automatic startup never overrides an existing explicit stop before process or driver inspection',async t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'stop.request'),'stop');let probes=0;
 const startup=new SyncStartup({root,probe:async()=>{probes++;throw Error('must not probe');}});await startup.request({automatic:true});await startup.pending;assert.equal(probes,0);assert.equal(fs.readFileSync(path.join(root,'stop.request'),'utf8'),'stop');
});
