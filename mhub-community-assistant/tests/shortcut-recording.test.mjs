import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {ControlService} from '../control-service.mjs';
import {PanelService,createPanelHandler,PANEL_PREFIX} from '../panel-service.mjs';
import {DEFAULT_BINDINGS} from '../../harness-mhub-sync/control-settings.mjs';

function browser(t){
 const listeners={},status={},save={disabled:true},reset={disabled:true},tag={classList:{add(){},remove(){}}};
 const form={querySelector:q=>q.includes('shortcuts-save')?save:q.includes('shortcuts-reset')?reset:tag};
 const document={querySelector:q=>q==='#shortcut-recording-status'?status:{},querySelectorAll:()=>[],addEventListener:(name,fn)=>{(listeners[name]??=[]).push(fn);}};
 const window={addEventListener:(name,fn)=>{(listeners[name]??=[]).push(fn);}};
 vm.runInNewContext(fs.readFileSync(new URL('../panel/control.js',import.meta.url),'utf8'),{window,document,structuredClone,Date,crypto:{randomUUID},setTimeout,clearTimeout,setInterval,clearInterval});
 const group=values=>({available:true,revision:'saved',values});
 const state={busy:new Set(),data:{connections:{qq:{}},controls:{sync:{ready:true,running:true},voice:{reachable:true,ready:true,nativeReady:true},hotkeys:{ready:true,observedAt:Date.now()},groups:{bindings:group({...DEFAULT_BINDINGS,gameToggle:'Ctrl+Alt+Shift+G'}),voice:group({voiceHotkey:'Ctrl+Alt+Shift+1'}),phone:group({hotkey:'Ctrl+Alt+Shift+2'})}}}};
 const ui=window.DafeiyuControls;ui.setTab('bindings');ui.render(state);t.after(()=>ui.cancelShortcutRecording());
 const input=(group,key,value)=>{const preview={},wrapper={querySelector:()=>preview};const el={name:key,value,type:'text',dataset:{shortcutGroup:group,...(group==='bindings'?{controlGroup:group}:{})},matches:()=>true,closest:q=>q==='[data-shortcut-editor]'?wrapper:form,setAttribute(){},removeAttribute(){},blur(){for(const fn of listeners.focusout??[])fn({target:el});}};return {el,preview};};
 const key=(el,code,modifiers={ctrlKey:true,shiftKey:true})=>({target:el,code,key:code.startsWith('Key')?code.slice(3):code,...modifiers,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}});
 return {ui,state,input,key,listeners,status,save,reset,render:()=>ui.render(state)};
}

test('recording waits for native acknowledgement, captures physical keys and only saves on explicit request',async t=>{
 const f=browser(t),{el,preview}=f.input('bindings','pet','Ctrl+Alt+F9'),requests=[];let ready;
 const request=async(route,args)=>{requests.push({route,args});if(args.operation==='begin')await new Promise(resolve=>ready=resolve);return {ok:true,message:'saved'};};
 const pending=f.ui.beginShortcutRecording(el,request);assert.match(preview.textContent,/准备/);
 f.ui.shortcutKeydown(f.key(el,'KeyL'));assert.equal(el.value,'Ctrl+Alt+F9');
 ready();await pending;assert.equal(el.dataset.recording,'recording');
 f.ui.shortcutKeydown(f.key(el,'KeyL'));assert.equal(el.value,'Ctrl+Shift+L');assert.equal(f.save.disabled,false);assert.match(preview.innerHTML,/<kbd>L<\/kbd>/);
 assert.equal(requests.filter(r=>r.route==='/controls/settings').length,0);
 let task;f.ui.action({dataset:{action:'control-shortcuts-save'}},{request,perform(_key,fn){task=fn();}});await task;
 const save=requests.find(r=>r.route==='/controls/settings');assert.equal(save.args.group,'bindings');assert.equal(save.args.values.pet,'Ctrl+Shift+L');assert.equal(save.args.values.color1,'Ctrl+Alt+1');
 assert.equal(f.state.data.controls.groups.bindings.values.pet,'Ctrl+Alt+F9');
});
test('Escape, blur and late start replies never change or revive the previous shortcut',async t=>{
 const f=browser(t),{el}=f.input('bindings','pet','Ctrl+Alt+F9');let ready;const calls=[];
 const pending=f.ui.beginShortcutRecording(el,async(_route,args)=>{calls.push(args.operation);if(args.operation==='begin')await new Promise(resolve=>ready=resolve);return {ok:true};});
 f.ui.shortcutKeydown({...f.key(el,'Escape'),key:'Escape'});ready();await pending;
 assert.equal(el.value,'Ctrl+Alt+F9');assert.equal(el.dataset.recording,undefined);assert.ok(calls.includes('end'));assert.equal(f.save.disabled,true);
 await f.ui.beginShortcutRecording(el,async()=>({ok:true}));for(const fn of f.listeners.blur)fn();assert.equal(el.dataset.recording,undefined);
});
test('modifier-only, repeats, reserved keys and duplicate cross-channel shortcuts are rejected',async t=>{
 const f=browser(t),{el}=f.input('bindings','pet','Ctrl+Alt+F9');await f.ui.beginShortcutRecording(el,async()=>({ok:true}));
 for(const e of [f.key(el,'ControlLeft',{key:'Control',ctrlKey:true}),{...f.key(el,'KeyL'),repeat:true},f.key(el,'KeyC',{ctrlKey:true}),f.key(el,'KeyL',{metaKey:true}),f.key(el,'Digit1',{ctrlKey:true,altKey:true,shiftKey:true})])f.ui.shortcutKeydown(e);
 assert.equal(el.value,'Ctrl+Alt+F9');assert.equal(f.save.disabled,true);assert.match(f.status.textContent,/其他功能/);
 f.ui.shortcutKeydown(f.key(el,'KeyL',{ctrlKey:true,altKey:true}));assert.equal(el.value,'Ctrl+Alt+L');
});
test('voice and phone drafts use the existing separate revisions and never write unrelated voice settings',async t=>{
 const f=browser(t),requests=[];const request=async(route,args)=>{requests.push({route,args});return {ok:true,message:'saved'};};
 for(const [group,key,value,code] of [['voice','voiceHotkey','Ctrl+Alt+Shift+1','KeyL'],['phone','hotkey','Ctrl+Alt+Shift+2','KeyK']]){const {el}=f.input(group,key,value);await f.ui.beginShortcutRecording(el,request);f.ui.shortcutKeydown(f.key(el,code));}
 let task;f.ui.action({dataset:{action:'control-shortcuts-save'}},{request,perform(_key,fn){task=fn();}});await task;
 const saves=requests.filter(r=>r.route==='/controls/settings').map(r=>JSON.parse(JSON.stringify(r.args)));
 assert.deepEqual(saves,[{group:'phone',revision:'saved',values:{hotkey:'Ctrl+Shift+K'}},{group:'voice',revision:'saved',values:{voiceHotkey:'Ctrl+Shift+L'}}]);
});
test('partial save retains only the unfinished shortcut draft for retry',async t=>{
 const f=browser(t);for(const [group,key,code]of [['bindings','pet','KeyL'],['phone','hotkey','KeyK']]){const {el}=f.input(group,key,'Ctrl+Alt+F9');await f.ui.beginShortcutRecording(el,async()=>({ok:true}));f.ui.shortcutKeydown(f.key(el,code));}
 let task;const calls=[];f.ui.action({dataset:{action:'control-shortcuts-save'}},{request:async(_route,args)=>{calls.push(args.group);if(args.group==='phone')throw Error('conflict');return {message:'saved'};},perform(_key,fn){task=fn();}});
 await assert.rejects(task,/部分设置已保存/);assert.deepEqual(calls,['bindings','phone']);
 const html=f.render();assert.match(html,/name="hotkey"[^>]+value="Ctrl\+Shift\+K"/);assert.match(html,/name="pet"[^>]+value="Ctrl\+Alt\+F9"/);
});

function service(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shortcut-recording-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sync=path.join(root,'harness-mhub-sync');fs.mkdirSync(path.join(sync,'voice-chat'),{recursive:true});fs.mkdirSync(path.join(sync,'phone'),{recursive:true});fs.mkdirSync(path.join(root,'mhub-community-assistant/state'),{recursive:true});
 const config={voiceHotkey:'Ctrl+Alt+Shift+1',breeze:{voiceId:'keep'},inputName:'keep microphone',captionMode:'scroll'};fs.writeFileSync(path.join(sync,'voice-chat/config.json'),JSON.stringify(config));
 const svc=new ControlService({workspaceRoot:root,aliveImpl:()=>false,waitImpl:async()=>{},fetchImpl:async()=>{throw Error('offline');}});
 return {root,sync,svc,config,lease:path.join(sync,'shortcut-capture.json')};
}
test('capture leases acknowledge every live listener, isolate owners and expire without changing configuration',async t=>{
 const f=service(t);f.svc.alive=()=>true;const id=randomUUID(),files=['pet-hotkey-status.json','phone/input-status.json','voice-chat/native-status.json'];
 for(const [i,name]of files.entries())fs.writeFileSync(path.join(f.sync,name),JSON.stringify({pid:100+i,ready:true,observedAt:Date.now(),at:Date.now()}));
 f.svc.wait=async()=>{for(const name of files){const file=path.join(f.sync,name),s=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify({...s,shortcutCaptureId:id}));}};
 assert.equal((await f.svc.shortcutCapture({operation:'begin',id})).id,id);
 await assert.rejects(f.svc.shortcutCapture({operation:'begin',id:randomUUID()}),/另一个页面/);
 await f.svc.shortcutCapture({operation:'end',id:randomUUID()});assert.ok(JSON.parse(fs.readFileSync(f.lease)).expiresAt>Date.now());
 await f.svc.shortcutCapture({operation:'renew',id});await f.svc.shortcutCapture({operation:'end',id});assert.equal(JSON.parse(fs.readFileSync(f.lease)).expiresAt,0);
 await assert.rejects(f.svc.shortcutCapture({operation:'renew',id}),/已结束/);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.sync,'voice-chat/config.json'))),f.config);
});
test('old listeners without capture acknowledgement cannot invite a dangerous key press',async t=>{
 const f=service(t);f.svc.alive=()=>true;fs.writeFileSync(path.join(f.sync,'phone/input-status.json'),JSON.stringify({pid:123,ready:true,at:Date.now()}));
 await assert.rejects(f.svc.shortcutCapture({operation:'begin',id:randomUUID()}),/尚未让出/);assert.equal(JSON.parse(fs.readFileSync(f.lease)).expiresAt,0);
});
test('voice shortcut saves preserve account, microphone and subtitles, reject channel conflicts and roll back absent acknowledgement',async t=>{
 const f=service(t),file=path.join(f.sync,'voice-chat/config.json');
 await f.svc.save({group:'voice',revision:f.svc.fileGroup('voice').revision,values:{voiceHotkey:'shift+ctrl+f6'}});
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{...f.config,voiceHotkey:'Ctrl+Shift+F6'});
 await assert.rejects(f.svc.save({group:'voice',revision:f.svc.fileGroup('voice').revision,values:{voiceHotkey:'Ctrl+Alt+1'}}),/冲突/);
 await assert.rejects(f.svc.save({group:'phone',revision:f.svc.fileGroup('phone').revision,values:{hotkey:'Ctrl+Shift+F6'}}),/冲突/);
 await assert.rejects(f.svc.save({group:'bindings',revision:f.svc.fileGroup('bindings').revision,values:{pet:'Ctrl+Shift+F6'}}),/冲突/);
 f.svc.alive=()=>true;f.svc.waitStatus=async()=>null;fs.writeFileSync(path.join(f.sync,'voice-chat/native-status.json'),JSON.stringify({pid:123,ready:true}));
 await assert.rejects(f.svc.save({group:'voice',revision:f.svc.fileGroup('voice').revision,values:{voiceHotkey:'Ctrl+Shift+F7'}}),/已保留原设置/);assert.equal(JSON.parse(fs.readFileSync(file)).voiceHotkey,'Ctrl+Shift+F6');
});
test('capture endpoint requires the panel token and accepts only its bounded operation and ID',async t=>{
 const f=service(t),panel=new PanelService({stateDir:path.join(f.root,'mhub-community-assistant/state'),controls:f.svc}),handler=createPanelHandler(panel);
 const request=(args,token)=>handler(new Request('http://127.0.0.1:18782'+PANEL_PREFIX+'/controls/shortcut-capture',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-mhub-panel-token':token}:{})},body:JSON.stringify(args)}));
 const args={operation:'begin',id:randomUUID()};assert.equal((await request(args)).status,403);assert.equal((await request({...args,path:'no'},panel.token)).status,400);assert.equal((await request(args,panel.token)).status,200);
 await request({...args,operation:'end'},panel.token);
});
