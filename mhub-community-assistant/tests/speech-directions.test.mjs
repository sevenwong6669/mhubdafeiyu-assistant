import test from 'node:test';
import assert from 'node:assert/strict';
import {speechText,spokenReply,spokenUtterances,Sentences,pages} from '../../harness-mhub-sync/voice-chat/text.mjs';
import {speechCaptionPages} from '../../harness-mhub-sync/voice-chat/caption-queue.mjs';

test('legacy gesture annotations never enter speech or speaker captions',()=>{
 const raw='听得见，[点头]你继续说就好。';
 assert.equal(spokenReply(raw),'听得见，你继续说就好。');
 assert.deepEqual(spokenUtterances(raw),['听得见，你继续说就好。']);
 assert.equal(pages(raw).join(''),'听得见，你继续说就好。');
 assert.equal(speechCaptionPages(raw,{captionMode:'pages'}).join(''),'听得见，你继续说就好。');
});
test('common gesture wrappers and canonical motion tags are excluded at the speech boundary',()=>{
 for(const tag of ['[轻轻点头]','［微笑］','【挥手】','（微微点头）','(nods gently)','*点头*','**微笑**','〔微快点头×3〕','<body:点头,脸红>','[点头，脸红]']){
  assert.equal(speechText('我在呢。'+tag+'继续吧。'),'我在呢。继续吧。',tag);
 }
 assert.equal(speechText('我在呢。[点头'),'我在呢。');
});
test('keyboard names, amounts, explanations and ordinary uses of gesture words remain intact',()=>{
 for(const text of ['按[F1]开始。','余额（30元）可以使用。','请看【设置】。','我点头是因为听懂了。','这句话（我想点头表示赞同）是说明。','接口[0,1]代表范围。'])assert.equal(speechText(text),text);
 assert.equal(speechText('请阅读[说明](https://example.com/a)。'),'请阅读说明。');
 assert.equal(speechText('**我听见了**。'),'我听见了。');
});
test('fragmented deltas cannot turn punctuation inside a gesture into spoken fragments',()=>{
 for(const minimum of [0,8]){
  const stream=new Sentences({minimum}),out=[];
  for(const c of '我听见了。[轻轻点头。]你继续说就好。')out.push(...stream.push(c));
  out.push(...stream.push('',true));assert.equal(out.join(''),'我听见了。你继续说就好。');
  assert(!out.some(x=>/点头|\[|\]/.test(x)));
 }
});
