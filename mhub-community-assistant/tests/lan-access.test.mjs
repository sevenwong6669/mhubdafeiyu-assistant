import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLanAccess,readLanConfig} from '../lan-access.mjs';

const key='test-access-key',peer='192.168.20.5',panel='/api/mhub-community/panel';
const config={
  enabled:true,address:'192.168.20.4',prefixLength:24,requireAuth:false,
  keyHash:createHash('sha256').update(key).digest('hex'),sessionSecret:'b'.repeat(64),
};
const request=(route,options)=>new Request('http://192.168.20.4:18782'+route,options);

test('legacy LAN settings start in login mode and retain the current access key',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-lan-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'lan-access.json');
  fs.writeFileSync(file,JSON.stringify(config));
  assert.deepEqual(readLanConfig(file),{...config,requireAuth:true});
});

test('legacy LAN clients see the login form and need a session for panel assets and APIs',async()=>{
  const authorize=createLanAccess(config);
  for(const route of ['/',panel,'/lan/login']){
    const response=await authorize(request(route),peer);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^text\/html/);
    assert.match(await response.text(),/<form method="post" action="\/lan\/login">/);
  }
  const asset='/api/mhub-community/panel.js',state='/api/mhub-community/state';
  for(const route of [asset,state,'/health']){
    assert.equal((await authorize(request(route),peer)).status,401);
  }
  const refresh=request('/api/mhub-community/devices/refresh',{method:'POST'});
  assert.equal((await authorize(refresh,peer)).status,401);

  const login=await authorize(request('/lan/login',{method:'POST',body:new URLSearchParams({key})}),peer);
  assert.equal(login.status,303);
  assert.equal(login.headers.get('location'),panel);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const route of [panel,asset,state]){
    assert.equal(await authorize(request(route,{headers:{cookie}}),peer),null);
  }
  assert.equal(await authorize(request(state,{headers:{authorization:'Bearer '+key}}),peer),null);
});
