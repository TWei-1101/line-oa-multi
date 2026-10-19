import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MultiWebhook } from './dist/webhook.js';
const secrets={home:'abcd1234abcd1234abcd1234abcd1234', invest:'efef1234efef1234efef1234efef1234'};
const bots={home:'U'+'a'.repeat(32),invest:'U'+'b'.repeat(32)};
const receiver=new MultiWebhook('/test');
await receiver.load();
await receiver.set('home',true,secrets.home);
await receiver.set('invest',true,secrets.invest);
const body=Buffer.from(JSON.stringify({destination:bots.invest,events:[{
 webhookEventId:'01H78MXXAXYZ0123456789ABCD',type:'message',timestamp:123456789,
 source:{type:'user',userId:'UexampleUser'},message:{type:'text',text:'hello from LINE'}
}]}));
const sign=(secret,data)=>createHmac('sha256',secret).update(data).digest('base64');
const getBot=id=>bots[id];
await assert.rejects(()=>receiver.receive(body,sign(secrets.home,body),getBot),{code:'LINE_DESTINATION_MISMATCH'});
assert.deepEqual(await receiver.receive(body,sign(secrets.invest,body),getBot),{accepted:1,duplicates:0});
assert.deepEqual(await receiver.receive(body,sign(secrets.invest,body),getBot),{accepted:0,duplicates:1});
await assert.rejects(()=>receiver.receive(Buffer.from('tampered'),sign(secrets.invest,body),getBot),{code:'INVALID_LINE_SIGNATURE'});
assert.equal(receiver.events(0).events[0].text,'hello from LINE');
assert.equal(receiver.events(0).events[0].account,'invest');
const reload=new MultiWebhook('/test');await reload.load();
assert.equal(reload.events(0).events.length,1);
assert.deepEqual(await reload.receive(body,sign(secrets.invest,body),getBot),{accepted:0,duplicates:1});
await reload.remove('invest');
await assert.rejects(()=>reload.receive(body,sign(secrets.invest,body),getBot),{code:'INVALID_LINE_SIGNATURE'});
console.log('webhook test passed: signature, destination, dedup, persistence, removal');
