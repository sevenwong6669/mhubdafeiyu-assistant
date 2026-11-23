import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeResume} from '../runtime-resume.mjs';
import {runtimeVersion,runtimeSources} from '../../harness-mhub-sync/runtime-version.mjs';
import {resolveControlPython,resolveMhubExecutable} from '../../harness-mhub-sync/startup.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fish-resume-')),syncRoot=path.join(root,'sync'),stateRoot=path.join(root,'state');
 await fs.mkdir(syncRoot);await fs.mkdir(stateRoot);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let now=0,requests=0,current={},recovering=false;
 const startup={request:async()=>{requests++;},cancel(){this.cancelled=true;}};
 const resume=new RuntimeResume({syncRoot,stateRoot,startup,status:()=>current,recovery:()=>({active:recovering}),clock:()=>now});
 return {root,syncRoot,stateRoot,startup,resume,get requests(){return requests;},advance(ms){now+=ms;},status(v){current=v;},recovery(v){recovering=v;},intent:async v=>fs.writeFile(path.join(stateRoot,'runtime-intent.json'),JSON.stringify(v))};
}
test('saved enabled intent resumes once, retries with backoff and defers to the existing guard',async t=>{
 const f=await fixture(t);await f.intent({sync:true,voice:true});
 await Promise.all([f.resume.tick(),f.resume.tick()]);assert.equal(f.requests,1);
 await f.resume.tick();assert.equal(f.requests,1);f.advance(10000);await f.resume.tick();assert.equal(f.requests,2);
 f.status({supervised:true,ready:true});f.advance(30000);await f.resume.tick();assert.equal(f.requests,2);assert.equal(f.resume.state.phase,'running');
});
test('missing intent, explicit stops, master-off and recovery reservations never launch a controller',async t=>{
 const f=await fixture(t);await f.resume.tick();assert.equal(f.requests,0);
 await f.intent({sync:false,voice:true});await f.resume.tick();assert.equal(f.requests,0);
 await f.intent({sync:true});await fs.writeFile(path.join(f.syncRoot,'stop.request'),'stop');await f.resume.tick();assert.equal(f.requests,0);
 await fs.unlink(path.join(f.syncRoot,'stop.request'));await fs.writeFile(path.join(f.syncRoot,'device-link-mode.json'),'{"enabled":false}');await f.resume.tick();assert.equal(f.requests,0);
 await fs.writeFile(path.join(f.syncRoot,'device-link-mode.json'),'{"enabled":true}');f.recovery(true);await f.resume.tick();assert.equal(f.requests,0);assert.equal(f.resume.state.phase,'recovering');
});
test('an orphan live controller stays protected and shutdown cancels pending startup',async t=>{
 const f=await fixture(t);await f.intent({sync:true});f.status({running:true,supervised:false});await f.resume.tick();assert.equal(f.requests,0);assert.equal(f.resume.state.phase,'unmanaged');
 f.status({});f.resume.close();await f.resume.tick();assert.equal(f.requests,0);assert.equal(f.startup.cancelled,true);
});
test('failed startup is bounded and corrupt intent is reported without overwriting it',async t=>{
 const f=await fixture(t);await f.intent({sync:true});f.startup.request=async()=>{throw Error('dependency unavailable');};
 await f.resume.tick();assert.equal(f.resume.state.phase,'failed');assert.equal(f.resume.state.nextRetryAt,10000);
 const file=path.join(f.stateRoot,'runtime-intent.json');await fs.writeFile(file,'broken');f.advance(20000);await f.resume.tick();assert.match(f.resume.state.error,/配置无法读取/);assert.equal(await fs.readFile(file,'utf8'),'broken');
});
test('native helper and imported service changes affect the code version; settings do not',async t=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'fish-code-version-'));t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
 const root=path.join(workspace,'sync');await fs.mkdir(root);await fs.mkdir(path.join(workspace,'mhub-community-assistant/scripts'),{recursive:true});
 await fs.writeFile(path.join(workspace,'mhub-community-assistant/scripts/start-panel.mjs'),'');
 await fs.writeFile(path.join(workspace,'mhub-community-assistant/native-host.mjs'),'');
 await fs.mkdir(path.join(root,'phone'));await fs.mkdir(path.join(root,'voice-chat'));
 for(const file of ['supervisor.mjs','optimized.mjs','runtime-version.mjs','voice-chat/server.mjs','Hotkey-Bindings.ps1','voice-chat/Start.ps1'])await fs.writeFile(path.join(root,file),'');
 await fs.writeFile(path.join(root,'optimized.mjs'),"import {value} from './screen.mjs?v=1';");
 await fs.writeFile(path.join(root,'screen.mjs'),"export {value} from './light-session.mjs';");await fs.writeFile(path.join(root,'light-session.mjs'),'export const value=1;');
 await fs.writeFile(path.join(root,'voice-chat/worker.py'),'first');const first=runtimeVersion(root);
 await fs.writeFile(path.join(root,'light-session.mjs'),'export const value=2;');assert.notEqual(runtimeVersion(root),first);const second=runtimeVersion(root);
 await fs.writeFile(path.join(root,'voice-chat/worker.py'),'second');assert.notEqual(runtimeVersion(root),second);const third=runtimeVersion(root);
 await fs.writeFile(path.join(root,'task-lights.json'),'{"brightness":30}');await fs.writeFile(path.join(root,'voice-chat/config.json'),'{}');assert.equal(runtimeVersion(root),third);
 await fs.writeFile(path.join(workspace,'mhub-community-assistant/scripts/start-panel.mjs'),'// new panel startup');assert.notEqual(runtimeVersion(root),third);
 assert.ok(runtimeSources(root).includes(path.join(root,'light-session.mjs')));
 const beforeHost=runtimeVersion(root);await fs.writeFile(path.join(workspace,'mhub-community-assistant/native-host.mjs'),'// updated host');assert.notEqual(runtimeVersion(root),beforeHost);
});
test('runtime discovery respects explicit overrides and the same release settings as the installer',async t=>{
 const f=await fixture(t),python=path.join(f.root,'python.exe'),mhub=path.join(f.root,'MCHOSE HUB.exe');await fs.writeFile(python,'');await fs.writeFile(mhub,'');
 await fs.writeFile(path.join(f.root,'runtime.settings.json'),JSON.stringify({python,mhub}));
 assert.equal(await resolveControlPython({root:f.syncRoot,env:{}}),python);assert.equal(await resolveMhubExecutable({root:f.syncRoot,env:{}}),mhub);
 await assert.rejects(resolveControlPython({root:f.syncRoot,env:{DAFEIYU_CONTROL_PYTHON:path.join(f.root,'missing.exe')}}),/Python/);
 await assert.rejects(resolveMhubExecutable({root:f.syncRoot,env:{DAFEIYU_MHUB_EXECUTABLE:path.join(f.root,'missing.exe')}}),/找不到/);
 await fs.writeFile(path.join(f.root,'runtime.settings.json'),'broken');await assert.rejects(resolveControlPython({root:f.syncRoot,env:{}}),/配置无法读取/);
 assert.equal(await resolveControlPython({root:f.syncRoot,env:{DAFEIYU_CONTROL_PYTHON:python}}),python);
});
