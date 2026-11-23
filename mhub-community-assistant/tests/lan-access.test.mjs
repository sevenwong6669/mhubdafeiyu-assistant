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
    assert.equal(response.headers.get('referrer-policy'),'same-origin');
    assert.match(await response.text(),/<form method="post" action="\/lan\/login">/);
  }
  const asset='/api/mhub-community/panel.js',state='/api/mhub-community/state';
  for(const route of [asset,state,'/health']){
    assert.equal((await authorize(request(route),peer)).status,401);
  }
  const refresh=request('/api/mhub-community/devices/refresh',{method:'POST'});
  assert.equal((await authorize(refresh,peer)).status,401);

  const login=await authorize(request('/lan/login',{method:'POST',headers:{origin:'http://192.168.20.4:18782'},body:new URLSearchParams({key})}),peer);
  assert.equal(login.status,303);
  assert.equal(login.headers.get('location'),panel);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const route of [panel,asset,state]){
    assert.equal(await authorize(request(route,{headers:{cookie}}),peer),null);
  }
  assert.equal(await authorize(request(state,{headers:{authorization:'Bearer '+key}}),peer),null);
});

test('cross-origin top-level LAN links show the login form while API and write checks stay in place',async()=>{
  const authorize=createLanAccess(config);
  for(const site of ['same-site','cross-site']){
    const navigation={
      'sec-fetch-site':site,'sec-fetch-mode':'navigate','sec-fetch-dest':'document',
    };
    for(const route of ['/',panel,'/lan/login']){
      const response=await authorize(request(route,{headers:navigation}),peer);
      assert.equal(response.status,200);
      assert.match(await response.text(),/action="\/lan\/login"/);
    }
    for(const route of ['/api/mhub-community/state','/api/mhub-community/panel.js']){
      assert.equal((await authorize(request(route,{headers:navigation}),peer)).status,403);
    }
    assert.equal((await authorize(request(panel,{headers:{...navigation,'sec-fetch-dest':'iframe'}}),peer)).status,403);
    assert.equal((await authorize(request('/lan/login',{method:'POST',headers:navigation,body:new URLSearchParams({key})}),peer)).status,403);
    assert.equal((await authorize(request(panel,{headers:navigation}),'192.168.21.5')).status,403);
  }
});
