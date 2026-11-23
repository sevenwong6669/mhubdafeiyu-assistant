import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DEFAULT_BINDINGS} from '../../harness-mhub-sync/control-settings.mjs';
function fixture(){
 const window={},document={querySelector:()=>({}),querySelectorAll:()=>[],addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(new URL('../panel/control.js',import.meta.url),'utf8'),{window,document,structuredClone,Date});
 const group=values=>({available:true,revision:'saved',values});
 const controls={sync:{ready:true,running:true},voice:{reachable:true,ready:true,nativeReady:true,streamReady:true,voiceHotkey:'Ctrl+Alt+Shift+1'},hotkeys:{ready:true,observedAt:Date.now()},groups:{voice:group({voiceHotkey:'Ctrl+Alt+Shift+1'}),bindings:group({...DEFAULT_BINDINGS,gameToggle:'Ctrl+Alt+Shift+G',gameReplay:'Ctrl+Alt+Shift+R'}),phone:group({hotkey:'Ctrl+Alt+Shift+2'})}};
 const state={data:{controls,connections:{qq:{}}},busy:new Set()},ui=window.DafeiyuControls;ui.setTab('bindings');
 return {ui,state,c:controls,render:()=>ui.render(state)};
}
test('shortcut caps use actual bindings and route voice/phone recording to their own settings',()=>{
 const f=fixture(),before=JSON.stringify(f.state.data),html=f.render();
 assert.match(html,/shortcut-bindings-page/);assert.match(html,/name="gameToggle"[^>]+value="Ctrl\+Alt\+Shift\+G"/);
 assert.match(html,/name="color1"[^>]+value="Ctrl\+Alt\+1"/);assert.doesNotMatch(html,/name="color1"[^>]+value="Ctrl\+Alt\+Shift\+1"/);
 assert.match(html,/name="voiceHotkey"[^>]+data-shortcut-group="voice"[^>]+value="Ctrl\+Alt\+Shift\+1"[^>]+readonly/);assert.match(html,/name="hotkey"[^>]+data-shortcut-group="phone"[^>]+value="Ctrl\+Alt\+Shift\+2"[^>]+readonly/);
 assert.doesNotMatch(html,/data-control-group="(?:voice|phone)"/);
 const start=html.indexOf('class="shortcut-sequence"'),end=html.indexOf('class="shortcut-binding-row"',start),sequence=html.slice(start,end);
 assert.equal((sequence.match(/<kbd>/g)??[]).length,12);assert.match(sequence,/<kbd>F1<\/kbd>/);assert.match(sequence,/<kbd>F12<\/kbd>/);
 assert.equal(JSON.stringify(f.state.data),before);
});
test('editing and saving one shortcut still uses the existing revision and preserves all other settings',async()=>{
 const f=fixture();f.render();const original=structuredClone(f.c.groups.bindings.values),preview={};
 const tag={classList:{add(){}}},save={disabled:true},reset={disabled:true};
 const form={querySelector:selector=>selector.includes('control-shortcuts-save')||selector.includes('control-save')?save:selector.includes('control-shortcuts-reset')||selector.includes('control-reset')?reset:tag,querySelectorAll:()=>[]};
 const el={name:'pet',type:'text',value:'Ctrl+Alt+F10',dataset:{controlGroup:'bindings'},closest:selector=>selector==='[data-shortcut-editor]'?{querySelector:()=>preview}:form};
 f.ui.edit({target:el},f.state);assert.equal(save.disabled,false);assert.equal(reset.disabled,false);assert.match(preview.innerHTML,/<kbd>F10<\/kbd>/);assert.match(f.render(),/name="pet"[^>]+value="Ctrl\+Alt\+F10"/);
 const requests=[];let pending;
 f.ui.action({dataset:{action:'control-save',group:'bindings'},closest:()=>form},{perform(_key,fn){pending=fn();},request:async(route,args)=>{requests.push({route,args});return {message:'saved'};}});await pending;
 assert.equal(requests.length,1);assert.equal(requests[0].route,'/controls/settings');assert.equal(requests[0].args.group,'bindings');assert.equal(requests[0].args.revision,'saved');
 assert.deepEqual(JSON.parse(JSON.stringify(requests[0].args.values)),{...original,pet:'Ctrl+Alt+F10'});assert.deepEqual(f.c.groups.bindings.values,original);
});
test('unavailable voice and phone do not display invented defaults, and shortcut text cannot inject HTML',()=>{
 const f=fixture();f.c.voice={reachable:false};f.c.groups.voice={available:false};f.c.groups.phone={available:false};f.c.groups.bindings.values.pet='<img src=x onerror=bad()>';
 const html=f.render();assert.match(html,/尚未读取/);assert.doesNotMatch(html,/aria-label="Ctrl\+Alt\+Shift\+[12]"/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
});
test('switching pages retains a draft and reset only discards the binding draft',()=>{
 const f=fixture();f.render();const tag={classList:{add(){}}},form={querySelector:()=>tag};
 f.ui.edit({target:{name:'gameReplay',type:'text',value:'Ctrl+Shift+F10',dataset:{controlGroup:'bindings'},closest:selector=>selector==='[data-shortcut-editor]'?null:form}},f.state);
 f.ui.setTab('home');f.ui.setTab('bindings');assert.match(f.render(),/name="gameReplay"[^>]+value="Ctrl\+Shift\+F10"/);
 f.ui.action({dataset:{action:'control-reset',group:'bindings'}},{render(){}});assert.match(f.render(),/name="gameReplay"[^>]+value="Ctrl\+Alt\+Shift\+R"/);
});
