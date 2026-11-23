import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COMMUNITY_URL, CommunityClient, buildQuery, categoryCode, normalizeShare, assessShare, communityKeywords, communityTarget, hash, textArgument } from './community.mjs?v=community-search-116';
import { deviceInventory } from './devices.mjs?v=mhub-renderer-prod';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
function staleLock(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const owner = JSON.parse(raw);
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && !processAlive(owner.pid);
  } catch {
    // A crash between exclusive creation and writing can leave an empty file.
    return raw.trim() === '' && Date.now() - fs.statSync(file).mtimeMs > 30000;
  }
}
function acquireKnowledgeLock(file) {
  const claim = target => {
    const handle = fs.openSync(target, 'wx', 0o600), token = randomUUID();
    try { fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token, at: Date.now() })); }
    catch (error) { fs.closeSync(handle); fs.rmSync(target, { force: true }); throw error; }
    return {handle,token};
  };
  try { return claim(file); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.existsSync(file)) return claim(file);
    if (!staleLock(file)) throw error;
    // Serialize stale-owner replacement. Ordinary claimants still use wx,
    // so a winner in the unlink/open interval cannot have its lock removed.
    const recovery = file + '.recovery';
    let guard;
    try { guard = claim(recovery); }
    catch (guardError) {
      if (guardError.code !== 'EEXIST') throw guardError;
      const observed = fs.readFileSync(recovery, 'utf8');
      if (!staleLock(recovery) || fs.readFileSync(recovery, 'utf8') !== observed) throw guardError;
      fs.unlinkSync(recovery);
      guard = claim(recovery);
    }
    try {
      if (!fs.existsSync(file)) return claim(file);
      if (!staleLock(file)) throw error;
      fs.unlinkSync(file);
      return claim(file);
    } finally { releaseKnowledgeLock(recovery,guard); }
  }
}
function releaseKnowledgeLock(file, owner) {
  fs.closeSync(owner.handle);
  try {
    if (JSON.parse(fs.readFileSync(file,'utf8')).token === owner.token) fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Local knowledge records facts observed in shares. Search does not imply user preference.
export class KnowledgeStore {
  constructor(directory) { this.directory = path.resolve(directory); this.file = path.join(this.directory, 'knowledge.json'); }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { version: 1, observations: {}, proposals: {} }; throw error; }
    if (Buffer.byteLength(raw) > 8_000_000) throw new Error('知识记录过大，未覆盖。');
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !value.observations || Array.isArray(value.observations) || typeof value.observations !== 'object' || !value.proposals || Array.isArray(value.proposals) || typeof value.proposals !== 'object') throw new Error('知识记录格式损坏，未重置。');
    const observations = Object.fromEntries(Object.entries(value.observations).filter(([, item]) => object(item)
      && typeof item.shareCode === 'string' && typeof item.device === 'string'
      && typeof item.title === 'string' && typeof item.tags === 'string'
      && Number.isInteger(item.category) && dated(item.fetchedAt)));
    const proposals = Object.fromEntries(Object.entries(value.proposals).filter(([, item]) => object(item)
      && typeof item.id === 'string' && dated(item.createdAt) && object(item.target)));
    this.quarantined = Object.keys(value.observations).length - Object.keys(observations).length
      + Object.keys(value.proposals).length - Object.keys(proposals).length;
    return { ...value, observations, proposals };
  }
  update(action) {
    fs.mkdirSync(this.directory, { recursive: true });
    const lock = path.join(this.directory, 'knowledge.lock');
    const owner = acquireKnowledgeLock(lock), temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const state = this.read(), result = action(state);
      if (Object.keys(state.observations).length > 2000 || Object.keys(state.proposals).length > 200) throw new Error('知识库已到容量上限，未静默丢弃记录。');
      const json = JSON.stringify(state, null, 2);
      if (Buffer.byteLength(json) > 8_000_000) throw new Error('知识记录过大，未覆盖。');
      if (this.quarantined && fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.quarantine-${Date.now()}-${randomUUID()}.json`);
      fs.writeFileSync(temporary, json + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file); return result;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); releaseKnowledgeLock(lock,owner); }
  }
}
export class CommunityAssistant {
  constructor({ stateDir, client = new CommunityClient(), now = Date.now } = {}) {
    this.store = new KnowledgeStore(stateDir); this.client = client; this.now = now;
  }
  async search({ topic, category, device, pages = 1, fresh = false }, { signal } = {}) {
    topic = textArgument(topic, '主题');
    if (device !== undefined) device = textArgument(device, '目标设备');
    if (category !== undefined) categoryCode(category);
    if (typeof fresh !== 'boolean') throw new Error('fresh 须为布尔值。');
    if (!Number.isInteger(pages) || pages < 1 || pages > 3) throw new Error('每次最多读取 3 页。');
    signal?.throwIfAborted();
    const inventory = await deviceInventory(this.store.directory, {signal});
    const target = communityTarget({topic,category,device}, inventory);
    ({category,device}=target);
    if (!device || !category) {
      const mode = device ? 'needs-category' : 'needs-device';
      return {mode, topic, category, targetDevice:device, availableDevices:target.availableDevices,
        deviceInventory:inventory, requests:0, sourceTotal:null, candidates:[], excluded:[],
        note:device ? '请选择要找的配置类型，例如键盘配置、鼠标宏或耳机 EQ。'
          : target.availableDevices.length ? '请确认要搜索哪台设备。'
            : '未能确认目标设备，请给出完整型号。'};
    }
    const code = categoryCode(category), keywords = communityKeywords(topic, device);
    const cached = () => this.recall({ topic, device, category }).candidates.filter(item => item.source?.endpoint === COMMUNITY_URL
      && this.now() - Date.parse(item.fetchedAt) >= 0);
    const saved = (mode, candidates, requests, searchedKeywords, note) => ({mode,topic,category,targetDevice:device,
      requests,searchedKeywords,sourceTotal:null,candidates,excluded:[],deviceInventory:inventory,note});
    if (!fresh) {
      const recent = cached().filter(item => this.now() - Date.parse(item.fetchedAt) < 4 * 3600000);
      if (recent.length) return saved('cache-first', recent, 0, [], '使用四小时内读取的本机资料。要求联网核对最新分享时传 fresh=true。');
    }
    const startedAt = this.now(), fetchedAt = new Date(startedAt).toISOString();
    const deadline = AbortSignal.timeout(30000);
    const combinedSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    let total = 0, requests = 0, rejected = 0, searchKeyword = keywords[0], partial = false;
    const unique = new Map(), searchedKeywords = [];
    try {
      for (const term of keywords) {
        searchKeyword = term;
        searchedKeywords.push(term);
        for (let page = 1; page <= pages && requests < 3; page++) {
          combinedSignal.throwIfAborted();
          const query = buildQuery({ topic:term, category, device, page });
          requests++;
          const response = await this.client.search(query, { signal: combinedSignal });
          combinedSignal.throwIfAborted(); total = response.total;
          for (const raw of response.items) {
            const item = normalizeShare(raw, { queriedCategory: code, fetchedAt });
            if (!item) { rejected++; continue; }
            unique.set(item.shareCode, assessShare(item, { topic, device, keywords }));
          }
          if (!response.items.length || page * query.size >= total) break;
        }
        if (requests >= 3 || [...unique.values()].some(item => item.recommendable)) break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if ([...unique.values()].some(item => item.recommendable)) partial = true;
      else {
        const fallback = cached();
        if (fallback.length) return saved('cache-fallback',fallback,requests,searchedKeywords,'社区本次读取失败，以下仅是带日期的历史资料，尚未核对当前版本。');
        throw error;
      }
    }
    const items = [...unique.values()].sort((a, b) => b.score - a.score);
    if (items.length) this.store.update(state => {
      for (const item of items) state.observations[hash(item.shareCode)] = item;
    });
    return { mode: 'read-only', topic, category, targetDevice: device, fetchedAt, sourceTotal: total, deviceInventory: inventory,
      searchKeyword,searchedKeywords,partial,
      requests, elapsedMs: this.now() - startedAt, rejected,
      candidates: items.filter(item => item.recommendable), excluded: items.filter(item => !item.recommendable),
      note: partial ? '社区只返回了部分结果。候选尚未通过硬件兼容验证。'
        : '标题、标签和作者均来自社区。候选尚未通过硬件兼容验证；未导入或写入设备。' };
  }
  recall({ topic, device, category }) {
    topic=textArgument(topic, '主题'); device=textArgument(device, '目标设备');
    const code = category === undefined ? null : categoryCode(category);
    const keywords = communityKeywords(topic,device);
    const observations = Object.values(this.store.read().observations).filter(item=>code===null||item.category===code)
      .map(item => assessShare(item, { topic, device, keywords }));
    return { mode: 'cached-unverified', targetDevice: device, candidates: observations.filter(x => x.recommendable).sort((a, b) => b.score - a.score).slice(0, 10),
      note: '这是带读取时间的本机缓存，不能视为社区当前版本，也不代表用户喜欢这些配置。' };
  }
  preview({ shareCode, device, slot }) {
    textArgument(shareCode, '分享码', 160); textArgument(device, '目标设备');
    if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new Error('本原型只展示 0、1、2 三个板载槽位。');
    const item = this.store.read().observations[hash(shareCode)];
    if (!item) throw new Error('请先读取这条分享，不能凭空生成安装建议。');
    const age = this.now() - Date.parse(item.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60000) throw new Error('来源已过期，请重新搜索后再生成建议。');
    const check = assessShare(item, { topic: item.title, device });
    if (check.compatibility === 'device-mismatch') throw new Error('该配置与目标型号不同，不生成安装提案。');
    const proposal = { id: randomUUID(), status: 'preview-only', shareCode, contentHash: item.contentHash,
      target: { device, slot }, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 15 * 60000).toISOString(),
      title: item.title, author: item.author, source: item.source, facts: item.facts,
      protectedBindings: ['A7 后侧键：按住语音对话', 'A7 前侧键：既有快捷键'],
      warnings: check.reasons,
      requirements: ['重新获取原文并核对内容摘要', '核对实际设备标识、固件与格式', '读取目标槽位并生成逐项差异', '备份并保护既有语音按键', '用户在本机确认具体提案', '写入后读回校验，失败恢复备份'],
      installationAvailable: false,
      message: '这份建议仅供审阅，尚未写入。GT75 整套配置可在 AuraBot 主人私聊中选择并确认导入。' };
    this.store.update(state => { state.proposals[proposal.id] = proposal; });
    return proposal;
  }
}
