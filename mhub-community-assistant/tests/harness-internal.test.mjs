import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {harnessJob} from '../companion/harness-runtime.mjs';
import {TaskFeed,attachHarnessCompanion} from '../companion/harness-adapter.mjs';
function fixture(t, {pending = false, modalities = ['text', 'image']} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhub-harness-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const id = 'session-' + randomUUID();
  const state = {active:new Map(), sessions:new Map(), feed:new TaskFeed(path.join(dir, 'task-source.json'))};
  const calls = [];
  const agents = new Map();
  const attachment = {attachmentId:'image-fixture', width:1, height:1, mediaType:'image/jpeg'};
  const services = {
    agentPresets:{defaultId:'standard'},
    workspaceRegistry:{
      list:() => [],
      create:async (directory, title) => {
        calls.push(['workspace', directory, title]);
        return {id:'workspace'};
      }
    },
    sessionController:{
      create:async value => {
        const sessionId = calls.some(([name]) => name === 'create') ? 'session-' + randomUUID() : id;
        calls.push(['create', value]);
        return {sessionId};
      },
      resolveAgent:async sessionId => {
        calls.push(['resolve', sessionId]);
        const events = [];
        const agent = {
          status:'idle',
          events,
          session:{get seq() {return events.length;}, snapshotEvents:from => events.slice(from)},
          model:{current:() => ({provider:'fixture', model:'selected-model'})},
          ctx:{systemPrompt:{context:value => {
            calls.push(['persona', value.text()]);
            return () => calls.push(['persona-off']);
          }}},
          cancel:() => calls.push(['cancel']),
          followup:async value => {
            calls.push(['followup', value]);
            if (!pending) state.active.get(sessionId).resolve('大肥鱼在呢');
          }
        };
        agents.set(sessionId, agent);
        return {agent};
      }
    },
    llm:{resolveModelInfo:async (provider, model) => {
      calls.push(['model', provider, model]);
      return {inputModalities:modalities};
    }},
    attachments:{admitPromptContent:async content => {
      calls.push(['admit', content]);
      return [content[0], {type:'image', attachment}];
    }}
  };
  return {ctx:{agents, get:name => services[name]}, state, id, calls, dir, agents, attachment, services};
}
test('native dialogue creates a real owned session before resolving it, applies persona and keeps task lights idle',async t=>{const f=fixture(t),input={text:'你好',conversation:'voice',system:'你是大肥鱼'};assert.equal((await harnessJob(f.ctx,{operation:'chat',input},f.state)).reply,'大肥鱼在呢');assert(f.state.feed.excluded.has(f.id));assert.equal(f.state.feed.publish().state,'IDLE');assert(f.calls.find(x=>x[0]==='create'));assert(f.calls.find(x=>x[0]==='persona-off'));await harnessJob(f.ctx,{operation:'chat',input},f.state);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);assert.equal(f.state.active.size,0);});
test('native image prompts admit base64 through Harness and send only a durable image reference', async t => {
  const f = fixture(t);
  const r = await harnessJob(f.ctx, {operation:'chat', input:{text:'画面里是什么', image:'data:image/jpeg;base64,AAAA'}}, f.state);
  assert.equal(r.withImage, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'model'), ['model', 'fixture', 'selected-model']);
  assert.deepEqual(f.calls.find(([name]) => name === 'admit')[1][1],
    {type:'image', data:'AAAA', mediaType:'image/jpeg', name:'companion-frame.jpg'});
  assert.deepEqual(f.calls.find(([name]) => name === 'followup')[1].content[1], {type:'image', attachment:f.attachment});
});

test('a text-only native model never admits or submits an image and still accepts text in the same session', async t => {
  const f = fixture(t, {modalities:['text']});
  const chat = input => harnessJob(f.ctx, {operation:'chat', input}, f.state);
  await assert.rejects(chat({text:'看图', image:'data:image/png;base64,AAAA'}), /不支持看图/);
  assert.equal(f.calls.some(([name]) => name === 'admit' || name === 'followup'), false);
  assert.equal((await chat({text:'你好'})).withImage, false);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
});

test('the next turn leaves an old inline-image conversation intact and uses a healthy session', async t => {
  const f = fixture(t);
  const chat = text => harnessJob(f.ctx, {operation:'chat', input:{text, conversation:'live2d:fixture'}}, f.state);
  await chat('先发一条文字');
  const previous = f.agents.get(f.id);
  const oldEvent = {type:'user/message', data:{content:[{type:'image', data:'AAAA', mediaType:'image/jpeg'}]}};
  previous.events.push(oldEvent);
  await chat('从坏会话中恢复');
  const replacement = f.state.sessions.get('live2d:fixture');
  assert.notEqual(replacement, f.id);
  assert.deepEqual(previous.events, [oldEvent]);
  await chat('继续使用恢复后的会话');
  assert.equal(f.state.sessions.get('live2d:fixture'), replacement);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 2);
});

test('a busy existing session is not cancelled by an incoming request', async t => {
  const f = fixture(t);
  await harnessJob(f.ctx, {operation:'chat', input:{text:'你好'}}, f.state);
  f.agents.get(f.id).status = 'running';
  await assert.rejects(harnessJob(f.ctx, {operation:'chat', input:{text:'下一句'}}, f.state), /仍在处理/);
  assert.equal(f.calls.some(([name]) => name === 'cancel'), false);
});

test('an event error preserves its stable Harness code without exposing provider text', async t => {
  const f = fixture(t, {pending:true});
  const pending = harnessJob(f.ctx, {operation:'chat', input:{text:'你好'}}, f.state);
  await new Promise(resolve => setImmediate(resolve));
  const agent = f.agents.get(f.id);
  agent.events.push({type:'turn/end', data:{reason:{kind:'error', error:{code:'TRANSPORT', message:'private provider diagnostics'}}}});
  const entry = f.state.active.get(f.id);
  f.state.active.delete(f.id);
  entry.resolve(null);
  await assert.rejects(pending, {message:'Harness 对话失败（TRANSPORT）。'});
  assert.equal(f.calls.some(([name]) => name === 'cancel'), false);
});

test('a request cancelled during image admission does not append its frame to history', async t => {
  const f = fixture(t);
  const id = randomUUID();
  const jobs = path.join(f.dir, 'harness-jobs');
  fs.mkdirSync(jobs);
  const file = path.join(jobs, id + '.json');
  fs.writeFileSync(file, '{}');
  const admit = f.services.attachments.admitPromptContent;
  f.services.attachments.admitPromptContent = async content => {
    const admitted = await admit(content);
    fs.rmSync(file);
    return admitted;
  };
  await assert.rejects(harnessJob(f.ctx, {id, until:Date.now() + 10000, operation:'chat',
    input:{text:'请看图', image:'data:image/png;base64,AAAA'}}, f.state), /取消/);
  assert.equal(f.calls.some(([name]) => name === 'followup' || name === 'cancel'), false);
  assert.equal(f.state.active.size, 0);
});
test('cancelling a spooled request stops only its own native agent and releases its occupancy',async t=>{const f=fixture(t,{pending:true}),id=randomUUID(),dir=path.join(f.dir,'harness-jobs');fs.mkdirSync(dir);const file=path.join(dir,id+'.json');fs.writeFileSync(file,'{}');const pending=harnessJob(f.ctx,{id,until:Date.now()+10000,operation:'chat',input:{text:'你好'}},f.state);await new Promise(r=>setTimeout(r,30));fs.rmSync(file);await assert.rejects(pending,/取消/);assert.equal(f.calls.filter(x=>x[0]==='cancel').length,1);assert.equal(f.state.active.size,0);});

function spooledJob(f,operation,input) {
  const dir=path.join(f.dir,'companion','harness-jobs'),id=randomUUID();
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,operation,input,createdAt:Date.now(),until:Date.now()+10000}));
  return path.join(dir,id+'.result.json');
}

async function waitFor(predicate){
  for(let i=0;i<125;i++){
    const value=predicate();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Harness fixture did not complete before the deadline');
}

const resultAt=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;

function attachFixture(t,f) {
  f.ctx.on=()=>{};
  f.ctx.effect=()=>{};
  const bridge=attachHarnessCompanion(f.ctx,f.dir);
  t.after(()=>bridge.close());
  return bridge;
}

test('Harness balance and source reads complete during a slow chat',async t=>{
  const f=fixture(t,{pending:true});
  const chat=spooledJob(f,'chat',{text:'暂时保持对话进行中'});
  const bridge=attachFixture(t,f);
  await waitFor(()=>f.calls.some(([name])=>name==='followup'));
  f.services.deepseekAccount={
    getState:async()=>({status:'credential-stored'}),
    getBalance:async()=>({status:'ready',value:[{currency:'CNY',balance:'8.50'}],bonusWallets:[]})
  };
  const balance=spooledJob(f,'balance',{source:'account'});
  const sources=spooledJob(f,'balance-sources',{});
  const [reading, options]=await Promise.all([waitFor(()=>resultAt(balance)),waitFor(()=>resultAt(sources))]);
  assert.equal(reading.value.balances[0].total,'8.5000');
  assert.equal(options.value.sources[0].available,true);
  assert.equal(resultAt(chat),null);
  bridge.close();
  assert.match(resultAt(chat).error,/Harness 接入已关闭/);
  assert.equal(f.calls.filter(([name])=>name==='cancel').length,1);
});

test('queued reads can pass a full scan window of previous receipts',async t=>{
  const f=fixture(t);
  f.services.deepseekAccount={getState:async()=>({status:'credential-stored'})};
  const dir=path.join(f.dir,'companion','harness-jobs');
  fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<65;i++){
    const id=randomUUID();
    fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,operation:'balance-sources',input:{},createdAt:Date.now(),until:Date.now()+10000}));
  }
  const names=fs.readdirSync(dir).filter(name=>name.endsWith('.json'));
  for(const name of names.slice(0,-1))fs.writeFileSync(path.join(dir,name.replace(/\.json$/,'.result.json')),'{"ok":false}');
  const output=path.join(dir,names.at(-1).replace(/\.json$/,'.result.json'));
  attachFixture(t,f);
  assert.equal((await waitFor(()=>resultAt(output))).value.sources[0].available,true);
});

test('a spooled request from an earlier bridge instance is never submitted',async t=>{
  const f=fixture(t);
  const output=spooledJob(f,'chat',{text:'previous request'});
  const file=output.replace(/\.result\.json$/,'.json');
  const previous=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...previous,bridgeId:randomUUID()}));
  attachFixture(t,f);
  assert.match((await waitFor(()=>resultAt(output))).error,/接入已关闭/);
  assert.equal(f.calls.some(([name])=>name==='followup'),false);
});

test('closing the bridge during image admission returns a receipt and suppresses late submission',async t=>{
  const f=fixture(t);
  const resume=Promise.withResolvers();
  const admit=f.services.attachments.admitPromptContent;
  f.services.attachments.admitPromptContent=async content=>{
    const result=await admit(content);
    await resume.promise;
    return result;
  };
  const output=spooledJob(f,'chat',{text:'读画面',image:'data:image/png;base64,AAAA'});
  const bridge=attachFixture(t,f);
  await waitFor(()=>f.calls.some(([name])=>name==='admit'));
  bridge.close();
  try{assert.match(resultAt(output)?.error??'',/Harness 接入已关闭/);}
  finally{resume.resolve();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.some(([name])=>name==='followup'),false);
});

test('idle task snapshots are coalesced and real transitions publish immediately',t=>{
  const f=fixture(t);let now=1000;
  const feed=new TaskFeed(f.state.feed.file,{clock:()=>now});
  const idle=feed.publish();
  now+=1000;
  assert.deepEqual(feed.publish(),idle);
  const session={id:'direct'};
  feed.event(session,{type:'turn/start'});
  feed.event(session,{type:'user/message',data:{source:{kind:'user'}}});
  assert.equal(feed.publish().state,'THINKING');
  feed.event(session,{type:'turn/end',data:{reason:{kind:'completed'}}});
  assert.equal(feed.publish().state,'SUCCESS');
  now+=5001;
  assert.equal(feed.publish().state,'IDLE');
  assert.equal(feed.publish().timestamp,now);
});
