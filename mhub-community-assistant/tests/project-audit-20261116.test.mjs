import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {WallpaperService,wallpaperTransaction} from '../wallpaper-service.mjs';
import {PanelService} from '../panel-service.mjs';
import {deviceInventory} from '../devices.mjs';
import {apply as applyNativeHost} from '../native-host.mjs';
import {LearningClient} from '../learning-client.mjs';
import {runtimeVersion,runtimeSources} from '../../harness-mhub-sync/runtime-version.mjs';
import {createHostStatusWriter} from '../host-startup.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=','base64');
const sha=b=>createHash('sha256').update(b).digest('hex');
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-audit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function wallpaper(t){
 const dir=temporary(t),preset=path.join(dir,'preset.png'),calls=[];fs.writeFileSync(preset,png);
 const original={renderer:1,selection:{wallpaperId:'original'},customHash:sha(png),customData:png.toString('base64'),config:{bgWallpaperV2:{wallpaperId:'original'}}};
 const service=new WallpaperService({stateDir:dir,preset,link:()=>true,evaluate:async(_fn,args)=>{calls.push(args);return ['backup','inspect'].includes(args.operation)?structuredClone(original):args.operation==='restore'?{restored:true}:{applied:true,renderer:1};}});
 return {service,calls,original};
}
test('a corrupt existing wallpaper backup blocks replacement before any driver write',async t=>{
 const f=wallpaper(t),saved=await f.service.backup();fs.writeFileSync(saved.file,Buffer.from('damaged'));f.calls.length=0;
 await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}),/备份.*校验/);
 assert.deepEqual(f.calls.map(x=>x.operation),['backup']);assert.equal(fs.readFileSync(saved.file,'utf8'),'damaged');
});
test('restoring a modified backup never submits it to M HUB or drops the recovery record',async t=>{
 const f=wallpaper(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});const original=f.service.data.original;fs.writeFileSync(original.file,Buffer.from('damaged'));f.calls.length=0;
 await assert.rejects(f.service.action({operation:'restore'}),/备份.*校验/);assert.deepEqual(f.calls,[]);assert.equal(f.service.data.original,original);assert.equal(f.service.snapshot().canRestore,true);
});
test('a wallpaper backup path outside its owned directory is rejected before driver access',async t=>{
 const f=wallpaper(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});f.service.data.original.file=f.service.preset;f.calls.length=0;
 await assert.rejects(f.service.action({operation:'restore'}),/备份.*校验/);assert.deepEqual(f.calls,[]);
});
test('failed wallpaper registry persistence rolls back without inventing an active wallpaper',async t=>{
 const f=wallpaper(t),persist=f.service.persist.bind(f.service);let writes=0;f.service.persist=value=>{if(++writes===2)throw Error('read-only storage');return persist(value);};
 await assert.rejects(f.service.action({operation:'apply',id:'dafeiyu-blue'}),/read-only/);
 assert.deepEqual(f.calls.map(x=>x.operation),['backup','apply','inspect','restore']);assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().canRestore,false);assert.equal(f.service.data.recovery,null);
});
test('restore retains the original and active record if saving its acknowledgement fails',async t=>{
 const f=wallpaper(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});const original=f.service.data.original,active=f.service.data.active;
 f.service.persist=()=>{throw Error('read-only storage');};await assert.rejects(f.service.action({operation:'restore'}),/read-only/);
 assert.equal(f.service.data.original,original);assert.equal(f.service.data.active,active);assert.equal(f.service.snapshot().canRestore,true);
});
test('failed release or removal preserves library records and owned media files',async t=>{
 const f=wallpaper(t),asset=await f.service.action({operation:'import',name:'test.png',data:png.toString('base64')});await f.service.action({operation:'apply',id:'dafeiyu-blue'});
 f.service.persist=()=>{throw Error('read-only storage');};await assert.rejects(f.service.action({operation:'release'}),/read-only/);assert.equal(f.service.snapshot().active.id,'dafeiyu-blue');
 await assert.rejects(f.service.action({operation:'remove',id:asset.id}),/read-only/);assert.equal(f.service.asset(asset.id).id,asset.id);assert.equal(fs.existsSync(f.service.assetFile(f.service.asset(asset.id))),true);
});
test('reopening a saved wallpaper session does not claim that no wallpaper was selected or that the driver was verified',async t=>{
 const f=wallpaper(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});
 const reopened=new WallpaperService({stateDir:path.dirname(f.service.dir),preset:f.service.preset});
 assert.equal(reopened.snapshot().active.id,'dafeiyu-blue');assert.equal(reopened.snapshot().canRestore,true);assert.equal(reopened.snapshot().status.phase,'unverified');
});
test('checking wallpaper state yields to manual native changes without writing the driver or removing the original backup',async t=>{
 const f=wallpaper(t);await f.service.action({operation:'apply',id:'dafeiyu-blue'});f.calls.length=0;
 await f.service.action({operation:'inspect'});assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().status.phase,'user-changed');assert.equal(f.service.snapshot().canRestore,true);assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);
});
test('native restore verifies actual returned bytes before changing wallpaper selection',async()=>{
 let changed=false;const w={customWallpaper:null,resolveCustomPreviewSrc:async s=>s,setCustomWallpaper(v){this.customWallpaper=v;},setSelectedWallpaper(){changed=true;}};
 const pc={systemConfig:{},updateSystemConfig(){changed=true;}},stores=new Map([['wallpaperStore',w],['pcConfigStore',pc]]);
 const context={document:{querySelector:()=>({__vue_app__:{config:{globalProperties:{$pinia:{_s:stores}}}}})},window:{electronAPI:{saveBgImg:async()=>true,getBgImg:async()=>'bad-copy',setConfig:async()=>{changed=true;}}},crypto:webcrypto,fetch:async()=>({arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer}),performance:{timeOrigin:1},args:{operation:'restore',saved:{file:'backup.png',customHash:sha(png),config:{},selection:{wallpaper:{id:'my-wallpaper-custom'}}}},Uint8Array,URL};
 await assert.rejects(vm.runInNewContext('('+wallpaperTransaction.toString()+')(args)',context),/读回.*校验/);assert.equal(changed,false);
});
test('an enabled internal QQ channel never probes an unrelated old AstrBot server',async t=>{
 const dir=temporary(t),calls=[];fs.writeFileSync(path.join(dir,'qq-provider.json'),JSON.stringify({provider:'astrbot'}));
 const service=new PanelService({stateDir:dir,probeImpl:async url=>{calls.push(url);return {reachable:false};},inventory:async()=>({devices:[],fetchedAt:new Date().toISOString()}),controls:{snapshot:async()=>({})}});t.after(()=>service.dispose());
 service.companion.snapshot=()=>({config:{values:{qq:{enabled:true}}}});service.companion.qq.online=true;service.companion.qq.loginVerified=true;
 const state=await service.state();assert.equal(state.connections.qq.provider,'internal');assert.equal(state.connections.qq.ready,true);assert.equal(calls.some(url=>url.includes(':6199')),false);
});
async function panel(fetch){
 const nodes=new Map();const node=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',innerHTML:'',style:{}});return nodes.get(s);};
 const context={document:{querySelector:node,addEventListener(){},hidden:false,activeElement:{tagName:'BODY'}},window:{},fetch,AbortSignal,setTimeout:()=>1,clearTimeout(){},console};vm.createContext(context);
 const source=fs.readFileSync(new URL('../panel/panel.js',import.meta.url),'utf8').replace(/void refresh\(\)\.catch[\s\S]*$/,'');vm.runInContext(source,context);context.window.DafeiyuControls={getTab:()=> 'wallpaper'};vm.runInContext('render=()=>{renderCount++};renderDrawer=()=>{};var renderCount=0;',context);
 return {run:s=>vm.runInContext(s,context),nodes};
}
test('wallpaper polling preserves media elements until relevant state changes; explicit refresh still renders',async()=>{
 let phase='idle';const f=await panel(async()=>Response.json({token:'token',counts:{records:0},inventory:{devices:[]},wallpapers:{assets:[],status:{phase}}}));
 await f.run('pollOnce()');assert.equal(f.run('renderCount'),1);await f.run('pollOnce()');assert.equal(f.run('renderCount'),1);
 phase='failed';await f.run('pollOnce()');assert.equal(f.run('renderCount'),2);await f.run('refresh()');assert.equal(f.run('renderCount'),3);
});
test('a timed-out write is reported as unconfirmed and recovery retries only reads',async()=>{
 const methods=[];const f=await panel(async(_url,o)=>{methods.push(o.method);if(o.method==='POST')throw new DOMException('Timed out','TimeoutError');return Response.json({token:'token',counts:{records:0},inventory:{devices:[]}});});
 f.run('state.data={token:"token"}');await f.run("perform('write',()=>request('/controls/action',{action:'example'}))");
 assert.match(f.nodes.get('#notice').textContent,/结果尚未确认/);await f.run('pollOnce()');assert.deepEqual(methods,['POST','GET']);
});

test('manual refresh upgrades an already pending read without duplicating the request',async()=>{
 let release,calls=0;const f=await panel(()=>{calls++;return new Promise(resolve=>release=resolve);});
 const background=f.run('refresh(()=>false)'),manual=f.run('refresh()');
 assert.equal(calls,1);
 release(Response.json({token:'token',counts:{records:0},inventory:{devices:[]}}));
 await Promise.all([background,manual]);
 assert.equal(f.run('renderCount'),1);assert.equal(f.run('state.data.token'),'token');
});

test('coalesced conditional refresh callers retain their render decisions',async()=>{
 let release;const f=await panel(()=>new Promise(resolve=>release=resolve));
 const background=f.run('refresh(false)'),conditional=f.run('refresh(previous=>!previous)');
 release(Response.json({token:'token',counts:{records:0},inventory:{devices:[]}}));
 await Promise.all([background,conditional]);assert.equal(f.run('renderCount'),1);
});

test('render suppression remains effective and render requests expire after a failed read',async()=>{
 let release,calls=0;const f=await panel(()=>{calls++;return new Promise((resolve,reject)=>release={resolve,reject});});
 const first=f.run('refresh(false)'),second=f.run('refresh(false)');
 release.resolve(Response.json({token:'one',counts:{records:0},inventory:{devices:[]}}));
 await Promise.all([first,second]);assert.equal(f.run('renderCount'),0);assert.equal(calls,1);
 const failed=f.run('refresh()');release.reject(new TypeError('Failed to fetch'));await assert.rejects(failed);
 const next=f.run('refresh(false)');release.resolve(Response.json({token:'two',counts:{records:0},inventory:{devices:[]}}));
 await next;assert.equal(f.run('renderCount'),0);assert.equal(f.run('state.data.token'),'two');assert.equal(calls,3);
});

test('unreadable write receipt is unconfirmed and retries never resubmit the action',async()=>{
 const methods=[];const f=await panel(async(_url,o)=>{methods.push(o.method);return o.method==='POST'?new Response('<html>Proxy unavailable</html>',{status:200}):Response.json({token:'token',counts:{records:0},inventory:{devices:[]}});});
 f.run('state.data={token:"token"}');await f.run("perform('write',()=>request('/controls/action',{action:'example'}))");
 assert.match(f.nodes.get('#notice').textContent,/结果尚未确认/);
 await f.run('pollOnce()');assert.deepEqual(methods,['POST','GET']);
 assert.equal(f.nodes.get('#notice').textContent,'');
});

test('unreadable state response enters reconnect mode and clears only its own notice after recovery',async()=>{
 let invalid=true;const f=await panel(async()=>invalid?new Response('broken json',{status:503}):Response.json({token:'token',counts:{records:0},inventory:{devices:[]}}));
 await f.run('pollOnce()');assert.equal(f.run('reconnecting'),true);
 invalid=false;await f.run('pollOnce()');assert.equal(f.run('reconnecting'),false);assert.equal(f.nodes.get('#notice').textContent,'');
});

test('malformed live device inventory cannot replace the last valid saved inventory',async t=>{
 const dir=temporary(t),file=path.join(dir,'devices-snapshot.json');
 const saved={source:'M-HUB-live',fetchedAt:'2026-11-01T00:00:00Z',devices:[{model:'Ace 75',family:'keyboard'}]};fs.writeFileSync(file,JSON.stringify(saved));const before=fs.readFileSync(file);
 for(const malformed of [{devices:'invalid'},null,42,[null,{}]]){
  const result=await deviceInventory(dir,{requireLink:()=>{},evaluateImpl:async()=>malformed});
  assert.equal(result.stale,true);assert.deepEqual(result.devices,saved.devices);assert.deepEqual(fs.readFileSync(file),before);
 }
});

test('a live device read remains usable when only its cache commit fails',async t=>{
 const dir=temporary(t),file=path.join(dir,'devices-snapshot.json'),old={fetchedAt:'2026-11-01T00:00:00Z',devices:[{model:'Old keyboard',family:'keyboard'}]};fs.writeFileSync(file,JSON.stringify(old));const before=fs.readFileSync(file),rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(from,to)=>{if(to===file)throw Object.assign(Error('cache disk unavailable'),{code:'EACCES'});return rename(from,to);});
 const current=[{model:'GT 75',family:'keyboard'}],result=await deviceInventory(dir,{requireLink:()=>{},evaluateImpl:async()=>current});
 assert.equal(result.stale,false);assert.deepEqual(result.devices,current);assert.match(result.cacheError,/缓存/);assert.deepEqual(fs.readFileSync(file),before);
 assert.deepEqual(fs.readdirSync(dir).filter(name=>name.endsWith('.tmp')),[]);
});

test('a malformed cached device list does not escape into callers and remains intact on disk',async t=>{
 const dir=temporary(t),file=path.join(dir,'devices-snapshot.json'),content=JSON.stringify({devices:{broken:true}});fs.writeFileSync(file,content);
 const result=await deviceInventory(dir,{requireLink:()=>{},evaluateImpl:async()=>{throw Error('driver unavailable');}});
 assert.equal(result.stale,true);assert.deepEqual(result.devices,[]);assert.equal(result.source,'unavailable');assert.equal(fs.readFileSync(file,'utf8'),content);
});

test('cancelled inventory and a disabled master switch cannot write the cache or query the driver',async t=>{
 const dir=temporary(t),file=path.join(dir,'devices-snapshot.json'),saved=JSON.stringify({devices:[{model:'Ace 75',family:'keyboard'}]});fs.writeFileSync(file,saved);let calls=0;
 const disabled=await deviceInventory(dir,{requireLink:()=>{throw Error('disabled');},evaluateImpl:async()=>{calls++;return [];}});
 assert.equal(disabled.stale,true);assert.equal(calls,0);assert.equal(fs.readFileSync(file,'utf8'),saved);
 const abort=new AbortController();await assert.rejects(deviceInventory(dir,{signal:abort.signal,requireLink:()=>{},evaluateImpl:async()=>{abort.abort(Error('cancelled'));return [{model:'late result'}];}}),/cancelled/);
 assert.equal(fs.readFileSync(file,'utf8'),saved);assert.deepEqual(fs.readdirSync(dir),['devices-snapshot.json']);
 const empty=await deviceInventory(dir,{requireLink:()=>{},evaluateImpl:async()=>[]});assert.equal(empty.stale,false);assert.deepEqual(empty.devices,[]);
});

test('unloading the host during backend startup cannot start a late learning scheduler or connection',async t=>{
 const dir=temporary(t),effects=[];let starts=0,stopCalls=0,released,connections=0;
 t.mock.method(LearningClient.prototype,'start',()=>{starts++;});t.mock.method(LearningClient.prototype,'stop',async()=>{stopCalls++;});
 const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')effects.push(dispose);},inject(keys){if(keys.includes('connection'))connections++;return {dispose(){},async await(){}};},get(){return null;}};
 const task=applyNativeHost(ctx,{stateDir:dir},{startBackend:async()=>new Promise(resolve=>released=resolve)});
 assert.equal(typeof released,'function');for(const close of effects)await close();
 released({accepted:false,ready:Promise.resolve({phase:'cancelled'})});
 await assert.rejects(task,/插件已停止/);assert.equal(starts,0);assert.equal(stopCalls,0);assert.equal(connections,0);
});

test('host status records the loaded runtime version separately from the product version',t=>{
 const dir=temporary(t),file=path.join(dir,'host.json'),writer=createHostStatusWriter({file,version:'0.11.0',runtimeVersion:'loaded-code',clock:()=>100});
 writer.record('attached',{phase:'ready'});const status=JSON.parse(fs.readFileSync(file));assert.equal(status.runtimeVersion,'loaded-code');assert.equal(status.version,'0.11.0');
 assert.ok(runtimeSources().some(file=>file.replaceAll('\\','/').endsWith('/mhub-community-assistant/native-host.mjs')));
 assert.match(runtimeVersion(),/^[a-f0-9]{16}$/);
});
