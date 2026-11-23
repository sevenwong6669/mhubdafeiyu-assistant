import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {AmbientStrip} from '../../harness-mhub-sync/ambient-strip.mjs';
import {BALANCE_KEYBOARDS} from '../../harness-mhub-sync/balance-keyboards.mjs';
import {HardwareScreen} from '../../harness-mhub-sync/hardware-screen.mjs';
import {reportReleaseStep} from '../../harness-mhub-sync/release-policy.mjs';

test('a rejected K20 listener unsubscribe is included in device release issues', async () => {
  const listeners = {
    close: async () => {throw Error('driver rejected unsubscribe');},
  };
  const window = {__dafeiyuPageButtons: listeners};
  const screen = new HardwareScreen({evaluatePageButtons: callback =>
    vm.runInNewContext('(' + callback + ')()', {window})});
  screen.listening = true;
  const issues = [];
  const report = (event, error) => issues.push([event, error.message]);
  await reportReleaseStep(report, 'page-buttons-cleanup-error', () => screen.pageButtons(false));
  assert.deepEqual(issues, [['page-buttons-cleanup-error', 'driver rejected unsubscribe']]);
  assert.equal(window.__dafeiyuPageButtons, listeners);
  assert.equal(listeners.blocked, true);
  assert.equal(screen.listening, true);
  listeners.close = async () => {};
  await screen.pageButtons(false);
  assert.equal(window.__dafeiyuPageButtons, undefined);
  assert.equal(screen.listening, false);
});

for (const reason of ['sync-takeover', 'driver-writing']) {
  test('balance strip release stays pending while ' + reason + ' defers device access', async t => {
    const parent = await fs.realpath(os.tmpdir());
    const dir = await fs.mkdtemp(path.join(parent, 'mhub-release-'));
    t.after(async () => {
      assert.equal(await fs.realpath(dir), dir);
      assert.equal(path.dirname(dir), parent);
      await fs.rm(dir, {recursive: true, force: true});
    });
    const spec = BALANCE_KEYBOARDS.find(keyboard => keyboard.id === 'Ace 75 8K');
    const device = {vendorId: spec.vendorId, productId: spec.productId};
    const backup = pathToFileURL(path.join(dir, 'native-backup.json'));
    const journal = JSON.stringify({
      version: 2,
      devices: {[spec.id]: {model: spec.id, side: Array(8).fill(0), palette: Array(spec.sideCount).fill('#000000')}},
    });
    await fs.writeFile(backup, journal);
    const owner = {model: spec.id, active: true};
    const window = {__dafeiyuIndependentBalance: owner, ALL_CZ_STATE: {
      deviceStateMap: new Map([[device, {}]]),
      getDeviceState: () => assert.fail('Deferred release must not touch the device'),
    }};
    const driver = {
      constructor: {name: 'LightingOwnership'},
      isSyncActive: () => reason === 'sync-takeover',
      runPassive: async () => ({sent: false}),
    };
    const strip = new AmbientStrip({backup, evaluate: (callback, input) =>
      vm.runInNewContext('(' + callback + ')(input)', {
        input, window, loadMhubModule: async () => ({c3: () => ({connectedDeviceIds: [spec.id]}), driver}),
      })});
    const issues = [];
    const report = (event, error) => issues.push([event, error.message]);
    await reportReleaseStep(report, 'balance-native-restore-error', () => strip.close());
    assert.equal(issues.length, 1);
    assert.equal(issues[0][0], 'balance-native-restore-error');
    assert.ok(issues[0][1].includes(reason));
    assert.equal(owner.active, true);
    assert.equal(await fs.readFile(backup, 'utf8'), journal);

    delete window.__dafeiyuIndependentBalance;
    assert.equal((await strip.close()).pendingRestore, true, 'Durable recovery data is sufficient to block a deferred release');
    strip.evaluate = async () => ({releasedModel: spec.id, pendingRestore: false});
    await strip.close();
    assert.equal(JSON.parse(await fs.readFile(backup, 'utf8')).devices[spec.id].restored, true);
  });
}
