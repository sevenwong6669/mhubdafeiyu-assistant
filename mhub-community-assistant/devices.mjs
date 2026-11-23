import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BALANCE_KEYBOARDS } from '../harness-mhub-sync/balance-keyboards.mjs';
import {requireDeviceLink} from '../harness-mhub-sync/device-link-mode.mjs';

export async function readMhubDevices({ keyboards }) {
  const module = await loadMhubModule();
  const global = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('global');
  const legacy = (global?.finalDeviceList ?? []).map(d => ({
    model: d.productName || d.deviceName, family: Number(d.deviceType) === 1 ? 'keyboard' : Number(d.deviceType) === 2 ? 'mouse' : 'other',
    vendorId: d.vendorId, productId: d.productId,
    status: d.batteryLevel === 'breakConnect' ? 'receiver-only' : 'listed-by-mhub',
    battery: typeof d.batteryLevel === 'number' ? d.batteryLevel : null,
  }));
  const connected = new Set(module.c3().connectedDeviceIds ?? []);
  const hardware = Array.from(window.ALL_CZ_STATE?.deviceStateMap?.keys?.() ?? []);
  const sameHardware = (device, spec) => Number(device.vendorId) === spec.vendorId && Number(device.productId) === spec.productId;
  for (const spec of keyboards) {
    if (!connected.has(spec.id) || !hardware.some(device => sameHardware(device, spec))) continue;
    const existing = legacy.find(device => sameHardware(device, spec) || device.model === spec.id);
    if (existing) {
      existing.model ||= spec.id;
      existing.family = 'keyboard';
    } else {
      legacy.push({ model: spec.id, family: 'keyboard', vendorId: spec.vendorId, productId: spec.productId,
        status: 'listed-by-mhub', battery: null });
    }
  }
  const audio = module.aH.devices.value.map(d => ({ model: d.modelKey,
    family: ({ 3: 'headset', 4: 'speaker', 6: 'dock' })[d.deviceType] || 'other',
    vendorId: d.connections?.[0]?.vendorId, productId: d.connections?.[0]?.productId,
    status: d.deviceState?.sleep ? 'receiver-connected-device-asleep' : 'listed-by-mhub',
    battery: d.deviceState?.battery ?? null,
  }));
  return [...legacy, ...audio];
}

export async function deviceInventory(stateDir,{signal,evaluateImpl,now=Date.now,requireLink=requireDeviceLink}={}) {
  signal?.throwIfAborted();
  const file = path.join(stateDir, 'devices-snapshot.json');
  const rows = value => {
    if (!Array.isArray(value)) throw Error('设备清单格式不正确');
    const valid=value.filter(d=>d&&typeof d==='object'&&!Array.isArray(d)&&typeof d.model==='string'&&d.model.trim());
    if(value.length&&!valid.length)throw Error('设备清单格式不正确');
    return valid;
  };
  let devices;
  try {
    requireLink();
    const adapter = path.resolve(stateDir, '../../mhub_runtime_access.mjs');
    const evaluateInMhub=evaluateImpl??(await import(pathToFileURL(adapter).href+'?v=mhub-renderer-prod')).evaluateInMhub;
    devices = rows(await evaluateInMhub(readMhubDevices, { keyboards: BALANCE_KEYBOARDS }, 5000,{signal}));
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    try {
      const cached=JSON.parse(fs.readFileSync(file,'utf8'));
      return { ...cached, devices:rows(cached?.devices), stale:true, note:'M HUB 当前不可读取，这是上次记录，不能据此确认设备现在在线。' };
    }
    catch { return { source: 'unavailable', stale: true, devices: [], note: '未能读取 M HUB，未把历史已知型号冒充当前连接设备。' }; }
  }
  const result={source:'M-HUB-live',fetchedAt:new Date(now()).toISOString(),stale:false,devices};
  // Failure to save a cache does not invalidate a successful driver read.
  // Never replace a good cache with an unvalidated driver response.
  const temporary=file+`.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(stateDir,{recursive:true});
    fs.writeFileSync(temporary,JSON.stringify(result,null,2),{flag:'wx'});
    signal?.throwIfAborted();fs.renameSync(temporary,file);
  } catch {
    signal?.throwIfAborted();result.cacheError='设备已读取，缓存保存失败；当前使用实时结果。';
  } finally {try{fs.rmSync(temporary,{force:true});}catch{}}
  return result;
}
