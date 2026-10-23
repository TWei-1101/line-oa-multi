import test from 'node:test'; import assert from 'node:assert/strict'; import { createHmac } from 'node:crypto'; import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { MultiWebhook, familyMentionAdmitted } from '../src/webhook.js';
const dest='U'+'a'.repeat(32), group='C'+'b'.repeat(32), secret='x'.repeat(32);
function signed(packet:unknown){const raw=Buffer.from(JSON.stringify(packet));return {raw,sig:createHmac('sha256',secret).update(raw).digest('base64')};}
test('signed webhook preserves self mention metadata and family admission accepts both identity forms', async()=>{const dir=await mkdtemp(tmpdir()+'/family-');try{const w=new MultiWebhook(dir);await w.load();await w.set('family',true,secret);const p={destination:dest,events:[{webhookEventId:'eventabc1',type:'message',message:{type:'text',id:'1',text:'hi @bot',mention:{mentionees:[{index:3,length:4,type:'user',isSelf:true}]}},source:{type:'group',groupId:group}}]};const x=signed(p);await w.receive(x.raw,x.sig);const e=w.events(0).events[0]!;assert.deepEqual(e.mentions,[{index:3,length:4,type:'user',isSelf:true}]);assert.equal(familyMentionAdmitted(e,{account:'family',groups:new Set([group]),destination:dest}),true);assert.equal(familyMentionAdmitted({...e,mentions:[{index:3,length:4,type:'user',userId:dest}]},{account:'family',groups:new Set([group]),destination:dest}),true);}finally{await rm(dir,{recursive:true,force:true});}});
test('family admission rejects malformed or contradictory mention identity without rejecting webhook ingestion',()=>{const e:any={account:'family',source_type:'group',group_id:group,message_type:'text',text:'hi @bot',mentions:[{index:3,length:4,type:'user',isSelf:true,userId:'U'+'c'.repeat(32)}]};assert.equal(familyMentionAdmitted(e,{account:'family',groups:new Set([group]),destination:dest}),false);e.mentions=[{index:3,length:4,type:'user',isSelf:false,userId:dest}];assert.equal(familyMentionAdmitted(e,{account:'family',groups:new Set([group]),destination:dest}),false);});

import { isFamilyKeywordTrigger, isSmartIntentTrigger, isFamilyEventAdmitted } from '../src/openclaw.js';

test('isFamilyKeywordTrigger matches cat keywords and rejects casual talk', () => {
  assert.equal(isFamilyKeywordTrigger('喵 今天天氣如何'), true);
  assert.equal(isFamilyKeywordTrigger('喵，今天好嗎'), true);
  assert.equal(isFamilyKeywordTrigger('助理喵 致祥三街附近有什麼'), true);
  assert.equal(isFamilyKeywordTrigger('小貓 烏咪在幹嘛'), true);
  assert.equal(isFamilyKeywordTrigger('貓咪 請問一下'), true);
  assert.equal(isFamilyKeywordTrigger('請問 垃圾車幾點來'), true);
  assert.equal(isFamilyKeywordTrigger('問一下 娜比在3樓嗎'), true);
  assert.equal(isFamilyKeywordTrigger('@自動回覆喵 你好'), true);
  assert.equal(isFamilyKeywordTrigger('喵'), true);

  // Casual talk should NOT match
  assert.equal(isFamilyKeywordTrigger('今天想吃貓耳朵麵'), false);
  assert.equal(isFamilyKeywordTrigger('我到家了'), false);
  assert.equal(isFamilyKeywordTrigger('好喔'), false);
  assert.equal(isFamilyKeywordTrigger('哈哈'), false);
});

test('isSmartIntentTrigger matches question patterns with inquiry keywords', () => {
  assert.equal(isSmartIntentTrigger('致祥三街附近哪裡有洗車場？'), true);
  assert.equal(isSmartIntentTrigger('垃圾車大概幾點會到？'), true);
  assert.equal(isSmartIntentTrigger('烏咪的飼料還有沒有？'), true);
  assert.equal(isSmartIntentTrigger('今天能不能幫我看一下貓咪？'), true);

  // Negative cases
  assert.equal(isSmartIntentTrigger('我不知道要去哪裡'), false); // no ?
  assert.equal(isSmartIntentTrigger('好喔？'), false); // no question keywords
  assert.equal(isSmartIntentTrigger('今天好累喔'), false);
});

test('isFamilyEventAdmitted handles all admission modes correctly', () => {
  const baseEvent = {
    sequence: 1,
    account: 'family',
    webhook_event_id: 'ev-1',
    type: 'message',
    message_type: 'text',
    source_type: 'group',
    group_id: group,
    destination: dest,
    is_redelivery: false
  };
  const groups = new Set([group]);

  // Mode 1: self-mention-group-text only admits mentions
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '喵 你好' }, { account: 'family', groups, destination: dest, admission: 'self-mention-group-text' }), false);
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '@bot 你好', mentions: [{ index: 0, length: 4, type: 'user', isSelf: true }] }, { account: 'family', groups, destination: dest, admission: 'self-mention-group-text' }), true);

  // Mode 2: keyword-prefix admits mentions and keywords
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '喵 你好' }, { account: 'family', groups, destination: dest, admission: 'keyword-prefix' }), true);
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '我回家了' }, { account: 'family', groups, destination: dest, admission: 'keyword-prefix' }), false);

  // Mode 3: followup-window admits within window
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '我回家了' }, { account: 'family', groups, destination: dest, admission: 'followup-window', isWithinFollowup: () => true }), true);
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '我回家了' }, { account: 'family', groups, destination: dest, admission: 'followup-window', isWithinFollowup: () => false }), false);

  // Mode 4: keyword-or-followup admits either keyword or followup
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '喵 你好' }, { account: 'family', groups, destination: dest, admission: 'keyword-or-followup', isWithinFollowup: () => false }), true);
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '那明天呢' }, { account: 'family', groups, destination: dest, admission: 'keyword-or-followup', isWithinFollowup: () => true }), true);
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '好喔' }, { account: 'family', groups, destination: dest, admission: 'keyword-or-followup', isWithinFollowup: () => false }), false);

  // Mode 5: smart-intent admits keywords, followup, or smart inquiry
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '致祥三街附近哪裡有好吃的？' }, { account: 'family', groups, destination: dest, admission: 'smart-intent', isWithinFollowup: () => false }), true);
  assert.equal(isFamilyEventAdmitted({ ...baseEvent, text: '好喔' }, { account: 'family', groups, destination: dest, admission: 'smart-intent', isWithinFollowup: () => false }), false);
});
