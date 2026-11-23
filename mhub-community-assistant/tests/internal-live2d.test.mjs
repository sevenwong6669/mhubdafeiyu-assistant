import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {InternalLive2d,LIVE2D_PREFIX,LIVE2D_ROUTES,LIVE2D_GET_ROUTES,live2dBodyLimit,live2dToolDefinitions} from '../live2d/host.mjs';
import {DEFAULT_COMPANION,revision} from '../companion/config.mjs';

const token='test-live2d-token-'.repeat(4);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t, options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mhub-live2d-host-'));
  // Launch is intercepted by spawnImpl below; an installed desktop runtime is
  // deliberately not a prerequisite for testing a clean release archive.
  const electronPath=path.join(dir,'electron-fixture.exe');fs.writeFileSync(electronPath,'fixture; never executed');
  let cfg=structuredClone(DEFAULT_COMPANION);
  const calls=[];
  const companion={config:{read:()=>structuredClone(cfg),snapshot:()=>({values:structuredClone(cfg),revision:revision(cfg)}),
    save:async input=>{if(input.revision!==revision(cfg))throw Error('设置已改变，请刷新后重试。');cfg=structuredClone(input.values);return {values:cfg,revision:revision(cfg)};}},
    asr:{phase:'unprepared',prepare:async()=>{},recognize:async()=>({heard:'听到了。'})},
    deviceCommand:(text,kind)=>{calls.push({device:text,kind});return {handled:false};},
    turn:async (text,opts)=>{calls.push({text,opts});return {ok:true,reply:'你好，我听得到。'};},
    qq:{online:false}};
  const host=new InternalLive2d({companion,stateDir:dir,token,electronPath,inspectProcess:async pid=>({pid,matches:false}),...options});
  t.after(()=>{host.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {host,companion,dir,calls};
}
function request(route,{method='GET',body,headers={}}={}) {return new Request('http://127.0.0.1:18782'+LIVE2D_PREFIX+route,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});}
async function json(host,route,body){return (await host.handle(request(route,body?{method:'POST',body,headers:{'x-mhub-panel-token':token}}:{}))).json();}
async function configureModel(host,dir) {
  const modelFile=path.join(dir,'pet.model3.json'),coreFile=path.join(dir,'core.js');
  fs.writeFileSync(modelFile,JSON.stringify({FileReferences:{Moc:'pet.moc3'}}));fs.writeFileSync(path.join(dir,'pet.moc3'),'fixture');fs.writeFileSync(coreFile,'/* fixture */');
  await host.invoke('/desktop-config',{values:{modelFile,coreFile},revision:host.companion.config.snapshot().revision});
}

test('constructing the complete original core starts no process, timer or data writes', async t=>{
  const {host,dir}=fixture(t);
  assert.equal(host.activated,false);assert.equal(host.timer,undefined);assert.equal(fs.existsSync(path.join(dir,'live2d')),false);
  assert.equal(host.tools.size,4);assert.equal(host.routes.has('/mhub-native-call'),true);assert.equal(host.routes.has('/make-motion'),true);
  assert.equal(live2dToolDefinitions.length,4);
  assert.deepEqual(live2dToolDefinitions,[...host.tools.values()].map(({execute,...definition})=>definition),'registered schemas retain the complete original tool guidance');
  const snapshot=await host.snapshot();assert.equal(snapshot.clips.count,31);assert.equal(snapshot.state.ear.on,false);
  assert.equal(fs.existsSync(path.join(dir,'live2d')),false);
  await assert.rejects(host.invoke('/look',{key10:1}),/尚未启动/);
});
test('activation seeds all authored actions, expressions and dictionary without enabling microphones',async t=>{
  const {host}=fixture(t);host.activate();
  const snapshot=await host.snapshot();assert.equal(snapshot.clips.count,31);
  for(const kind of ['ear','call','watch','wake'])assert.equal(snapshot.state[kind].on,false,kind);
  assert.ok((await host.invoke('/manual')).manual.length>1000);
  assert.equal(fs.existsSync(path.join(host.dataPetDir,'参数词典.json')),true);
  assert.equal(JSON.parse(fs.readFileSync(host.hostFile)).api,LIVE2D_PREFIX);
});
test('cold start releases persisted calls and closes only watch sessions owned by the lost call', async t => {
  for (const owned of [false, true]) {
    const {host} = fixture(t);
    fs.mkdirSync(host.dir, {recursive:true});
    const previous = {
      call:{on:true, muted:true, mic:'saved-mic', ...(owned ? {mhubOwner:'old-call',mhubSilenceMs:1400} : {})},
      watch:{on:true, mode:'active', sessionVersion:'old-watch'},
      mhubWatchOwner:owned ? 'old-call' : null,
      talk:{to:'system'}
    };
    fs.writeFileSync(host.petFile, JSON.stringify(previous));
    host.activate();
    const recovered = host.readPet();
    assert.equal(recovered.call.on, false);
    assert.equal(recovered.call.mic, 'saved-mic');
    assert.equal(recovered.call.muted, false);
    assert.equal(recovered.call.mhubOwner, null);
    assert.deepEqual(recovered.watch, {...previous.watch, on:!owned});
    assert.equal(recovered.mhubWatchOwner, null);
    assert.deepEqual(recovered.talk, previous.talk);

    host.identity = {pid:999999,matches:true,startedAt:1};
    await host.poll({client:'test',wait:0});
    const id = '00000000-0000-4000-8000-000000000123';
    const started = await host.invoke('/mhub-native-call', {id,action:'start'});
    assert.equal(started.nativeCall.id, id);
    host.syncDesktopConfig();
    assert.equal(host.readPet().call.on, true, 'saving desktop settings must not end a live call');
    await host.invoke('/mhub-native-call', {id,action:'stop'});
  }
});
test('full original aliases are registered and mutating routes require POST + token + same origin',async t=>{
  const {host}=fixture(t);host.activate();
  assert.ok(LIVE2D_ROUTES.includes('/ext/live2d/ear-config'));assert.ok(LIVE2D_GET_ROUTES.includes('/ext/live2d/state'));
  assert.equal((await host.handle(request('/call-config'))).status,405);
  assert.equal((await host.handle(request('/call-config',{method:'POST',body:{on:true}}))).status,403);
  assert.equal((await host.handle(request('/call-config',{method:'POST',body:{on:true},headers:{'x-pet-token':token,origin:'https://attacker.invalid'}}))).status,403);
  const state=await json(host,'/ext/live2d/state');assert.equal(state.call.on,false);
  assert.equal((await host.handle(request('/state?on=true'))).status,200);
});
test('audio and motion endpoints have bounded bodies',()=>{
  assert.equal(live2dBodyLimit('/watch'),16*1024*1024);assert.equal(live2dBodyLimit('/ext/live2d/mhub-asr'),16*1024*1024);
  assert.equal(live2dBodyLimit('/make-motion'),2*1024*1024);assert.equal(live2dBodyLimit('/call-config'),65536);
});
test('ASR loading is never presented as ready; process plus fresh peer required for online',async t=>{
  const {host,companion}=fixture(t);host.activate();companion.asr.phase='preparing';
  let result=await host.invoke('/mhub-state');assert.equal(result.asr,false);assert.equal(result.asrPhase,'loading');
  companion.asr.phase='ready';result=await host.invoke('/mhub-state');assert.equal(result.asr,true);assert.equal(result.online,false);
  host.identity={pid:999999,matches:true,startedAt:1};await host.poll({client:'test',wait:0});
  result=await host.invoke('/mhub-state');assert.equal(result.online,true);
});
test('stopped internal ASR can be prepared again through the original M HUB route',async t=>{
  const {host,companion}=fixture(t);host.activate();let prepared=0;companion.asr.phase='stopped';companion.asr.prepare=async()=>{prepared++;};
  const result=await host.invoke('/mhub-asr-prepare');assert.equal(result.ok,true);assert.equal(prepared,1);
});
test('two original core instances keep independent settings and gesture state',async t=>{
  const a=fixture(t),b=fixture(t);a.host.activate();b.host.activate();
  await a.host.invoke('/look',{key11:1});
  assert.equal((await a.host.invoke('/state')).look.key11,1);assert.equal((await b.host.invoke('/state')).look.key11,0);
});
test('original M HUB voice turn is recognized and routed to own AI with original body manual and tools',async t=>{
  const {host,calls}=fixture(t);host.activate();
  const result=await host.invoke('/mhub-turn',{text:'大肥鱼，你在吗？',kind:'voice'});
  assert.equal(result.ok,true);assert.equal(result.reply,'你好，我听得到。');
  const ai=calls.find(call=>call.text);assert.ok(ai.opts.systemAppend.length>1000);assert.equal(ai.opts.skipDeviceCommand,true);assert.equal(ai.opts.tools.length,4);
  assert.equal(calls.find(call=>call.device).device,'大肥鱼，你在吗？');
  assert.equal(host.events.filter(event=>event.type==='proactive').length,0,'voice bar must not launch or mirror another spoken reply');
});

test('voice turn reports its own asynchronous AI failure and releases the slot for the next reply',async t=>{
  const {host,companion}=fixture(t);host.activate();
  // Leave a previous validation failure in health, then prove it cannot mask
  // the unrelated connection/configuration error from the next turn.
  companion.turn=async()=>({reply:'<body:害羞>'});
  const invalid=await host.invoke('/mhub-turn',{text:'第一句',kind:'voice'});assert.equal(invalid.ok,false);assert.equal(invalid.stage,'reply-validation');
  const expected='可选 Harness 接入未运行，请配置独立 AI 服务或在 Harness 中加载本项目插件。';
  companion.turn=async()=>{throw Error(expected);};
  const response=await host.handle(request('/mhub-turn',{method:'POST',headers:{'x-pet-token':token},body:{text:'麦克风测试',kind:'voice'}}));
  assert.equal(response.status,200);
  const failed=await response.json();assert.equal(failed.ok,false);assert.equal(failed.message,expected);assert.equal(failed.stage,'model');
  assert.equal(host.jobs.size,0,'failed asynchronous job is released');
  companion.turn=async()=>({reply:'下一句可以正常回复。'});
  assert.equal((await host.invoke('/mhub-turn',{text:'下一句',kind:'voice'})).reply,'下一句可以正常回复。');
  assert.equal(host.jobs.size,0);
});

test('voice submission failures preserve their cause and do not leave the voice lock occupied',async t=>{
  const {host}=fixture(t);host.activate();const original=host.pushToSession;
  host.pushToSession=async()=>{throw Error('AI 服务配置尚未完成。');};
  const failed=await host.invoke('/mhub-turn',{text:'第一次',kind:'voice'});assert.equal(failed.ok,false);assert.equal(failed.message,'AI 服务配置尚未完成。');assert.equal(failed.stage,'submission');
  host.pushToSession=original;
  assert.equal((await host.invoke('/mhub-turn',{text:'再次尝试',kind:'voice'})).ok,true);
});
test('normal QQ decoration preserves original body tag stripping and private scope',async t=>{
  const {host}=fixture(t);host.activate();await host.poll({client:'test',wait:0});
  const result=await host.decorateReply('你好呀。<body:点头,脸红>',{chatId:'private:1234',userText:'你好'});
  assert.equal(result.includes('<body:'),false);
});
test('QQ context injects authored body rules and tools only inside configured scope',async t=>{
  const {host,companion}=fixture(t);host.activate();const cfg=companion.config.snapshot();cfg.values.qq.owner='1234';await companion.config.save(cfg);await host.poll({client:'test',wait:0});
  assert.ok(host.replyContext('private').systemAppend.length>1000);assert.equal(host.replyContext('private').tools.length,4);assert.equal(host.replyContext('group').tools.length,0);
  const clean=await host.decorateReply('谢谢你。<body:害羞,脸红>',{chatId:'private:1234',userText:'你很可爱'});
  assert.equal(clean,'谢谢你。');const event=host.events.find(e=>e.type==='proactive');assert.ok(event);assert.match(event.anim,/害羞/);
  const count=host.events.filter(e=>e.type==='proactive').length;
  assert.equal(await host.decorateReply('这是另一段。<body:点头>',{chatId:'private:9999',userText:'你好'}),'这是另一段。');
  assert.equal(host.events.filter(e=>e.type==='proactive').length,count,'unowned private chat is sanitized but not mirrored');
  const current=await host.invoke('/settings');await host.invoke('/settings',{revision:current.revision,values:{...current.values,on:false}});
  assert.equal(host.replyContext('private').systemAppend,'');assert.equal(host.replyContext('private').tools.length,0);
});
test('authored tools query and modify real copied motion resources without touching source',async t=>{
  const {host}=fixture(t);host.activate();
  const initial=(await host.invoke('/clips')).count;
  const result=await host.invoke('/tool',{name:'live2d_make_motion',args:{名称:'测试点头',何时用:'测试时',轨迹:JSON.stringify({'d.AngleZ':[[0,0],[0.5,8],[1,0]]}),时长:2}});
  assert.equal(result.ok,true);assert.equal((await host.invoke('/clips')).count,initial+1);
  const list=await host.invoke('/tool',{name:'live2d_motions',args:{}});assert.ok(list.message.includes('测试点头'));
  await assert.rejects(host.invoke('/tool',{name:'external_tool',args:{}}),/没有这个/);
});
test('expression previews use actual faces only and are silent control events',async t=>{
  const {host}=fixture(t);host.activate();await host.poll({client:'test',wait:0});
  const {names}=await host.invoke('/expressions');assert.ok(names.length>5);assert.equal(names.includes('version'),false);
  await host.invoke('/expressions',{name:names[0]});const event=host.events.at(-1);
  assert.equal(event.type,'control');assert.equal(event.action,'expression');assert.equal(event.text,undefined);
  await assert.rejects(host.invoke('/expressions',{name:'version'}),/表情不存在/);
});
test('desktop config shares companion revision and mirrors saved values into original pet settings',async t=>{
  const {host,companion}=fixture(t);host.activate();
  const cfg=await host.invoke('/desktop-config');await host.invoke('/desktop-config',{values:{autoHideFullscreen:false},revision:cfg.revision});
  assert.equal(companion.config.read().pet.autoHide,false);assert.equal(host.readPet().desktop.autoHideFullscreen,false);
  await assert.rejects(host.invoke('/desktop-config',{values:{autoHideFullscreen:true},revision:cfg.revision}),/设置已改变/);
});
test('restart refuses active original telephone or watch session',async t=>{
  const {host}=fixture(t);host.activate();await host.invoke('/call-config',{on:true});
  await assert.rejects(host.invoke('/restart'),/结束电话和陪看/);
  await host.invoke('/call-config',{on:false});await host.invoke('/watch-config',{on:true});
  host.runtime.petRunning=()=>123;
  await assert.rejects(host.invoke('/restart'),/结束电话和陪看/);
  host.runtime.petRunning=()=>null;
  const reopen={ok:true,message:'桌宠启动已受理'};
  host.launch=async()=>reopen;
  assert.equal(await host.invoke('/restart'),reopen);
  assert.equal(host.readPet().watch.on,true);
});
test('original long polling uses seconds and close releases a pending poll',async t=>{
  const {host}=fixture(t);host.activate();const poll=host.poll({client:'test',wait:25});let done=false;void poll.then(()=>{done=true;});
  await delay(40);assert.equal(done,false);host.close();await poll;assert.equal(done,true);
});
test('closing host aborts own model calls and late results cannot create proactive events',async t=>{
  const {host,companion}=fixture(t);host.activate();let finish;
  companion.turn=async()=>new Promise(resolve=>{finish=resolve;});
  await host.pushToSession({chatId:'system:ext-live2d',kind:'system'},[{type:'text',text:'请说你好'}],'',{queryText:'你好'});
  const job=[...host.jobs.values()][0];host.close();finish({reply:'迟到的回复。<body:点头>'});await job.promise;
  assert.equal(host.events.some(event=>event.type==='proactive'),false);assert.equal(host.jobs.size,0);
});
test('closing an in-flight original voice route immediately releases its response instead of waiting fifty seconds',async t=>{
  const {host,companion}=fixture(t);host.activate();let finish;
  companion.turn=async()=>new Promise(resolve=>{finish=resolve;});
  const pending=host.invoke('/mhub-turn',{text:'请稍后回答。',kind:'voice'});
  await delay(0);host.close();
  const result=await Promise.race([pending,delay(300).then(()=>({timeout:true}))]);assert.equal(result.timeout,undefined);assert.equal(result.ok,false);
  finish?.({reply:'迟到的回复'});
});
test('queued phone sentence starts after old completion and only the newest answer is delivered',async t=>{
  const {host,companion}=fixture(t);host.activate();await host.poll({client:'test',wait:0});const pending=[];
  companion.turn=async(text,options)=>new Promise(resolve=>pending.push({text,options,resolve}));
  await host.invoke('/call-config',{on:true});await host.invoke('/callsay',{text:'这是第一句。'});assert.equal(pending.length,1);
  await host.invoke('/callsay',{text:'这是第二句。'});assert.equal(pending.length,1);
  const first=[...host.jobs.values()][0];pending[0].resolve({reply:'第一句旧答案。'});await first.promise;await delay(0);
  assert.equal(pending.length,2,'turn/end must free host chat slot before core drains the next sentence');
  const second=[...host.jobs.values()][0];pending[1].resolve({reply:'第二句新答案。'});await second.promise;
  const spoken=host.events.filter(event=>event.type==='proactive');assert.equal(spoken.length,1);assert.equal(spoken[0].text,'第二句新答案。');
  await host.invoke('/call-config',{on:false});
});
test('closing and reopening watch frees its old request and discards late results without releasing a new request',async t=>{
  const {host,companion}=fixture(t);host.activate();const cfg=companion.config.snapshot();cfg.values.chat.vision=true;await companion.config.save(cfg);await host.poll({client:'test',wait:0});
  const pending=[];companion.turn=async(text,options)=>new Promise(resolve=>pending.push({text,options,resolve}));
  const submit=async()=>host.invoke('/watch',{sheet:'AAAA',active:true,sessionVersion:host.readPet().watch.sessionVersion});
  await host.invoke('/watch-config',{on:true});assert.equal((await submit()).ok,true);const first=[...host.jobs.values()][0];
  await host.invoke('/watch-config',{on:false});assert.equal(first.abort.signal.aborted,true);assert.equal(host.jobs.size,0);
  await host.invoke('/watch-config',{on:true});assert.equal((await submit()).ok,true);const second=[...host.jobs.values()][0];
  pending[0].resolve({reply:'旧画面的答案。'});await first.promise;assert.equal(host.jobs.size,1);assert.equal(second.abort.signal.aborted,false);
  pending[1].resolve({reply:'新画面的答案。'});await second.promise;
  const spoken=host.events.filter(event=>event.type==='proactive');assert.equal(spoken.length,1);assert.equal(spoken[0].text,'新画面的答案。');
  await host.invoke('/watch-config',{on:false});
});
test('hanging up cancels the old phone request and permits a new telephone conversation',async t=>{
  const {host,companion}=fixture(t);host.activate();const pending=[];companion.turn=async(text,options)=>new Promise(resolve=>pending.push({text,options,resolve}));
  await host.invoke('/call-config',{on:true});await host.invoke('/callsay',{text:'挂断前的一句。'});const first=[...host.jobs.values()][0];
  await host.invoke('/call-config',{on:false});assert.equal(first.abort.signal.aborted,true);assert.equal(host.jobs.size,0);
  await host.invoke('/call-config',{on:true});await host.invoke('/callsay',{text:'重新拨号的一句。'});assert.equal(pending.length,2);
  const second=[...host.jobs.values()][0];pending[0].resolve({reply:'旧电话'});await first.promise;assert.equal(second.abort.signal.aborted,false);
  pending[1].resolve({reply:'新电话'});await second.promise;await host.invoke('/call-config',{on:false});
});
test('process that cannot be identified is never killed or replaced',async t=>{
  let starts=0;const {host}=fixture(t,{spawnImpl:()=>{starts++;return new EventEmitter();},inspectProcess:async pid=>({pid,matches:null})});host.activate();
  fs.writeFileSync(host.processFile,JSON.stringify({pid:123,startedAt:1}));
  await host.reconcileProcess({force:true});assert.equal(host.identity,null);assert.equal(starts,0);
  await assert.rejects(host.stop(),/无法核对/);
});
test('launch removes inherited Electron Node-mode flag entirely before spawning the complete shell',async t=>{
  const previous=process.env.ELECTRON_RUN_AS_NODE;process.env.ELECTRON_RUN_AS_NODE='1';
  t.after(()=>{if(previous===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=previous;});
  let spawnOptions;const child=new EventEmitter();child.pid=987654;child.exitCode=null;child.unref=()=>{};
  const {host,dir}=fixture(t,{spawnImpl:(binary,args,options)=>{spawnOptions=options;queueMicrotask(()=>child.emit('spawn'));return child;},inspectProcess:async pid=>({pid,matches:true,startedAt:12345})});
  host.activate();await configureModel(host,dir);const result=await host.launch();
  assert.equal(result.ok,true);assert.equal(Object.keys(spawnOptions.env).some(key=>key.toUpperCase()==='ELECTRON_RUN_AS_NODE'),false);
  assert.equal(spawnOptions.env.LIVE2D_PET_SETTINGS,host.petFile);assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1','parent environment remains unchanged');
  const record=JSON.parse(fs.readFileSync(host.processFile));assert.equal(record.startedAt,12345);assert.equal(record.identityVerified,true);
});
test('an immediate Electron startup exit cannot remain cached as a running pet',async t=>{
  const child=new EventEmitter();child.pid=987654;child.exitCode=null;child.unref=()=>{};
  const {host,dir}=fixture(t,{spawnImpl:()=>{queueMicrotask(()=>{child.emit('spawn');child.exitCode=1;child.emit('exit',1);});return child;},inspectProcess:async pid=>{await delay(10);return {pid,matches:false};}});
  host.activate();await configureModel(host,dir);await assert.rejects(host.launch(),/启动后已退出/);
  assert.equal(host.identity,null);assert.equal(host.child,null);assert.equal((await host.invoke('/state')).running,false);
});
test('legacy shell boot time is upgraded to verified system creation time on adoption',async t=>{
  const {host}=fixture(t,{inspectProcess:async pid=>({pid,matches:true,startedAt:1000})});host.activate();
  fs.writeFileSync(host.processFile,JSON.stringify({pid:987654,startedAt:9000}));
  await host.reconcileProcess({force:true});const record=JSON.parse(fs.readFileSync(host.processFile));
  assert.equal(host.identity.startedAt,1000);assert.equal(record.startedAt,1000);assert.equal(record.bootedAt,9000);assert.equal(record.identityVerified,true);
});
test('a reused PID with a different verified creation time is never adopted or stopped',async t=>{
  const {host}=fixture(t,{inspectProcess:async pid=>({pid,matches:true,startedAt:2000}),stopTimeoutMs:0});host.activate();
  fs.writeFileSync(host.processFile,JSON.stringify({pid:987654,startedAt:1000,identityVerified:true}));
  await host.reconcileProcess({force:true});assert.equal(host.identity,null);await assert.rejects(host.stop(),/无法核对/);
});
test('stop checks creation time again after graceful shutdown budget before any termination',async t=>{
  let checks=0;const {host}=fixture(t,{inspectProcess:async pid=>({pid,matches:true,startedAt:++checks===1?1000:2000}),stopTimeoutMs:0});host.activate();
  fs.writeFileSync(host.processFile,JSON.stringify({pid:987654,startedAt:1000,identityVerified:true}));
  await assert.rejects(host.stop(),/进程身份已变化/);
});
