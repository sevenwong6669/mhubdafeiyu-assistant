const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readAudioConfig}=require('../app/resources.cjs');
const {inputConstraint,routeOutput}=require('../app/renderer/audio-devices.js');
const {petPermissionOrigin}=require('../app/media-permissions.cjs');
const devices=[
 {kind:'audioinput',deviceId:'default',label:'Default - Microphone (MCHOSE V9 Turbo+)'},
 {kind:'audioinput',deviceId:'communications',label:'Communications - Microphone (MCHOSE V9 Turbo+)'},
 {kind:'audioinput',deviceId:'v9-id',label:'Microphone (MCHOSE V9 TURBO+)'},
 {kind:'audioinput',deviceId:'other-id',label:'Microphone (USB microphone)'},
 {kind:'audiooutput',deviceId:'k20-id',label:'Speakers (MCHOSE K20 GT)'}
];
const options=values=>({bridge:{audioConfig:async()=>values},mediaDevices:{enumerateDevices:async()=>devices}});
test('shared audio settings expose device names only and reject malformed config',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live2d-audio-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');
 fs.writeFileSync(file,JSON.stringify({inputName:'MCHOSE V9 Turbo+',outputName:'K20 GT',apiKey:'never-expose'}));assert.deepEqual(readAudioConfig(file),{inputName:'MCHOSE V9 Turbo+',outputName:'K20 GT'});
 fs.writeFileSync(file,'{broken');assert.equal(readAudioConfig(file).stage,'audio-config');
});
test('shared selected microphone is resolved to its real ID and explicit desktop mic has priority',async()=>{
 assert.deepEqual(await inputConstraint({},options({inputName:'MCHOSE V9 Turbo+'})),{exact:'v9-id'});
 assert.deepEqual(await inputConstraint({mic:'other-id'},options({inputName:'MCHOSE V9 Turbo+'})),{exact:'other-id'});
 assert.deepEqual(await inputConstraint({mic:'MCHOSE V9 Turbo+'},options({inputName:'USB microphone'})),{exact:'v9-id'});
 assert.equal(await inputConstraint({},options({inputName:'__default__'})),null);
});

test('explicit microphone names and IDs never fall through to another shared device',async()=>{
 const deps=options({inputName:'USB microphone'});let reads=0;deps.bridge.audioConfig=async()=>{reads++;throw Error('must not read shared selection');};
 assert.deepEqual(await inputConstraint({mic:'MCHOSE V9 Turbo+'},deps),{exact:'v9-id'});
 assert.deepEqual(await inputConstraint({mic:'v9-id'},deps),{exact:'v9-id'});
 await assert.rejects(inputConstraint({mic:'Missing explicit device'},deps),e=>e.stage==='input-selection');
 assert.equal(reads,0);
});
test('missing, unlabelled and ambiguous selected microphones fail instead of silently capturing a default',async()=>{
 await assert.rejects(inputConstraint({},options({inputName:'Missing microphone'})),e=>e.stage==='input-selection'&&e.message.includes('未切换到系统默认'));
 const blank={...options({inputName:'MCHOSE V9 Turbo+'}),mediaDevices:{enumerateDevices:async()=>devices.map(d=>({...d,label:''}))}};
 await assert.rejects(inputConstraint({},blank),e=>e.stage==='input-permission');
 const duplicate={...options({inputName:'MCHOSE V9 Turbo+'}),mediaDevices:{enumerateDevices:async()=>[...devices,{kind:'audioinput',deviceId:'second-v9',label:'Microphone (MCHOSE V9 TURBO+)'}]}};
 await assert.rejects(inputConstraint({},duplicate),e=>e.message.includes('多个同名'));
});
test('speech output applies shared device selection and resets to default when requested',async()=>{
 const calls=[],context={sinkId:'',setSinkId:async function(id){calls.push(id);this.sinkId=id;}};
 assert.deepEqual(await routeOutput(context,options({outputName:'MCHOSE K20 GT'})),{name:'MCHOSE K20 GT',deviceId:'k20-id'});assert.deepEqual(calls,['k20-id']);
 await routeOutput(context,options({outputName:'__default__'}));assert.deepEqual(calls,['k20-id','']);
});
test('unsupported, missing and rejected selected outputs report errors before playback',async()=>{
 await assert.rejects(routeOutput({},options({outputName:'K20 GT'})),e=>e.stage==='output-selection');
 const context={setSinkId:async()=>{throw Error('device unavailable')}};
 await assert.rejects(routeOutput(context,options({outputName:'Missing speaker'})),e=>e.stage==='output-selection');
 await assert.rejects(routeOutput(context,options({outputName:'MCHOSE K20 GT'})),e=>e.stage==='output-selection'&&e.message.includes('device unavailable'));
 await assert.rejects(routeOutput(context,options({error:'broken config',stage:'audio-config'})),e=>e.stage==='audio-config');
});
test('local permission origin accepts trailing slash but rejects other origins and ports',()=>{
 assert.equal(petPermissionOrigin('http://127.0.0.1:34567',34567).matched,true);
 assert.equal(petPermissionOrigin('http://127.0.0.1:34567/',34567).matched,true);
 const withCredentials=new URL('http://127.0.0.1:34567/');withCredentials.username='user';withCredentials.password='pass';
 for(const origin of ['http://127.0.0.1:345678/','http://localhost:34567/','https://127.0.0.1:34567/','http://example.com:34567/','null',withCredentials.href])assert.equal(petPermissionOrigin(origin,34567).matched,false,origin);
});
test('failed microphone resolution records counts and labels without device IDs or capture',async()=>{
 const logs=[],deps={bridge:{audioConfig:async()=>({inputName:'MCHOSE V9 Turbo+'}),log:(...row)=>logs.push(row)},mediaDevices:{enumerateDevices:async()=>[{kind:'audioinput',deviceId:'private-id-never-log',label:''}]}};
 await assert.rejects(inputConstraint({},deps),e=>e.stage==='input-permission');
 const metadata=JSON.parse(logs[0][1]);assert.equal(metadata.inputCount,1);assert.equal(metadata.labelCount,0);assert.equal(metadata.stage,'input-permission');assert.equal(JSON.stringify(logs).includes('private-id-never-log'),false);
 logs.length=0;await assert.rejects(inputConstraint({mic:'private-explicit-id'},deps));assert.equal(JSON.stringify(logs).includes('private-explicit-id'),false);
});
