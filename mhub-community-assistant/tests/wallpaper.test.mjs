import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {WallpaperService,wallpaperType,wallpaperTransaction,WALLPAPER_MAX_BYTES} from '../wallpaper-service.mjs';
import {PanelService,createPanelHandler,PANEL_PREFIX} from '../panel-service.mjs';
import {createNativeProxy} from '../native-proxy.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=','base64');
const hash=b=>createHash('sha256').update(b).digest('hex');
const mp4=Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d6d703432','hex'),Buffer.alloc(20)]);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mhub-wallpaper-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const preset=path.join(dir,'preset.png');fs.writeFileSync(preset,png);const calls=[];
 const before={renderer:100,selection:{wallpaperId:'original',wallpaper:{id:'original',src:'native-original',mediaType:'image'}},config:{bgWallpaperV2:{schemaVersion:2,wallpaperId:'original'}},customHash:hash(png),customData:png.toString('base64'),marker:null};
 let current=before;
 const service=new WallpaperService({stateDir:dir,preset,clock:()=>100000,link:()=>true,evaluate:async(_fn,args)=>{calls.push(args);if(args.operation==='backup')return structuredClone(current);if(args.operation==='inspect')return structuredClone(current);if(args.operation==='restore')return {restored:true};if(args.operation==='apply')return {applied:true,renderer:100,wallpaperId:args.asset.kind==='video'?'dafeiyu-wallpaper-'+args.asset.id:'my-wallpaper-custom',media:{tag:args.asset.kind==='video'?'VIDEO':'IMG',ready:true,width:1,height:1}};}});
 return {service,dir,preset,calls,before,setCurrent:value=>{current=value;},import:(bytes=png,name='picture.png')=>service.action({operation:'import',name,data:bytes.toString('base64')})};
}
test('wallpaper content validation accepts supported signatures and rejects HTML, paths and oversized uploads',async t=>{
 assert.equal(wallpaperType(png).mime,'image/png');assert.equal(wallpaperType(mp4).kind,'video');assert.equal(wallpaperType(Buffer.concat([Buffer.from('1a45dfa3','hex'),Buffer.from('webm'),Buffer.alloc(30)])).ext,'webm');
 assert.equal(wallpaperType(Buffer.concat([Buffer.from('GIF89a'),Buffer.from([1,0,1,0]),Buffer.alloc(10)])).kind,'gif');
 for(const b of [Buffer.from('<svg onload="bad()"/>'),Buffer.alloc(10),Buffer.alloc(WALLPAPER_MAX_BYTES+1)])assert.throws(()=>wallpaperType(b));
 const f=fixture(t);await assert.rejects(f.service.action({operation:'import',name:'<script>',data:png.toString('base64')}));await assert.rejects(f.service.action({operation:'import',name:'test.png',data:'../../etc'}));
 assert.deepEqual(f.calls,[]);
});
test('import is local and deduplicated; gallery never applies a wallpaper merely by opening',async t=>{
 const f=fixture(t),first=await f.import(),second=await f.import(png,'second name.png');assert.equal(first.id,second.id);assert.equal(f.service.snapshot().assets.length,2);assert.equal(f.service.snapshot().active,null);assert.deepEqual(f.calls,[]);
 const reopened=new WallpaperService({stateDir:f.dir,preset:f.preset});assert.equal(reopened.snapshot().assets[1].id,first.id);
});
test('apply backs up native custom bytes, verifies the requested asset and restores without touching device settings',async t=>{
 const f=fixture(t),asset=await f.import();await f.service.action({operation:'apply',id:asset.id});
 assert.deepEqual(f.calls.map(x=>x.operation),['backup','apply']);assert.equal(f.calls[1].asset.sha256,hash(png));assert.equal(f.calls[1].file,f.service.assetFile(f.service.asset(asset.id)));
 const original=f.service.data.original;assert.deepEqual(fs.readFileSync(original.file),png);assert.equal(f.service.snapshot().canRestore,true);
 await f.service.action({operation:'release'});assert.equal(f.service.snapshot().canRestore,true);
 await f.service.action({operation:'restore'});assert.equal(f.calls.at(-1).operation,'restore');assert.equal(f.calls.at(-1).saved.config.bgWallpaperV2.wallpaperId,'original');assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().canRestore,false);
});
test('failed decode restores the previous native snapshot and an unsuccessful restore remains recoverable',async t=>{
 const f=fixture(t),a=await f.import();const evaluate=f.service.evaluate;
 f.service.evaluate=async(fn,args)=>{if(args.operation==='apply')throw Error('decode failed');return evaluate(fn,args);};
 await assert.rejects(f.service.action({operation:'apply',id:a.id}),/decode failed/);assert.equal(f.calls.at(-1).operation,'restore');assert.equal(f.service.snapshot().active,null);
 f.service.evaluate=async(fn,args)=>{if(['apply','restore'].includes(args.operation))throw Error('offline');return evaluate(fn,args);};
 await assert.rejects(f.service.action({operation:'apply',id:a.id}),/尚未完全恢复/);assert.equal(f.service.snapshot().status.phase,'recovery-pending');assert.equal(f.service.snapshot().recovery.phase,'retrying');assert.equal(f.service.snapshot().recovery.attempts,1);assert.equal(f.service.snapshot().canRestore,true);
 f.service.evaluate=evaluate;await f.service.action({operation:'restore'});assert.equal(f.service.snapshot().canRestore,false);
});
test('video recovery reapplies only after renderer restart and yields to manual M HUB changes',async t=>{
 const f=fixture(t),a=await f.import(mp4,'motion.mp4');await f.service.action({operation:'apply',id:a.id});
 f.setCurrent({...f.before,renderer:200});f.calls.length=0;await f.service.tick();assert.deepEqual(f.calls.map(x=>x.operation),['inspect','backup','apply']);
 f.service.nextTick=0;f.service.data.active.renderer=200;f.setCurrent({...f.before,renderer:200,marker:{id:a.id}});f.calls.length=0;await f.service.tick();assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().status.phase,'user-changed');assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);
});
test('static and GIF wallpaper ownership follows the native slot and content hash, including old records',async t=>{
 const f=fixture(t),gif=Buffer.concat([Buffer.from('GIF89a'),Buffer.from([1,0,1,0]),Buffer.alloc(10)]);
 const imported=await f.import(gif,'wallpaper.gif');
 const record={id:'dafeiyu-blue',kind:'static'};
 f.service.data.active=record;f.service.last={phase:'unverified'};
 const native={...f.before,selection:{wallpaperId:'my-wallpaper-custom'},marker:null};
 const evaluate=f.service.evaluate;
 f.service.evaluate=async()=>{throw Error('Driver is opening');};
 await f.service.tick();assert.equal(f.service.snapshot().status.phase,'waiting');
 f.service.evaluate=evaluate;f.service.nextTick=0;
 f.setCurrent({...native,customHash:null});
 await f.service.tick();assert.equal(f.service.snapshot().active.id,record.id);assert.equal(f.service.snapshot().status.phase,'waiting');
 f.calls.length=0;f.service.nextTick=0;f.setCurrent(native);
 await f.service.tick();assert.equal(f.service.snapshot().status.phase,'checked');assert.deepEqual(f.calls.map(x=>x.operation),['inspect']);
 assert.deepEqual(f.service.journal('apply',native).previous.active,record);
 f.calls.length=0;f.service.nextTick=0;await f.service.tick();assert.deepEqual(f.calls,[]);
 f.service.data.active={id:imported.id,kind:'gif'};f.service.last={phase:'unverified'};f.service.nextTick=0;
 f.setCurrent({...native,customHash:imported.id});
 await f.service.tick();assert.equal(f.service.snapshot().status.phase,'checked');assert.equal(f.service.snapshot().active.id,imported.id);
 f.service.last={phase:'unverified'};f.service.nextTick=0;f.setCurrent(native);
 await f.service.tick();assert.equal(f.service.snapshot().active,null);assert.equal(f.service.snapshot().status.phase,'user-changed');
});
test('stopped or disabled wallpaper control performs no periodic driver calls',async t=>{
 const f=fixture(t);await f.service.tick();assert.deepEqual(f.calls,[]);f.service.data.active={id:'test',kind:'video'};f.service.link=()=>false;await f.service.tick();assert.deepEqual(f.calls,[]);
});
test('manual inspection retains an active native wallpaper until its file is readable',async t=>{
 const f=fixture(t),active={id:'dafeiyu-blue',kind:'static',renderer:100};
 f.service.commit({...f.service.data,active});
 f.setCurrent({...f.before,selection:{wallpaperId:'my-wallpaper-custom'},customHash:null});
 const pending=await f.service.action({operation:'inspect'});
 assert.equal(pending.snapshot.active.id,active.id);
 assert.equal(pending.snapshot.status.phase,'waiting');
 assert.equal(JSON.parse(fs.readFileSync(f.service.file,'utf8')).active.id,active.id);
 f.setCurrent({...f.before,selection:{wallpaperId:'my-wallpaper-custom'},customHash:hash(png)});
 assert.equal((await f.service.action({operation:'inspect'})).snapshot.status.phase,'checked');
});
test('a failed import leaves no orphan media file or in-memory entry',async t=>{
 const f=fixture(t),file=f.service.assetFile({id:hash(png),ext:'png'});
 const persist=f.service.persist;
 f.service.persist=()=>{throw Error('library unavailable');};
 await assert.rejects(f.import(),/library unavailable/);
 assert.equal(fs.existsSync(file),false);
 assert.equal(f.service.data.assets.length,0);
 f.service.persist=persist;
 assert.equal((await f.import()).id,hash(png));
 assert.equal(fs.existsSync(file),true);
});
test('media ranges are bounded, preserve exact bytes and cannot access arbitrary paths',async t=>{
 const f=fixture(t),a=await f.import();let r=f.service.media(a.id,'bytes=0-7');assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png.subarray(0,8));assert.equal(r.headers.get('content-type'),'image/png');assert.match(r.headers.get('content-security-policy'),/sandbox/);
 r=f.service.media(a.id,'bytes=-4');assert.deepEqual(Buffer.from(await r.arrayBuffer()),png.subarray(-4));assert.equal(f.service.media(a.id,'bytes=99999-').status,416);assert.equal(f.service.media(a.id,'bytes=0-1,3-5').status,416);assert.throws(()=>f.service.media('../../secret'));
});
test('wallpaper requests stream bounded chunks and propagate a cancelled preview',async t=>{
 const f=fixture(t),large=Buffer.concat([png,Buffer.alloc(256*1024,7)]),a=await f.import(large);
 const range=f.service.media(a.id,'bytes=8-');
 const reader=range.body.getReader(),first=await reader.read();
 assert(first.value.byteLength<large.length-8);
 assert.deepEqual(Buffer.from(first.value),large.subarray(8,8+first.value.byteLength));
 await reader.cancel();
 let upstream,cancelled=false,reply;
 const body=new ReadableStream({start(c){upstream=c;c.enqueue(png.subarray(0,8));},cancel(){cancelled=true;}});
 const proxy=createNativeProxy({owner:'fixture',stateDir:f.dir,fetchImpl:async()=>new Response(body,{status:206})});
 const pending=proxy(new Request('dsh-app://app'+PANEL_PREFIX+'/wallpaper-media?id='+a.id)).then(r=>{reply=r;});
 await new Promise(resolve=>setImmediate(resolve));
 try{
  assert.equal(reply?.status,206,'proxy must return before the media download ends');
  const reader=reply.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value),png.subarray(0,8));
  await reader.cancel();
  assert.equal(cancelled,true);
 }finally{if(!cancelled)upstream.close();await pending;}
});
test('corrupt wallpaper registry cannot take the management backend down or be overwritten',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.dir,'wallpapers'),{recursive:true});const file=path.join(f.dir,'wallpapers/library.json');fs.writeFileSync(file,'{bad');const s=new WallpaperService({stateDir:f.dir,preset:f.preset});assert.equal(s.snapshot().status.phase,'failed');await assert.rejects(s.action({operation:'import',name:'x.png',data:png.toString('base64')}));assert.equal(fs.readFileSync(file,'utf8'),'{bad');
});
test('wallpaper HTTP upload requires owner token, accepts bounded media and protects media from cross-site embedding',async t=>{
 const f=fixture(t),panel=new PanelService({stateDir:f.dir,wallpapers:f.service,controls:{}}),handler=createPanelHandler(panel);
 const request=(data,token)=>handler(new Request('http://127.0.0.1:18782'+PANEL_PREFIX+'/wallpaper',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-mhub-panel-token':token}:{})},body:JSON.stringify(data)}));
 const payload={operation:'import',name:'large.png',data:Buffer.concat([png,Buffer.alloc(12000)]).toString('base64')};assert.equal((await request(payload)).status,403);assert.equal((await request({...payload,path:'arbitrary'},panel.token)).status,400);const response=await request(payload,panel.token);assert.equal(response.status,200);const {id}=await response.json();
 const url='http://127.0.0.1:18782'+PANEL_PREFIX+'/wallpaper-media?id='+id;assert.equal((await handler(new Request(url,{headers:{range:'bytes=0-7'}}))).status,206);assert.equal((await handler(new Request(url,{headers:{origin:'https://untrusted.example','sec-fetch-site':'cross-site'}}))).status,403);
 assert.equal((await handler(new Request(url.replace(id,'../../secret')))).status,404);assert.deepEqual(f.calls,[]);
});
test('Harness proxy preserves wallpaper query, Range and its exact owner data namespace',async t=>{
 const f=fixture(t);let request;const proxy=createNativeProxy({stateDir:f.dir,owner:'owner',fetchImpl:async(url,options)=>{request={url,options};return new Response(png.subarray(0,8),{status:206});}});
 const response=await proxy(new Request('dsh-app://app'+PANEL_PREFIX+'/wallpaper-media?id='+hash(png),{headers:{range:'bytes=0-7'}}));assert.equal(response.status,206);assert.match(request.url,/\?id=[a-f0-9]{64}$/);assert.equal(request.options.headers.range,'bytes=0-7');assert.equal(request.options.headers['x-dafeiyu-host-owner'],'owner');
});
test('renderer acceptance waits for the new video, never mistakes the previous image for success',async()=>{
 const w={selection:null,setSelectedWallpaper(s){this.selection=s;setTimeout(()=>{el={tagName:'VIDEO',currentSrc:s.wallpaper.src,getAttribute:()=>s.wallpaper.src,readyState:2,videoWidth:640,videoHeight:360,paused:false,currentTime:0,error:null};},10);}},pc={systemConfig:{}};
 let el={tagName:'IMG',currentSrc:'old-image',getAttribute:()=> 'old-image',complete:true,naturalWidth:100,naturalHeight:100};const stores=new Map([['wallpaperStore',w],['pcConfigStore',pc]]);const window={electronAPI:{saveBgImg(){}}};
 const document={querySelector:q=>q==='#app'?{__vue_app__:{config:{globalProperties:{$pinia:{_s:stores}}}}}:el};
 const receipt=await vm.runInNewContext('('+wallpaperTransaction.toString()+')(args)',{window,document,performance:{timeOrigin:100},args:{operation:'apply',asset:{id:'test',kind:'video',mime:'video/mp4',name:'motion'},data:mp4.toString('base64')},URL,Blob,Uint8Array,atob,btoa,crypto:webcrypto,Date,setTimeout});
 assert.equal(receipt.media.tag,'VIDEO');assert.equal(receipt.media.width,640);URL.revokeObjectURL(window.__dafeiyuWallpaper.ownedBlob);
});
test('gallery uses the shared translations, escapes user names and sends explicit apply to the existing backend',async()=>{
 const context={window:{DafeiyuI18n:{h:s=>s,t:s=>s,number:n=>n.toFixed(1),message:s=>s}},document:{},FileReader:class{readAsDataURL(){this.result='data:image/png;base64,'+png.toString('base64');this.onload();}}};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../panel/wallpaper.js',import.meta.url),'utf8'),context);
 const ui=context.window.DafeiyuWallpapers,state={busy:new Set(),data:{wallpapers:{assets:[{id:hash(png),name:'<img src=x>',kind:'static',size:100}],status:{phase:'idle'},active:null,canRestore:false}}};const html=ui.render(state);assert.doesNotMatch(html,/<img src=x>/);assert.match(html,/&lt;img/);assert.match(html,/wallpaper-apply/);assert.match(html,/wallpaper-media\?id=/);
 let run;const calls=[];ui.action({dataset:{action:'wallpaper-apply',wallpaperId:hash(png)}},{perform(_key,fn){run=fn();},request:async(...args)=>{calls.push(args);return {message:'saved'};}});await run;assert.equal(calls[0][0],'/wallpaper');assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])),{operation:'apply',id:hash(png)});
});
