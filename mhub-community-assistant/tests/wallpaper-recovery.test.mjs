import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash,webcrypto} from 'node:crypto';
import {WallpaperService,wallpaperTransaction,WALLPAPER_RECOVERY_LIMIT} from '../wallpaper-service.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=','base64');
const sha=b=>createHash('sha256').update(b).digest('hex');
const mp4=Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d6d703432','hex'),Buffer.alloc(20)]);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-wallpaper-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const preset=path.join(dir,'preset.png');fs.writeFileSync(preset,png);
 const original={renderer:1,selection:{wallpaperId:'original',wallpaper:{id:'original',mediaType:'image',src:'native-original'}},config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'original'},bgWallpaperDefaultMigrationVersion:1},customHash:sha(png),customData:png.toString('base64'),marker:null};
 const f={dir,preset,original,current:structuredClone(original),calls:[],now:100000,enabled:true,restoreFails:false,crashApply:false,crashRestore:false};
 f.evaluate=async(_fn,args)=>{
  f.calls.push(args);
  if(['backup','inspect'].includes(args.operation))return structuredClone(f.current);
  // Every real write must be preceded by an on-disk intent and intact backup.
  const record=JSON.parse(fs.readFileSync(path.join(dir,'wallpapers/library.json')));assert(record.recovery);assert.equal(fs.existsSync(record.recovery.before.file),true);
  if(args.operation==='apply'){
   const id=args.asset.kind==='video'?'dafeiyu-wallpaper-'+args.asset.id:'my-wallpaper-custom';f.current={...f.current,selection:{wallpaperId:id,wallpaper:{id,mediaType:args.asset.kind==='video'?'video':'image',src:args.asset.kind==='video'?'blob:owned-video':'native-new'}},config:args.asset.kind==='video'?f.current.config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'my-wallpaper-custom'},bgWallpaperDefaultMigrationVersion:1},customHash:args.asset.kind==='video'?f.current.customHash:args.asset.sha256,marker:{id:args.asset.id}};
   if(f.crashApply){f.service.close();throw Error('simulated process termination');}return {applied:true,renderer:1};
  }
  if(f.restoreFails)throw Error('driver offline');f.current=structuredClone(args.saved);if(f.crashRestore){f.service.close();throw Error('simulated process termination');}return {restored:true,renderer:f.current.renderer};
 };
 f.reopen=()=>f.service=new WallpaperService({stateDir:dir,preset,evaluate:f.evaluate,clock:()=>f.now,link:()=>f.enabled});f.reopen();return f;
}
test('intent persistence is required before a wallpaper write can start',async t=>{
 const f=fixture(t);f.service.persist=()=>{throw Error('disk unavailable');};await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}),/disk unavailable/);assert.deepEqual(f.calls.map(x=>x.operation),['backup']);assert.deepEqual(f.current,f.original);
});
test('an interrupted apply is recovered by a fresh instance with no lost original selection',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}),/termination/);assert.equal(JSON.parse(fs.readFileSync(f.service.file)).recovery.phase,'pending');
 f.crashApply=false;f.reopen();await f.service.tick();assert.equal(f.current.selection.wallpaperId,'original');assert.equal(f.service.snapshot().recovery,null);assert.equal(f.service.snapshot().active,null);assert.equal(f.service.data.original,null);
});
test('rollback yields if the user replaced the new custom file with bytes from the old slot',async t=>{
 const f=fixture(t),different=Buffer.concat([png,Buffer.from('another wallpaper')]);
 const image=await f.service.action({operation:'import',name:'new.png',data:different.toString('base64')});
 f.crashApply=true;
 await assert.rejects(f.service.action({operation:'apply',id:image.id}),/termination/);
 const changed={...f.current,customHash:f.original.customHash,marker:null};
 f.current=structuredClone(changed);f.reopen();f.calls.length=0;
 await f.service.tick();
 assert.deepEqual(f.current,changed);
 assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);
 assert.equal(f.service.snapshot().status.phase,'user-changed');
});
test('rollback still covers a write interrupted between config and selection',async t=>{
 const f=fixture(t),different=Buffer.concat([png,Buffer.from('another wallpaper')]);
 const image=await f.service.action({operation:'import',name:'new.png',data:different.toString('base64')});
 f.crashApply=true;
 await assert.rejects(f.service.action({operation:'apply',id:image.id}),/termination/);
 f.current={...f.current,selection:f.original.selection,marker:null};
 f.reopen();f.calls.length=0;
 await f.service.tick();
 assert.equal(f.current.config.bgWallpaperV2.wallpaperId,'original');
 assert.equal(f.current.customHash,f.original.customHash);
 assert.deepEqual(f.calls.map(x=>x.operation),['inspect','restore']);
 assert.equal(f.service.snapshot().recovery,null);
});
test('an interrupted explicit restore is completed after restart and clears its original only after acknowledgement',async t=>{
 const f=fixture(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});f.crashRestore=true;await assert.rejects(f.service.action({operation:'restore'}),/termination/);assert.equal(JSON.parse(fs.readFileSync(f.service.file)).recovery.operation,'restore');
 f.crashRestore=false;f.reopen();await f.service.tick();assert.equal(f.current.selection.wallpaperId,'original');assert.equal(f.service.snapshot().canRestore,false);assert.equal(f.service.snapshot().recovery,null);
});
test('automatic rollback uses bounded backoff and stays stopped across reopen until manual retry',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));f.crashApply=false;f.restoreFails=true;f.reopen();
 await f.service.tick();assert.equal(f.service.data.recovery.attempts,1);const calls=f.calls.length;await f.service.tick();assert.equal(f.calls.length,calls);
 f.now+=5000;await f.service.tick();assert.equal(f.service.data.recovery.attempts,2);f.now+=15000;await f.service.tick();assert.equal(f.service.data.recovery.attempts,WALLPAPER_RECOVERY_LIMIT);assert.equal(f.service.snapshot().status.phase,'recovery-failed');
 const stopped=f.calls.length;f.now+=600000;await f.service.tick();f.reopen();await f.service.tick();assert.equal(f.calls.length,stopped);
 f.restoreFails=false;await f.service.action({operation:'restore'});assert.equal(f.service.snapshot().recovery,null);assert.equal(f.current.selection.wallpaperId,'original');
});
test('manual stop and the device master switch prevent background rollback',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));f.crashApply=false;f.reopen();f.enabled=false;const calls=f.calls.length;await f.service.tick();assert.equal(f.calls.length,calls);
 await f.service.action({operation:'release'});assert.equal(f.service.snapshot().recovery,null);assert.equal(f.service.snapshot().canRestore,true);f.enabled=true;await f.service.tick();assert.equal(f.calls.length,calls);assert.equal(f.current.selection.wallpaperId,'my-wallpaper-custom');
});

test('the master switch also blocks explicit wallpaper apply and restore before driver access',async t=>{
 const f=fixture(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});const saved=fs.readFileSync(f.service.file);
 f.enabled=false;f.calls.length=0;
 for(const operation of ['apply','restore'])await assert.rejects(f.service.action({operation,id:'dafeiyu-blue'}),/总开关已关闭/);
 assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readFileSync(f.service.file),saved);
 const asset=await f.service.action({operation:'import',name:'offline.png',data:png.toString('base64')});assert.ok(asset.id);
 await f.service.action({operation:'inspect'});assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);
 await f.service.action({operation:'release'});assert.equal(f.service.snapshot().active,null);
});

test('switching off during backup prevents a later wallpaper write',async t=>{
 const f=fixture(t),evaluate=f.service.evaluate;f.service.evaluate=async(fn,args)=>{const value=await evaluate(fn,args);if(args.operation==='backup')f.enabled=false;return value;};
 await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}),/总开关已关闭/);
 assert.deepEqual(f.calls.map(x=>x.operation),['backup']);assert.deepEqual(f.current,f.original);assert.equal(f.service.data.recovery,undefined);
});

test('switching off during recovery inspection preserves the journal without restoring the driver',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));f.crashApply=false;f.reopen();const evaluate=f.service.evaluate;
 f.calls.length=0;f.service.evaluate=async(fn,args)=>{const value=await evaluate(fn,args);if(args.operation==='inspect')f.enabled=false;return value;};
 await f.service.tick();assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);assert.ok(f.service.data.recovery);assert.equal(f.service.snapshot().status.phase,'recovery-paused');
 const attempts=f.service.data.recovery.attempts;await f.service.tick();assert.equal(f.service.data.recovery.attempts,attempts);
});

test('switching off during a video transfer stops subsequent chunks and releases its buffer',async t=>{
 const f=fixture(t),operations=[];let applied=false;
 f.service.evaluate=async(_fn,args)=>{operations.push(args.operation);if(args.operation==='transfer-write'){f.enabled=false;return {received:Buffer.from(args.data,'base64').length+args.offset};}return {ready:true};};
 await assert.rejects(f.service.withVideo(Buffer.alloc(300000),()=>{applied=true;}),/总开关已关闭/);
 assert.equal(applied,false);assert.deepEqual(operations,['transfer-begin','transfer-write','transfer-release']);
});

test('the disabled wallpaper UI blocks driver writes while preserving local-library and release controls',async()=>{
 const context={window:{DafeiyuI18n:{h:s=>s,t:s=>s,number:n=>String(n),message:s=>s}}};vm.createContext(context);
 vm.runInContext(fs.readFileSync(new URL('../panel/wallpaper.js',import.meta.url),'utf8'),context);
 const html=context.window.DafeiyuWallpapers.render({busy:new Set(),data:{controls:{deviceLink:{enabled:false}},wallpapers:{assets:[{id:'dafeiyu-blue',preset:true,name:'blue',kind:'static'}],active:{id:'dafeiyu-blue'},canRestore:true,status:{phase:'applied'}}}});
 const button=action=>{const tag=[...html.matchAll(/<button\b[^>]*>/g)].map(x=>x[0]).find(s=>s.includes('data-action="'+action+'"'));assert.ok(tag,action);return tag;};
 for(const action of ['wallpaper-apply','wallpaper-restore'])assert.match(button(action),/\bdisabled\b/);
 for(const action of ['wallpaper-inspect','wallpaper-release'])assert.doesNotMatch(button(action),/\bdisabled\b/);
 assert.match(html,/总开关已关闭/);
});
test('a native change during downtime is preserved instead of overwritten by rollback',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));f.crashApply=false;f.current={...f.current,selection:{wallpaperId:'user-chosen'},customHash:'f'.repeat(64)};f.reopen();f.calls.length=0;await f.service.tick();
 assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);assert.equal(f.service.snapshot().status.phase,'user-changed');assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().canRestore,true);assert.equal(f.current.selection.wallpaperId,'user-chosen');
});
test('storage failure during recovery stops background writes and retains its durable record',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));f.reopen();f.service.persist=()=>{throw Error('disk unavailable');};f.calls.length=0;await f.service.tick();await f.service.tick();assert.deepEqual(f.calls,[]);assert.equal(f.service.snapshot().status.phase,'recovery-failed');assert.equal(JSON.parse(fs.readFileSync(f.service.file)).recovery.phase,'pending');
});
test('the public recovery status does not expose original content or filesystem paths',async t=>{
 const f=fixture(t);f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));const s=f.service.snapshot();assert.equal(s.recovery.attempts,0);assert.equal(JSON.stringify(s).includes(f.dir),false);assert.equal(JSON.stringify(s).includes('customData'),false);
});
test('recovery rebuilds a previous managed video from durable bytes instead of reusing its expired blob',async t=>{
 const f=fixture(t),a=await f.service.action({operation:'import',name:'video.mp4',data:mp4.toString('base64')});await f.service.action({operation:'apply',id:a.id});f.crashApply=true;await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}));
 f.crashApply=false;f.reopen();await f.service.tick();const restore=f.calls.filter(x=>x.operation==='restore').at(-1);assert.equal(restore.saved.managedAssetId,a.id);assert.equal(restore.saved.video.data,mp4.toString('base64'));assert.equal(f.service.snapshot().active.id,a.id);
});
test('a real terminated worker leaves a recoverable journal before its acknowledgement commit',async t=>{
 const f=fixture(t),seed=path.join(f.dir,'native.json');fs.writeFileSync(seed,JSON.stringify(f.original));
 const worker=path.join(f.dir,'worker.mjs');fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {WallpaperService} from ${JSON.stringify(new URL('../wallpaper-service.mjs',import.meta.url).href)};const dir=process.argv[2],native=path.join(dir,'native.json');setInterval(()=>{},1000);const service=new WallpaperService({stateDir:dir,preset:path.join(dir,'preset.png'),link:()=>true,evaluate:async(_fn,args)=>{const before=JSON.parse(fs.readFileSync(native));if(args.operation==='backup')return before;if(args.operation==='apply'){fs.writeFileSync(native,JSON.stringify({...before,selection:{wallpaperId:'my-wallpaper-custom'},config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'my-wallpaper-custom'},bgWallpaperDefaultMigrationVersion:1},customHash:args.asset.sha256}));process.send({written:true});await new Promise(()=>{});}}});service.action({operation:'apply',id:'dafeiyu-blue'}).catch(e=>{process.send({error:e.message});process.exit(1)});`);
 const child=fork(worker,[f.dir],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill();});
 const [message]=await Promise.race([once(child,'message'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Worker did not reach write checkpoint')),5000);timer.unref();})]);assert.equal(message.written,true);const ended=once(child,'exit');child.kill('SIGKILL');await ended;
 assert.equal(JSON.parse(fs.readFileSync(f.service.file)).recovery.phase,'pending');f.current=JSON.parse(fs.readFileSync(seed));f.reopen();await f.service.tick();assert.equal(f.current.selection.wallpaperId,'original');assert.equal(f.service.snapshot().recovery,null);
});
test('native restoration creates a fresh managed-video object URL',async()=>{
 const cfg={bgWallpaperV2:{schemaVersion:2,wallpaperId:'original'},bgWallpaperDefaultMigrationVersion:1},w={selection:null,setSelectedWallpaper(v){this.selection=v;}},pc={systemConfig:cfg,updateSystemConfig(v){this.systemConfig=v;}},stores=new Map([['wallpaperStore',w],['pcConfigStore',pc]]),window={electronAPI:{saveBgImg:async()=>true,setConfig:async()=>cfg,getConfig:async()=>cfg}};
 const args={operation:'restore',saved:{config:cfg,selection:{wallpaper:{id:'dafeiyu-wallpaper-video',mediaType:'video',src:'blob:expired'}},marker:{id:'video'},video:{mime:'video/mp4',data:mp4.toString('base64')}}};
 const receipt=await vm.runInNewContext('('+wallpaperTransaction.toString()+')(args)',{window,document:{querySelector:()=>({__vue_app__:{config:{globalProperties:{$pinia:{_s:stores}}}}})},performance:{timeOrigin:2},args,crypto:webcrypto,Uint8Array,URL,Blob,atob,btoa,Date,setTimeout,clearTimeout});assert.equal(receipt.restored,true);assert.notEqual(w.selection.wallpaper.src,'blob:expired');assert.deepEqual(Buffer.from(await(await fetch(w.selection.wallpaper.src)).arrayBuffer()),mp4);URL.revokeObjectURL(w.selection.wallpaper.src);
});
test('renderer rollback waits for the cancelled prior IPC and prevents its late selection write',async()=>{
 let finishFirst,saveCalls=0,selectedWrites=0;const cfg={bgWallpaperV2:{schemaVersion:2,wallpaperId:'original'},bgWallpaperDefaultMigrationVersion:1};const w={selection:{wallpaperId:'original'},customWallpaper:{status:'available',src:'native'},resolveCustomPreviewSrc:async s=>s,setCustomWallpaper(v){this.customWallpaper=v;},setSelectedWallpaper(s){this.selection=s;selectedWrites++;}};
 const pc={systemConfig:cfg,updateSystemConfig(v){this.systemConfig=v;}},stores=new Map([['wallpaperStore',w],['pcConfigStore',pc]]),window={electronAPI:{saveBgImg:async()=>++saveCalls===1?new Promise(r=>{finishFirst=r;}):true,getBgImg:async()=>'native',setConfig:async(_name,v)=>v,getConfig:async()=>cfg}};
 const context=vm.createContext({window,document:{querySelector:q=>q==='#app'?{__vue_app__:{config:{globalProperties:{$pinia:{_s:stores}}}}}:null},fetch:async()=>({arrayBuffer:async()=>Uint8Array.from(png).buffer}),performance:{timeOrigin:1},crypto:webcrypto,Uint8Array,URL,Blob,atob,btoa,Date,setTimeout,clearTimeout});
 context.args={operation:'apply',asset:{id:'new',kind:'static',sha256:sha(png),name:'new'},file:'new.png'};const first=vm.runInContext('('+wallpaperTransaction.toString()+')(args)',context);const rejected=assert.rejects(first,/后续恢复接替/);
 context.args={operation:'restore',saved:{file:'original.png',customHash:sha(png),config:cfg,selection:{wallpaper:{id:'original',mediaType:'image',src:'native'}}}};const second=vm.runInContext('('+wallpaperTransaction.toString()+')(args)',context);assert.equal(saveCalls,1);finishFirst(true);await rejected;assert.equal((await second).restored,true);assert.equal(saveCalls,2);assert.equal(selectedWrites,1);assert.equal(w.selection.wallpaperId,'original');assert.equal(window.__dafeiyuWallpaperPending,undefined);
});
test('multi-megabyte native backups use bounded chunks, verify exact bytes and release renderer memory',async t=>{
 const f=fixture(t),bytes=Buffer.concat([png,Buffer.alloc(2*1024*1024,31)]),w={selection:{wallpaperId:'original'},customWallpaper:{status:'available',src:'native'},setSelectedWallpaper(){}},pc={systemConfig:f.original.config},stores=new Map([['wallpaperStore',w],['pcConfigStore',pc]]),window={electronAPI:{saveBgImg(){}}};
 const context=vm.createContext({window,document:{querySelector:()=>({__vue_app__:{config:{globalProperties:{$pinia:{_s:stores}}}}})},performance:{timeOrigin:1},fetch:async()=>({arrayBuffer:async()=>Uint8Array.from(bytes).buffer}),crypto:webcrypto,Uint8Array,atob,btoa,Date});const sizes=[];
 f.service.evaluate=async(_fn,args)=>{context.args=args;const result=await vm.runInContext('('+wallpaperTransaction.toString()+')(args)',context);sizes.push(JSON.stringify(result).length);return result;};
 const saved=await f.service.backup();assert.deepEqual(fs.readFileSync(saved.file),bytes);assert.equal(saved.customHash,sha(bytes));assert.equal(saved.transferId,undefined);assert.equal(window.__dafeiyuWallpaperTransfers.size,0);assert.ok(sizes.length>16);assert.ok(Math.max(...sizes)<180000);
 const evaluate=f.service.evaluate;f.service.evaluate=async(fn,args)=>{const result=await evaluate(fn,args);if(args.operation==='transfer-read')return {...result,data:'AA=='};return result;};await assert.rejects(f.service.backup(),/备份校验失败/);assert.equal(window.__dafeiyuWallpaperTransfers.size,0);assert.deepEqual(fs.readFileSync(saved.file),bytes);
});
test('large video uploads are sequential, bounded, reject missing chunks and release cancelled transfers',async t=>{
 const f=fixture(t),bytes=Buffer.concat([mp4,Buffer.alloc(2*1024*1024,17)]),window={electronAPI:{saveBgImg(){}}},stores=new Map([['wallpaperStore',{setSelectedWallpaper(){}}],['pcConfigStore',{}]]),context=vm.createContext({window,document:{querySelector:()=>({__vue_app__:{config:{globalProperties:{$pinia:{_s:stores}}}}})},Uint8Array,atob,btoa,Date});const sizes=[];
 f.service.evaluate=async(_fn,args)=>{context.args=args;sizes.push(JSON.stringify(args).length);return vm.runInContext('('+wallpaperTransaction.toString()+')(args)',context);};
 await f.service.withVideo(bytes,async({transferId})=>{const transfer=window.__dafeiyuWallpaperTransfers.get(transferId);assert.equal(transfer.received,bytes.length);assert.deepEqual(Buffer.from(transfer.bytes),bytes);await assert.rejects(f.service.evaluate(null,{operation:'transfer-write',transferId,offset:0,data:'AAAA'}),/传输无效/);});assert.equal(window.__dafeiyuWallpaperTransfers.size,0);assert.ok(Math.max(...sizes)<180000);
 const evaluate=f.service.evaluate;f.service.evaluate=async(fn,args)=>{if(args.operation==='transfer-write')throw Error('connection lost');return evaluate(fn,args);};await assert.rejects(f.service.withVideo(bytes,()=>assert.fail('must not apply incomplete video')),/connection lost/);assert.equal(window.__dafeiyuWallpaperTransfers.size,0);
});
test('video cold boot restores against its immediate native base and preserves the older original backup',async t=>{
 const f=fixture(t),oldOriginal={...f.original,config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'older-original'}}};f.service.data.original=structuredClone(oldOriginal);
 const base={...f.original,config:{...f.original.config,bgWallpaperV2:{schemaVersion:2,wallpaperId:'my-wallpaper-custom'}},selection:{wallpaperId:'my-wallpaper-custom',wallpaper:{id:'my-wallpaper-custom',mediaType:'image',src:'blue-native'}},marker:null};f.current=structuredClone(base);
 const video=await f.service.action({operation:'import',name:'video.mp4',data:mp4.toString('base64')});await f.service.action({operation:'apply',id:video.id});
 f.current={...structuredClone(base),renderer:2};f.reopen();f.calls.length=0;await f.service.tick();assert.deepEqual(f.calls.map(x=>x.operation),['inspect','backup','apply']);assert.equal(f.service.snapshot().active?.id,video.id);assert.deepEqual(f.service.data.original,oldOriginal);
});
test('video cold boot yields when the user changes the immediate native base while preserving older recovery data',async t=>{
 const f=fixture(t);f.service.data.original={...f.original,config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'older-original'}}};const video=await f.service.action({operation:'import',name:'video.mp4',data:mp4.toString('base64')});await f.service.action({operation:'apply',id:video.id});
 f.current={...f.original,renderer:2,customHash:'f'.repeat(64),selection:{wallpaperId:'user-choice'},config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'user-choice'}}};f.reopen();f.calls.length=0;await f.service.tick();assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().status.phase,'user-changed');assert.equal(f.service.data.original.config.bgWallpaperV2.wallpaperId,'older-original');
});
test('a legacy video can learn its native restart base only while its owned video is still selected',async t=>{
 const f=fixture(t),video=await f.service.action({operation:'import',name:'video.mp4',data:mp4.toString('base64')});await f.service.action({operation:'apply',id:video.id});delete f.service.data.active.resumeBase;f.service.data.original={...f.original,config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'older-original'}}};f.service.persist();
 f.reopen();f.calls.length=0;await f.service.tick();assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);assert.equal(f.service.data.active.resumeBase.customHash,f.original.customHash);assert.equal(f.service.data.original.config.bgWallpaperV2.wallpaperId,'older-original');
 f.current={...f.original,renderer:2};f.reopen();f.calls.length=0;await f.service.tick();assert.deepEqual(f.calls.map(x=>x.operation),['inspect','backup','apply']);assert.equal(f.service.snapshot().active.id,video.id);
});
