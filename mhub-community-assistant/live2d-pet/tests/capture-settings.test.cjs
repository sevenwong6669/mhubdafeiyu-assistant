const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CaptureSettings}=require('../app/capture-settings.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pet-capture-stop-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const events=[],file=path.join(root,'stop.json');const create=opts=>new CaptureSettings({file,onStop:key=>events.push(['stop',key]),onError:message=>events.push(['error',message]),post:async(route,body)=>{events.push(['request',route,body]);return {ok:true,[route.includes('/call-')?'call':'watch']:{on:body.on}};},...options,...opts});
 return {file,events,create};
}
test('offline hangup stops capture synchronously and its pending stop survives a pet restart',async t=>{
 const f=fixture(t,{post:async()=>{throw Error('offline');}}),gate=f.create();const request=gate.set('call',false);
 assert.deepEqual(f.events[0],['stop','call']);assert.equal(gate.mask('call',{on:true}).on,false);assert.equal(await request,false);
 const reboot=f.create();assert.equal(reboot.mask('call',{on:true}).on,false);assert.equal(reboot.mask('watch',{on:true}).on,true);
});
test('acknowledged backend stop clears only its own pending flag',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({version:1,call:true,watch:true}));const gate=f.create();
 assert.equal(await gate.set('call',false),true);assert.equal(gate.blocked('call'),false);assert.equal(gate.blocked('watch'),true);assert.equal(JSON.parse(fs.readFileSync(f.file)).call,false);
});
test('an earlier enable receipt cannot reopen capture after a newer local stop',async t=>{
 const f=fixture(t),releases=[];const gate=f.create({post:()=>new Promise(resolve=>releases.push(resolve))});
 const opening=gate.set('watch',true);await flush();const closing=gate.set('watch',false);assert.equal(gate.blocked('watch'),true);
 releases.shift()({ok:true,watch:{on:true}});await opening;assert.equal(gate.mask('watch',{on:true}).on,false);await flush();
 releases.shift()({ok:true,watch:{on:false}});await closing;assert.equal(gate.blocked('watch'),false);
});
test('an explicit reopen waits for earlier stop and never races its backend request',async t=>{
 const f=fixture(t),requests=[],releases=[];const gate=f.create({post:(_route,body)=>{requests.push(body.on);return new Promise(resolve=>releases.push(resolve));}});
 const closing=gate.set('call',false);await flush();const opening=gate.set('call',true);assert.deepEqual(requests,[false]);
 releases.shift()({ok:true,call:{on:false}});await closing;await flush();assert.deepEqual(requests,[false,true]);assert.equal(gate.blocked('call'),true);
 releases.shift()({ok:true,call:{on:true}});await opening;assert.equal(gate.blocked('call'),false);
});
test('the existing settings tick retries a stop without duplicating pending requests',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({version:1,call:true,watch:false}));let release,count=0;
 const gate=f.create({post:()=>{count++;return new Promise(resolve=>{release=resolve;});}});
 gate.retryPending();gate.retryPending();await flush();assert.equal(count,1);release({ok:true,call:{on:false}});await flush();assert.equal(gate.blocked('call'),false);
});
test('corrupted stop markers fail closed and storage errors never reopen an explicitly stopped channel',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,'{broken');const gate=f.create();assert.equal(gate.blocked('call'),true);assert.equal(gate.blocked('watch'),true);
 const blocked=new CaptureSettings({storage:{read:()=>JSON.stringify({version:1,call:false,watch:false}),write:()=>{throw Error('read only');}},post:async()=>({ok:true,watch:{on:false}})});
 assert.equal(await blocked.set('watch',false),false);assert.equal(blocked.mask('watch',{on:true}).on,false);
});
test('HTTP acceptance without the matching saved switch cannot release a pending stop',async t=>{
 const f=fixture(t);
 for(const reply of [{ok:true},{ok:true,call:{on:true}}]){
  const gate=f.create({post:async()=>reply});assert.equal(await gate.set('call',false),false);assert.equal(gate.mask('call',{on:true}).on,false);
 }
});
test('a destroyed menu cannot turn an acknowledged stop into a failed save or an unhandled rejection',async t=>{
 const f=fixture(t),gate=f.create({onChange(){throw Error('menu destroyed');}});
 assert.equal(await gate.set('call',false),true);assert.equal(gate.blocked('call'),false);assert.equal(gate.busy.size,0);
});
