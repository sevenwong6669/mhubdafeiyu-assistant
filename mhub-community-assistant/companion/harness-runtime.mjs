import {randomUUID} from 'node:crypto';
import {normalizeBalance} from './ai.mjs';
import fs from 'node:fs';
import path from 'node:path';

const checkedImageHistory = new WeakSet();

function hasLegacyImageHistory(agent) {
  if (checkedImageHistory.has(agent)) return false;
  const events = agent.session?.snapshotEvents?.(0) ?? [];
  const invalid = events.some(event => event.type === 'user/message'
    && Array.isArray(event.data?.content)
    && event.data.content.some(block => block?.type === 'image' && !block.attachment?.attachmentId));
  if (!invalid) checkedImageHistory.add(agent);
  return invalid;
}

async function resolveChatAgent(agents, controller, id) {
  const attached = agents.get(id);
  if (attached) return attached;
  const result = await controller.resolveAgent(id);
  if (!result?.agent) throw Error(result?.error?.message || '内部对话未能恢复。');
  return result.agent;
}

function assertChatIdle(agent, state, id) {
  if (agent.status === 'running' || state.active.has(id)) {
    throw Error('此内部对话仍在处理上一轮，请稍等。');
  }
}

async function admitImagePrompt(ctx, agent, content, requireOpen) {
  const attachments = ctx.get('attachments');
  if (typeof attachments?.admitPromptContent !== 'function') {
    throw Error('当前 Harness 未提供图像附件服务，无法提交画面。');
  }
  const selection = agent.model?.current?.() ?? ctx.get('agentDefaultModel')?.currentSelection?.();
  const metadata = selection && await ctx.get('llm')?.resolveModelInfo?.(
    selection.provider, selection.model, AbortSignal.timeout(8000));
  requireOpen();
  if (Array.isArray(metadata?.inputModalities) && !metadata.inputModalities.includes('image')) {
    throw Error('当前 Harness 对话模型不支持看图。');
  }
  // followup accepts durable message parts. The attachment store validates the
  // encoded image and returns the reference required by the Messages adapter.
  const admitted = await attachments.admitPromptContent(content);
  if (!admitted?.[1]?.attachment?.attachmentId) {
    throw Error('Harness 未生成有效的图像附件引用。');
  }
  return admitted;
}

function missingReply(agent, from) {
  const ending = agent.session?.snapshotEvents?.(from)?.findLast(event => event.type === 'turn/end');
  const reason = ending?.data?.reason;
  const code = reason?.error?.code;
  if (reason?.kind === 'aborted') return Error('内部对话已取消。');
  if (reason?.kind === 'error' && typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    return Error(`Harness 对话失败（${code}）。`);
  }
  return Error('Harness 对话未完成。');
}

function awaitReply(agent, id, state, content, requestIsOpen) {
  const from = agent.session?.seq ?? 0;
  const entry = {text:''};
  let timer, monitor;
  const pending = new Promise((resolve, reject) => {
    const cancel = entry.cancel = error => {
      reject(error);
      if (state.active.get(id) === entry) {
        state.active.delete(id);
        try { void Promise.resolve(agent.cancel?.({kind:'user'})).catch(() => {}); } catch {}
      }
    };
    entry.resolve = value => {
      if (value) resolve(value);
      else {
        try { cancel(missingReply(agent, from)); }
        catch { cancel(Error('Harness 对话未完成。')); }
      }
    };
    state.active.set(id, entry);
    timer = setTimeout(() => cancel(Error('Harness 对话超时。')), 80000);
    monitor = setInterval(() => {
      if (!requestIsOpen()) cancel(Error('内部对话已取消。'));
    }, 250);
    monitor.unref();
    if (!requestIsOpen()) cancel(Error('内部对话已取消。'));
    else Promise.resolve(agent.followup({id:randomUUID(),role:'user',content,source:{kind:'user'}})).catch(reject);
  });
  return pending.finally(() => {
    clearTimeout(timer);
    clearInterval(monitor);
    if (state.active.get(id) === entry) state.active.delete(id);
  });
}

export async function harnessJob(ctx, job, state) {
  state.signal?.throwIfAborted();
  if (job.operation === 'balance') return balance(ctx, job.input);
  if (job.operation === 'balance-sources') return balanceSources(ctx);
  if (job.operation !== 'chat') throw Error('未知的 Harness 内部操作。');

  const {input} = job;
  const {agents} = ctx;
  const controller = ctx.get('sessionController');
  const registry = ctx.get('workspaceRegistry');
  if (!agents?.get || !controller || !registry) throw Error('Harness 标准会话服务尚未就绪。');
  const request = /^[a-f0-9-]{36}$/.test(job.id ?? '')
    ? path.join(path.dirname(state.feed.file), 'harness-jobs', job.id + '.json') : null;
  const requestIsOpen = () => !state.signal?.aborted && (!request || Date.now() <= job.until && fs.existsSync(request));
  const requireOpen = () => {
    state.signal?.throwIfAborted();
    if (!requestIsOpen()) throw Error('内部对话已取消。');
  };
  const content = [{type:'text',text:input.text}];
  if (input.image) {
    const image = /^data:(image\/(jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(input.image);
    if (!image) throw Error('图片格式无效。');
    content.push({type:'image',mediaType:image[1],data:image[3],name:`companion-frame.${image[2] === 'jpeg' ? 'jpg' : 'png'}`});
  }

  requireOpen();
  const key = String(input.conversation ?? input.kind ?? 'voice').slice(0,100);
  let id = state.sessions.get(key);
  let agent;
  if (id) {
    agent = await resolveChatAgent(agents, controller, id);
    requireOpen();
    assertChatIdle(agent, state, id);
    // Old inline image blocks stay in history even on a later text-only turn.
    // Leave the old session intact and route new input to a fresh owned session.
    if (hasLegacyImageHistory(agent)) id = null;
  }
  if (!id) {
    requireOpen();
    const directory = path.join(path.dirname(state.feed.file), 'harness-workspace');
    fs.mkdirSync(directory, {recursive:true});
    const norm = directory => path.resolve(directory).toLowerCase();
    const workspace = registry.list().find(item => norm(item.path) === norm(directory))
      ?? await registry.create(directory, '迈从大肥鱼对话');
    requireOpen();
    const preset = ctx.get('agentPresets')?.defaultId || 'standard';
    const created = await controller.create({workspaceId:workspace.id,agentPreset:preset});
    requireOpen();
    id = String(created.sessionId);
    state.feed.excluded.add(id);
    agent = await resolveChatAgent(agents, controller, id);
  }
  requireOpen();
  state.feed.excluded.add(id);
  state.sessions.set(key, id);
  if (state.sessions.size > 20) state.sessions.delete(state.sessions.keys().next().value);
  assertChatIdle(agent, state, id);
  const admitted = input.image ? await admitImagePrompt(ctx, agent, content, requireOpen) : content;
  requireOpen();
  assertChatIdle(agent, state, id);
  const contextOff = input.system
    ? agent.ctx.systemPrompt.context({name:'mhub-companion-persona',order:905,text:()=>input.system}) : undefined;
  try {
    const reply = await awaitReply(agent, id, state, admitted, requestIsOpen);
    return {ok:true,reply,withImage:!!input.image,provider:'harness-native'};
  } finally {
    contextOff?.();
  }
}
function harnessProviders(ctx){let rows=[];try{rows=ctx.get('llm')?.listConfigurableProviders?.()??[];}catch{}return rows.filter(r=>r.provider==='deepseek-official'&&typeof(r.id??r.settingsNs)==='string').slice(0,20);}
export async function balanceSources(ctx){let account;try{account=await ctx.get('deepseekAccount')?.getState?.();}catch{}return {sources:[{id:'account',label:'Harness 当前登录账户',available:account?.status==='credential-stored'},...harnessProviders(ctx).map(r=>({id:'api:'+String(r.id??r.settingsNs),provider:String(r.id??r.settingsNs),label:String(r.name??r.displayName??r.settingsNs??'DeepSeek API').slice(0,100),available:true}))]};}
export async function balance(ctx,selection={source:'legacy'}){
 const get=name=>{try{return ctx.get(name);}catch{return null;}},source=selection.source??'legacy';
 const rows=harnessProviders(ctx),chosen=selection.provider?rows.find(r=>String(r.id??r.settingsNs)===selection.provider):rows[0];
 if(source==='api'&&selection.provider&&!chosen)throw Error('所选 Harness API 来源已不存在，请重新选择。');
 if(source!=='account'){
  const ns=chosen?.settingsNs,settings=(ctx.settings.describe()??[]).find(r=>ns?r.ns===ns:['llm-deepseek','llm-deepseek-api-key'].includes(r.ns))?.value??{};
  const key=await get('credentials')?.resolve?.(settings.apiKeyEnv??'DEEPSEEK_API_KEY');
  if(key?.value){if(new URL(settings.baseURL??'https://api.deepseek.com').origin!=='https://api.deepseek.com')throw Error('余额密钥只发送到 DeepSeek 官方服务。');const r=await fetch('https://api.deepseek.com/user/balance',{headers:{authorization:'Bearer '+key.value},signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw Error('DeepSeek 余额 HTTP '+r.status);return {...normalizeBalance(await r.json()),source:'harness-api',provider:selection.provider??String(chosen?.id??chosen?.settingsNs??'default')};}
  if(source==='api')throw Error('所选 Harness API 来源未配置密钥，不会改读登录账户。');
 }
 const account=get('deepseekAccount');if((await account?.getState?.())?.status!=='credential-stored')throw Error('Harness 当前账户未登录，不会自动切换余额来源。');
 let version='0.11.0';try{version=get('pluginPackages')?.packageOf?.('@deepseek-ai/dsh-app-boot',ctx.baseUrl??import.meta.url)?.version??version;}catch{}
 const body=await account.getBalance({version,locale:'zh-CN',timezoneOffsetSeconds:-new Date().getTimezoneOffset()*60});if(body?.status!=='ready'||!Array.isArray(body.value)||!Array.isArray(body.bonusWallets))throw Error('账户余额暂不可用。');
 const sums=new Map();for(const wallet of [...body.value,...body.bonusWallets]){const n=Number(wallet.balance);if(!['CNY','USD'].includes(wallet.currency)||!Number.isFinite(n)||n<0)throw Error('账户余额格式无效。');sums.set(wallet.currency,(sums.get(wallet.currency)??0)+n);}return {status:'ready',checkedAt:Date.now(),source:'harness-account',balances:[...sums].map(([currency,n])=>({currency,total:n.toFixed(4)}))};
}
