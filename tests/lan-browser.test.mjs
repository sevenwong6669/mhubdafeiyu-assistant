import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {createLanAccess} from '../mhub-community-assistant/lan-access.mjs';
import {createPanelListener} from '../mhub-community-assistant/scripts/start-panel.mjs';

async function eventually(check, description) {
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw Error('Timed out waiting for ' + description);
}

function devTools(socket) {
  let nextId = 0;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(Error('No Chromium response for ' + method));
    }, 3000);
    function receive(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', receive);
      if (message.error) reject(Error(message.error.message));
      else resolve(message.result);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({id, method, params}));
  });
}

test('Chromium submits the LAN form and opens the protected panel with its session', {timeout: 35000}, async t => {
  const executable = process.env.CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  assert.ok(executable, 'Chrome or Edge is required for the LAN browser check.');
  const key = 'browser-test-access-key';
  const panel = '/api/mhub-community/panel';
  const requests = [];
  let listener;
  const server = createServer((req, res) => {
    res.once('finish', () => requests.push({
      method: req.method, route: req.url, status: res.statusCode,
      origin: req.headers.origin, session: req.headers.cookie?.startsWith('dafeiyu_lan_session='),
    }));
    listener(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  listener = createPanelListener({
    port,
    lanAccess: createLanAccess({
      address: '127.0.0.1', prefixLength: 24,
      keyHash: createHash('sha256').update(key).digest('hex'), sessionSecret: 'c'.repeat(64),
    }, {port}),
    handler: request => new URL(request.url).pathname === panel
      ? new Response('<p id="protected-panel">Authenticated</p>', {headers: {'content-type': 'text/html'}})
      : new Response(null, {status: 404}),
  });

  const parent = await realpath(tmpdir());
  const profile = await mkdtemp(path.join(parent, 'dafeiyu-lan-browser-'));
  const browser = spawn(executable, [
    '--headless=new', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], {windowsHide: true, stdio: 'ignore'});
  let launchError, socket, call;
  browser.once('error', error => { launchError = error; });
  const exited = once(browser, 'exit').catch(() => {});
  t.after(async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      await call('Browser.close').catch(() => {});
      socket.close();
    }
    await Promise.race([exited, pause(1500)]);
    if (browser.exitCode === null && browser.signalCode === null) browser.kill();
    await Promise.race([exited, pause(1500)]);
    const resolved = await realpath(profile);
    assert.equal(resolved, profile);
    assert.equal(path.dirname(resolved), parent);
    await rm(resolved, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  });

  const debugPort = await eventually(async () => {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw Error('Chromium exited before starting DevTools: ' + browser.exitCode);
    const file = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    return Number(file.split(/\r?\n/, 1)[0]);
  }, 'the isolated Chromium instance');
  const tabs = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', {
    signal: AbortSignal.timeout(3000),
  })).json();
  const tab = tabs.find(candidate => candidate.type === 'page');
  assert.ok(tab?.webSocketDebuggerUrl, 'Chromium did not open a tab.');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await once(socket, 'open', {signal: AbortSignal.timeout(3000)});
  call = devTools(socket);
  const evaluate = async expression => {
    const reply = await call('Runtime.evaluate', {expression, returnByValue: true});
    assert.ok(!reply.exceptionDetails, 'Chromium could not evaluate the form action.');
    return reply.result.value;
  };
  await call('Page.navigate', {url: origin + '/lan/login'});
  await eventually(() => evaluate("Boolean(document.querySelector('#access-key'))"), 'the real login form');
  await evaluate("document.querySelector('#access-key').value=" + JSON.stringify(key) +
    "; document.querySelector('form').requestSubmit()");
  await eventually(() => evaluate("Boolean(document.querySelector('#protected-panel'))"), 'the authenticated panel');
  const login = requests.find(request => request.method === 'POST' && request.route === '/lan/login');
  assert.equal(login?.origin, origin);
  assert.equal(login?.status, 303);
  assert.ok(requests.some(request => request.route === panel && request.status === 200 && request.session));
});
