import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PANEL_ASSET_ROUTES} from '../panel-service.mjs';
const source=fs.readFileSync(new URL('../panel/setup.js',import.meta.url),'utf8');
const now=Date.now();
function snapshot(){return {dataDirectoryId:'one',inventory:{fetchedAt:new Date(now).toISOString(),devices:[{model:'MCHOSE Ace 75'},{model:'MCHOSE K20 GT'}]},controls:{deviceLink:{enabled:true},sync:{running:true,ready:true,screen:{captionsReady:true}},voiceInfo:{conversation:{available:true,checkedAt:now}},balance:{visible:true,updatedAt:now,diagnostics:{paletteReadback:'verified'}},voice:{reachable:true,ready:true,nativeReady:true,streamReady:true,playback:{ready:true}}},companion:{config:{values:{chat:{mode:'harness'},pet:{modelFile:'',coreFile:''}}}},live2d:{settings:{values:{modelFile:'',coreFile:''}},state:{running:false,petOnline:false}}};}
function fixture({store=new Map(),blocked=false,locale='zh-CN'}={}){
 const ctx={window:{},location:{hash:'#setup/devices'},navigator:{languages:[locale]},document:{documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener(){},createTreeWalker:()=>({nextNode:()=>null})},NodeFilter:{SHOW_TEXT:4},CustomEvent:class{},Intl,localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>{if(blocked)throw Error('blocked');store.set(k,v);}},fetch(){throw Error('The guide must not send a device or paid request');}};
 ctx.window.addEventListener=()=>{};ctx.window.dispatchEvent=()=>{};vm.createContext(ctx);
 for(const name of ['i18n/catalog.js','i18n/runtime.js','setup.js'])vm.runInContext(fs.readFileSync(new URL('../panel/'+name,import.meta.url),'utf8'),ctx);
 const data=snapshot(),ui=ctx.window.DafeiyuSetup,actions=[];
 const act=(action,extras={})=>ui.action({dataset:{action,...extras}},{data,render(){},navigate(route){actions.push(route);ctx.location.hash='#'+route;}});
 return {ctx,data,ui,store,actions,act};
}
test('guide separates live device evidence, selected sources and playback readiness',()=>{
 const f=fixture(),s=f.ui.status(f.data,now);assert.equal(s.devices,'联动已就绪');assert.equal(s.ace75,true);assert.equal(s.k20gt,true);assert.equal(s.harness,'来源可用');assert.equal(s.voice,'通道就绪');assert.equal(s.balance,'已就绪');assert.equal(s.pet,'待配置');
 f.data.inventory.stale=true;let stale=f.ui.status(f.data,now);assert.equal(stale.ace75,false);assert.equal(stale.k20gt,false);assert.notEqual(stale.devices,'联动已就绪');assert.notEqual(stale.screen,'已就绪');
 f.data.controls.deviceLink.enabled=false;assert.equal(f.ui.status(f.data,now).devices,'未开启');
 f.data.controls.voice.playback.ready=false;assert.notEqual(f.ui.status(f.data,now).voice,'通道就绪');
 f.data.controls.voiceInfo.conversation.checkedAt=now-60000;assert.equal(f.ui.status(f.data,now).harness,'待配置');
 f.data.controls.balance.updatedAt=now+1000;assert.notEqual(f.ui.status(f.data,now).balance,'已就绪');
 f.data.companion.config.values.chat.mode='api';assert.equal(f.ui.status(f.data,now).harness,'独立 API 模式');
});
test('rendering every step and finishing the guide cannot enable devices, capture, or paid services',()=>{
 const f=fixture(),before=JSON.stringify(f.data);
 for(const step of ['devices','harness','balance','voice','pet']){f.act('setup-step',{step});assert.match(f.ui.renderPage(f.data),/setup-detail/);}
 assert.equal(f.ui.progress(f.data).completed,false);assert.match(f.ui.renderPage(f.data),/模型和 Cubism Core 未随包附带/);
 f.act('setup-finish');assert.equal(f.ui.progress(f.data).completed,true);assert.equal(f.ui.progress(f.data).active,false);assert.equal(f.actions.at(-1),'control/home');assert.equal(JSON.stringify(f.data),before);
 f.act('setup-open');assert.equal(f.actions.at(-1),'setup/devices');
});
test('configuration links preserve the step and provide a return path without overwriting drafts',()=>{
 const f=fixture();f.act('setup-step',{step:'voice'});f.act('setup-settings',{route:'control/audio'});assert.equal(f.actions.at(-1),'control/audio');assert.match(f.ui.renderReturn(f.data),/返回引导/);
 f.act('setup-open');assert.equal(f.actions.at(-1),'setup/voice');f.act('setup-later');assert.equal(f.ui.renderReturn(f.data),'');assert.match(f.ui.renderEntry(f.data),/继续设置/);
 const count=f.actions.length;f.act('setup-settings',{route:'javascript:bad()'});assert.equal(f.actions.length,count);
});
test('progress survives reopening and stays isolated between installations',()=>{
 const f=fixture();f.act('setup-step',{step:'balance'});f.act('setup-later');const again=fixture({store:f.store});assert.equal(again.ui.progress(again.data).step,'balance');
 again.data.dataDirectoryId='different-installation';assert.equal(again.ui.progress(again.data).step,'devices');assert.equal(again.ui.progress(again.data).dismissed,false);
 const invalid=fixture({store:new Map([['dafeiyu.setup.v1.one',JSON.stringify({step:'<script>',active:'true',completed:'true'})]])});assert.equal(invalid.ui.progress(invalid.data).step,'devices');assert.equal(invalid.ui.progress(invalid.data).completed,false);
});
test('blocked progress storage reports the problem without blocking setup',()=>{
 const f=fixture({blocked:true});f.act('setup-step',{step:'pet'});assert.match(f.ui.renderPage(f.data),/无法保存引导进度/);assert.equal(f.ui.progress(f.data).step,'pet');
});
test('all five guide languages are available and route assets are served by the existing panel',()=>{
 for(const locale of ['zh-CN','en','ru','fr','it']){
  const f=fixture({locale});const page=f.ui.renderPage(f.data);assert(page.includes(f.ctx.window.DafeiyuI18n.t('首次使用引导')));
  if(locale!=='zh-CN')assert(!page.includes('先连接设备并打开官方'));
 }
 for(const name of ['/setup.js','/setup.css'])assert(PANEL_ASSET_ROUTES.includes(name));
 const html=fs.readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');assert(html.indexOf('src="setup.js"')<html.indexOf('src="panel.js"'));
});
