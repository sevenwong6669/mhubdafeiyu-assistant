import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {internalCommunity} from '../companion/community.mjs';
test('overlapping QQ and voice community requests keep their own reply collection',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mhub-community-overlap-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let release;
 const service={dir,token:'test',config:{read:()=>({qq:{owner:'10001',enabled:false}})},ai:{ask:async()=>''},qq:{online:false}};
 const community=internalCommunity(service,{moduleFactory:()=>({setup(api){api.on('message',async()=>{await new Promise(r=>{release=r;});await api.sendText('private:10001','QQ自己的建议');return true;});api.route('/voice-community',async()=>{await api.sendText('private:10001','语音自己的建议');return {reply:'语音自己的建议'};});api.route('/voice-community-context',async()=>({active:true}));}})});
 const qq=community.message('帮我在社区找打瓦的配置');while(!release)await new Promise(r=>setImmediate(r));assert.equal((await community.turn('帮我找一个鼠标配置')).reply,'语音自己的建议');release();assert.equal(await qq,'QQ自己的建议');});
