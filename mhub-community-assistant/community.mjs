import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';

// Endpoint and request shape observed in this machine's M HUB renderer.
// This is an internal interface, not a published, stable developer API.
export const BASE_URL = 'https://www.maicong.cn/mchose';
export const COMMUNITY_URL = `${BASE_URL}/cloud/community`;
export const CATEGORIES = Object.freeze({
  'keyboard-profile': 1001, 'keyboard-light': 1002, 'keyboard-animation': 1003,
  'keyboard-macro': 1004, 'mouse-profile': 2001, 'mouse-macro': 2002, 'audio-eq': 3001,
});
const CODE_TYPES = { BoardK: 1001, Light: 1002, Dlight: 1003, MacroK: 1004, BoardM: 2001, MacroM: 2002, EQ: 3001 };
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalizeDevice = value => String(value ?? '').normalize('NFKC').trim().replace(/^MCHOSE\s*/i, '').replace(/\s+/g, '').toLowerCase();
const isAce75 = value => ['ace75', 'ace758k'].includes(normalizeDevice(value));
const GAME_KEYWORDS = [
  { pattern: /\bcs\s*2\b|\bcounter[ -]?strike\s*2\b|反恐精英\s*2/i, terms: ['CS2', '反恐精英2', 'Counter-Strike 2'] },
  { pattern: /\bcs[\s:：-]*go\b|全球攻势|[打玩]\s*go\b/i, terms: ['CSGO', 'CS:GO', '全球攻势'] },
  { pattern: /\bvalo(?:rant)?\b|无畏契约|瓦[洛罗]兰特|[打玩搜找]\s*瓦|^瓦$/i, terms: ['无畏契约', 'VALORANT', '瓦洛兰特', '瓦罗兰特'] },
  { pattern: /三角洲|\bdelta[\s-]*force\b/i, terms: ['三角洲', '三角洲行动', 'Delta Force'] },
  { pattern: /\bapex(?:\s+legends)?\b|艾佩克斯/i, terms: ['Apex', 'Apex Legends', '艾佩克斯'] },
  { pattern: /\bp\s*u\s*b\s*g\b|绝地求生|吃鸡/i, terms: ['绝地求生', 'PUBG', '吃鸡'] },
  { pattern: /\blol\b|英雄联盟|撸啊撸/i, terms: ['英雄联盟', 'LOL', '撸啊撸'] },
  { pattern: /\bow\s*2\b|\boverwatch\s*2\b|守望(?:先锋)?\s*2/i, terms: ['守望先锋2', 'OW2', 'Overwatch 2'] },
  { pattern: /\bdota\s*2\b|刀塔\s*2|刀2/i, terms: ['Dota 2', '刀塔2', '刀2'] },
];
const gamesIn = text => GAME_KEYWORDS.filter(game=>game.pattern.test(text.normalize('NFKC').trim()));
export const isCommunityGame = text => gamesIn(text).length>0;
export function communitySearchTopic(message, interpreted) {
  const text=message.slice(0,100);
  return gamesIn(text).length===1?text:interpreted||text;
}
const normalizedText = value => String(value ?? '').normalize('NFKC').toLowerCase();
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const modelPattern = model => new RegExp('(?<![a-z0-9])'+escapeRegExp(model).replace(/\s+/g, '\\s*')+'(?![a-z0-9+])', 'gi');

export function communityKeywords(topic, device) {
  const text = topic.trim().normalize('NFKC');
  const [game] = gamesIn(text);
  if (game) return game.terms;
  const model = device?.trim().replace(/^MCHOSE\s*/i, '');
  const withoutDevice = model ? text.replace(modelPattern(model), ' ') : text;
  const term = withoutDevice.replace(/(?:^|\s)MCHOSE(?=\s|$)/gi, ' ').trimStart()
    .replace(/^(?:(?:请|麻烦|大肥鱼)[，,\s]*)?(?:(?:帮我|给我(?!的)|我想|我需要)\s*)*/, '')
    .replace(/^给?(?:我的|这把|当前|这台)?(?:键盘|鼠标|耳机)\s*/, '')
    .replace(/^(?:(?:找一下|搜一下|找个|找|查一下|搜索|推荐|适合|用于|用来|打|玩)\s*)+/, '')
    .replace(/\s*(?:的)?(?:键盘|鼠标|耳机)?(?:配置|设置|方案|参数|预设|灯效|宏|均衡器)[。！!?？\s]*$/, '')
    .trim();
  return [term || text];
}

export function communityTarget({ topic, category, device }, inventory) {
  const text = topic.normalize('NFKC');
  const inventoryDevices = Array.isArray(inventory.devices) ? inventory.devices : [];
  const models = [
    ...inventoryDevices.filter(item => typeof item?.model === 'string' && ['keyboard','mouse','headset','speaker'].includes(item.family)),
    { model:'Ace 75 8K', family:'keyboard' }, { model:'Ace 75', family:'keyboard' },
    { model:'GT 75', family:'keyboard' }, { model:'MCHOSE A7 V3 Ultra+', family:'mouse' },
  ].sort((a,b) => b.model.length-a.model.length);
  const named = models.find(item => modelPattern(item.model.replace(/^MCHOSE\s*/i, '')).test(text));
  const generic = value => /^(?:我的|当前(?:使用的)?|这(?:把|个|台|副))?(?:键盘|鼠标|耳机|音箱)$/.test(value ?? '');
  const requested = generic(device) ? undefined : device;
  const explicit = requested || named?.model;
  const known = explicit && models.find(item => normalizeDevice(item.model) === normalizeDevice(explicit));
  const targetText = device || text;
  const family = category?.split('-')[0] || known?.family
    || (/键盘/.test(targetText) ? 'keyboard' : /鼠标/.test(targetText) ? 'mouse' : /耳机|音箱|均衡器|\bEQ\b/i.test(targetText) ? 'audio' : null)
    || (!explicit&&isCommunityGame(text)?'keyboard':null);
  const live = inventory.stale ? [] : inventoryDevices.filter(item => typeof item?.model === 'string' && item.status === 'listed-by-mhub'
    && (family === 'audio' ? ['headset','speaker'].includes(item.family) : family ? item.family === family : ['keyboard','mouse','headset','speaker'].includes(item.family)));
  const availableDevices = [...new Map(live.map(item => [normalizeDevice(item.model),item])).values()];
  const target = known?.model || explicit || (availableDevices.length === 1 ? availableDevices[0].model : null);
  const resolvedFamily = family || availableDevices.find(item => item.model === target)?.family;
  const inferredCategory = resolvedFamily === 'keyboard'
    ? (/宏/.test(text) ? 'keyboard-macro' : /动图|动画|\bgif\b/i.test(text) ? 'keyboard-animation' : /灯效|灯光|配色/.test(text) ? 'keyboard-light' : 'keyboard-profile')
    : resolvedFamily === 'mouse' ? (/宏/.test(text) ? 'mouse-macro' : 'mouse-profile')
    : ['audio','headset','speaker'].includes(resolvedFamily) ? 'audio-eq' : null;
  return { device:target, category:category || inferredCategory, availableDevices:availableDevices.map(item => item.model) };
}
export function sameCommunityDevice(category, left, right) {
  return normalizeDevice(left) === normalizeDevice(right) ||
    category === 1001 && isAce75(left) && isAce75(right);
}
const clean = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
export function textArgument(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(`${label}须为 1–${max} 字的文字。`);
  return value.trim();
}
export function categoryCode(category) {
  if (!Object.hasOwn(CATEGORIES, category)) throw new Error('不支持的配置类别。');
  return CATEGORIES[category];
}
export function communityDeviceNames(code, device) {
  const name = String(device ?? '').trim();
  if ([1001,1002,1003,3001].includes(code) && name) {
    const model = name.replace(/^MCHOSE\s*/i, '');
    return code === 1001 && isAce75(model) ? ['Ace 75', 'Ace 75 8K'] : [...new Set([model, name])];
  }
  return code === 2001 && name ? [`MCHOSE ${name.replace(/^MCHOSE\s*/i, '')}`] : [];
}
export function buildQuery({ topic, category, device, page = 1, size = category === 'keyboard-profile' ? 20 : 8 }) {
  textArgument(topic, '主题'); textArgument(device, '设备');
  const code = categoryCode(category);
  if (!Number.isInteger(page) || page < 1 || page > 3 || !Number.isInteger(size) || size < 1 || size > 20) throw new Error('分页超出本次只读验证范围。');
  // M HUB searches mouse macros globally; hardware compatibility is checked separately.
  return { category1: Math.floor(code / 1000), category2: code,
    deviceName: communityDeviceNames(code, device),
    tag: '', keyword: topic, sort: 2, page, size };
}
async function boundedJson(response) {
  let length = 0; const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 4_000_000) throw new Error('社区响应过大，已停止读取。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function keyboardProfileFacts(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 700000) return null;
  try {
    const zip=Buffer.from(encoded,'base64');
    if(zip.length<30||zip.readUInt32LE(0)!==0x04034b50||(zip.readUInt16LE(6)&9)!==0)return null;
    const method=zip.readUInt16LE(8),nameSize=zip.readUInt16LE(26),size=zip.readUInt32LE(18),plainSize=zip.readUInt32LE(22);
    const start=30+nameSize+zip.readUInt16LE(28);
    if(zip.subarray(30,30+nameSize).toString()!=='data.json'||start+size>zip.length||plainSize>1048576)return null;
    const data=zip.subarray(start,start+size);
    const json=method===8?inflateRawSync(data,{maxOutputLength:1048576}):method===0?data:null;
    if(!json||json.length!==plainSize||crc32(json)!==zip.readUInt32LE(14))return null;
    const payload=JSON.parse(json),travel=payload?.triggerTravel?.travelKeysV2;
    if(!travel?.default||!travel.data||Array.isArray(travel.data)||typeof travel.data!=='object')return null;
    const mm=value=>Number.isInteger(value)&&value>=0&&value<=500?value/100:null;
    const entries=Object.values(travel.data).flatMap(value=>Array.isArray(value)?value.slice(0,4):[]).filter(Boolean);
    const actuation=entries.map(value=>mm(value.keyActuation)).filter(value=>value!==null);
    return {defaultActuationMm:mm(travel.default.keyActuation),
      overrideKeys:Object.keys(travel.data).length,overrideActuationMm:actuation.length?[Math.min(...actuation),Math.max(...actuation)]:null,
      containsKeyMappings:Array.isArray(payload.userKeys)&&payload.userKeys.length>0,
      containsLighting:!!payload.light?.config};
  } catch { return null; }
}
export class CommunityClient {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; }
  async search(query, { signal } = {}) {
    const response = await this.fetchImpl(COMMUNITY_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
      redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`社区读取失败（HTTP ${response.status}）。`);
    const body = await boundedJson(response);
    if (body.code !== 200) throw new Error(`社区拒绝读取（${clean(body.code, 20)}）；未尝试获取登录凭据。`);
    if (!body.data || !Array.isArray(body.data.list) || !Number.isSafeInteger(body.data.total) || body.data.total < 0) throw new Error('社区接口格式已变化。');
    return { total: body.data.total, items: body.data.list };
  }
}
export function normalizeShare(raw, { queriedCategory, fetchedAt }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isSafeInteger(raw.id) || raw.id < 1) return null;
  const content = raw.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const shareCode = clean(content.shareCode, 160), parts = shareCode.split('_');
  const code = Number(raw.category2);
  if (code !== queriedCategory || parts.length !== 3 || parts[2].length !== 11 || CODE_TYPES[parts[1]] !== code) return null;
  const data = content.allInfo ?? content;
  const keyList = content.info?.keyList;
  const facts = {};
  if (code === 2001) {
    facts.dpi = Array.from({ length: 6 }, (_, i) => data[`dpi${i}`]).filter(x => Number.isFinite(x));
    facts.changesMouseButtons = true;
    facts.declaredProductId = Number.isInteger(content.productId) ? content.productId : null;
    facts.rearButton = { type: data.retreatKeyType ?? data.buttonType5 ?? null, value: data.retreatKeyVal ?? data.buttonValue5 ?? null };
  }
  if ([1004, 2002].includes(code)) {
    facts.macroSteps = Array.isArray(keyList) ? keyList.length : null;
    facts.macroEventTypes = Array.isArray(keyList) ? [...new Set(keyList.map(x => clean(x?.type, 24)))].slice(0, 12) : [];
    facts.repeatMode = typeof content.type === 'number' ? content.type : null;
  }
  if (code === 3001 && Array.isArray(content.data)) facts.eqGains = content.data.filter(Number.isFinite).slice(0, 32);
  if ([1001, 1002, 1003].includes(code)) facts.compressedPayload = typeof content.__compressBase64__ === 'string';
  if (code === 1001 && facts.compressedPayload) {
    const settings=keyboardProfileFacts(content.__compressBase64__);
    if(settings)facts.keyboardProfile=settings;
  }
  return { id: raw.id, shareCode, category: code, title: clean(content.name || content.extra?.displayName || raw.name),
    author: clean(raw.createName, 80), device: clean(raw.deviceName || raw.name, 100), tags: clean(raw.tag, 300),
    downloads: Number.isSafeInteger(raw.downNum) && raw.downNum >= 0 ? raw.downNum : 0,
    facts, contentHash: hash(content), fetchedAt,
    source: { endpoint: COMMUNITY_URL, id: raw.id, shareCode },
    trust: 'untrusted-community-data',
  };
}
export function assessShare(item, { topic, device, keywords = communityKeywords(topic, device) }) {
  const description = normalizedText(`${item.title} ${item.tags}`);
  const game = GAME_KEYWORDS.find(entry => entry.terms === keywords);
  const matches = keywords.filter(term => {
    const normalized=normalizedText(term);
    return game && /^[a-z]/.test(normalized) ? new RegExp('(?<![a-z0-9])'+escapeRegExp(normalized)+'(?![a-z0-9])').test(description)
      : description.includes(normalized);
  });
  if (!matches.length && game?.pattern.test(description)) matches.push(keywords[0]);
  const relevant = matches.length > 0;
  const exactDevice = normalizeDevice(item.device) === normalizeDevice(device);
  const sameModel = sameCommunityDevice(item.category, item.device, device);
  const full = [1001, 2001, 3001].includes(item.category);
  const keyboardMedia = [1002,1003].includes(item.category);
  const compatibility = (full || keyboardMedia) && !sameModel ? 'device-mismatch' : 'needs-hardware-validation';
  const reasons = [];
  if (!relevant) reasons.push('标题和标签未命中本次主题；不作为相关推荐。');
  if (compatibility === 'device-mismatch') reasons.push(keyboardMedia ? '键盘灯效或动画对应的型号不同。' : '完整配置或 EQ 的设备型号不同。');
  else if (full && !exactDevice) reasons.push('社区使用 Ace 75 系列名称；仍需核对目标键盘版本、固件和配置格式。');
  else if (full) reasons.push('型号文字一致；仍需核对真实硬件、固件和配置格式。');
  else reasons.push('宏或灯效仍需设备能力、键位布局与动作内容校验。');
  if (item.category === 2001) reasons.push('整套鼠标配置可能覆盖后侧语音键和前侧快捷键。');
  return { ...item, relevant, matchedKeywords:matches, compatibility, recommendable: relevant && compatibility !== 'device-mismatch', reasons,
    score: (relevant ? 100 : 0) + (sameModel ? 30 : 0) + Math.min(10, Math.log10(item.downloads + 1) * 2) };
}
