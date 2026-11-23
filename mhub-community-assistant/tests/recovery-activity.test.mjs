import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryActivity,recoveryHarnessResult} from '../scripts/recover-plugin.mjs';
test('recovery preserves standalone watch even when the voice service is stopped',()=>{assert.match(recoveryActivity(null,{watch:true,watchStatus:{capture:{phase:'running'}}}),/结束陪看/);assert.match(recoveryActivity({phone:{phase:'idle'}},{watchStatus:{on:true,capture:{phase:'retrying'}}}),/结束陪看/);});
test('recovery guards direct internal calls and synthesis while permitting genuinely idle services',()=>{for(const companion of [{call:true},{nativeCall:{phase:'preparing'}},{nativeCall:{phase:'connected'}}])assert.match(recoveryActivity(null,companion),/通话/);assert.match(recoveryActivity({ttsOperation:{operation:'preview'}},{watch:false}),/语音/);assert.equal(recoveryActivity({phone:{phase:'idle'}},{watch:false,nativeCall:{phase:'ended'}}),null);assert.equal(recoveryActivity(null,null),null);});
test('saved watch preference does not block recovery of an offline desktop',()=>{
 const offline={online:false,watch:true,call:false,watchStatus:{fresh:false,capture:{phase:'preparing'}}};
 assert.equal(recoveryActivity(null,offline),null);
 assert.match(recoveryActivity(null,{...offline,online:true}),/结束陪看/);
 assert.match(recoveryActivity(null,{...offline,watchStatus:{fresh:true,capture:{phase:'running'}}}),/结束陪看/);
 assert.equal(recoveryActivity(null,{...offline,online:true,watchStatus:{capture:{phase:'failed'}}}),null);
});
test('recovery reports a live Harness running the old code separately from an old record',()=>{
 const status={stage:'attached',pid:23,runtimeVersion:'before'};
 const heartbeat={pid:23,at:99000};
 assert.equal(recoveryHarnessResult(status,heartbeat,'before',100000).ok,true);
 assert.equal(recoveryHarnessResult(status,heartbeat,'after',100000).ok,false);
 assert.equal(recoveryHarnessResult(status,heartbeat,'after',110000),null);
 assert.equal(recoveryHarnessResult({...status,pid:24},heartbeat,'after',100000),null);
});
