import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { OpenClawBridge, parseAnswer, splitText } from '../src/openclaw.js';
import { MultiWebhook, type ReceivedEvent } from '../src/webhook.js';
import { createMacAdapter, inlineMedia } from '../scripts/openclaw-mac.js';
import type { SendResult } from '../src/types.js';

const user='U'+'a'.repeat(32),other='U'+'b'.repeat(32),secret='c'.repeat(32);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH9sAAAAASUVORK5CYII=';
const event=(id='event-000001',account='aiassistant'):ReceivedEvent=>({sequence:1,account,webhook_event_id:id,type:'message',message_type:'text',text:'你好',source_type:'user',user_id:user,is_redelivery:false});
const answer=(text:string)=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]});
const ok=():SendResult=>({result:'SUBMITTED',sendId:'mock'});
async function fixture(fetcher:typeof fetch = async()=>Response.json(answer('完整回答'))){
  const root=await mkdtemp(join(tmpdir(),'oa-claw-'));
  const sent:{who:string;text?:string;image?:Buffer}[]=[];
  const sender={send:async(who:string,text:string)=>{sent.push({who,text});return ok();},
    sendImage:async(who:string,image:Buffer)=>{sent.push({who,image});return ok();}};
  let now=Date.now();
  const deps={sender:()=>sender,hasAlias:()=>true,fetch:fetcher,now:()=>now};
  let bridge=new OpenClawBridge(root,deps);await bridge.load();
  bridge.configure({url:'http://mac.local:18790/v1/responses',token:'secret',agent:'main',timeout_seconds:300});
  bridge.configure({enabled:true,channel_access_token:'line-secret',routes:[{source_type:'user',source_id:user,who:'simon'}]},'aiassistant');
  return {root,sent,sender,deps,get bridge(){return bridge;},advance(){now+=400_000;},
    async restart(){await bridge.stop();bridge=new OpenClawBridge(root,deps);await bridge.load();},
    async close(){await bridge.stop();await rm(root,{recursive:true,force:true});}};
}

test('signed webhook durably queues once, survives restart, ignores family/unbound sources and never uses reply/push',async()=>{
  const calls:{url:string;body:any;headers:Headers}[]=[];
  const f=await fixture(async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});return Response.json(answer('回答'));});
  try{
    const hook=new MultiWebhook(f.root,events=>f.bridge.enqueue(events));await hook.load();await hook.set('aiassistant',true,secret);
    const body=Buffer.from(JSON.stringify({destination:other,events:[{webhookEventId:'event-000001',type:'message',source:{type:'user',userId:user},message:{id:'123456',type:'text',text:'你好'}}]}));
    const sig=createHmac('sha256',secret).update(body).digest('base64');
    await assert.rejects(hook.receive(body,'invalid'),/INVALID_LINE_SIGNATURE/);
    assert.equal(f.bridge.status().jobs.length,0);
    await hook.receive(body,sig);await hook.receive(body,sig);
    assert.equal(f.bridge.status().jobs.length,1);
    f.bridge.enqueue([event('family-event','family'),{...event('unbound-event'),user_id:other}]);
    assert.equal(f.bridge.status().jobs.length,1);
    await f.restart();await f.bridge.tick();
    assert.equal(calls.length,1);assert.equal(calls[0]!.url,'http://mac.local:18790/v1/responses');
    assert.equal(calls[0]!.headers.get('x-openclaw-session-key'),`line-oa-multi:aiassistant:user:${user}`);
    assert.equal(calls[0]!.body.input[0].content[0].text,'你好');
    assert.deepEqual(f.sent,[{who:'simon',text:'回答'}]);
    await f.restart();f.bridge.enqueue([event()]);await f.bridge.tick();assert.equal(f.sent.length,1);
    assert.equal(f.bridge.status().counts.submitted,1);
    const publicStatus=JSON.stringify(f.bridge.status());assert.ok(!publicStatus.includes('line-secret'));assert.ok(!publicStatus.includes('"token":"secret"'));
  }finally{await f.close();}
});

test('long Unicode answers preserve all content and image outputs are sent in order',async()=>{
  const text='你好🙂'.repeat(2500)+'\n結尾';
  const chunks=splitText(text);assert.equal(chunks.join(''),text);assert.ok(chunks.every(c=>c.length<=5000 && !/[\uD800-\uDBFF]$/.test(c)));
  const response=answer(text);response.output[0]!.content.push({type:'output_image',image_url:png} as any);
  const f=await fixture(async()=>Response.json(response));
  try{f.bridge.enqueue([event()]);await f.bridge.tick();
    assert.equal(f.sent.filter(s=>s.text).map(s=>s.text).join(''),text);
    assert.deepEqual(f.sent.at(-1)?.image,Buffer.from(png.split(',')[1]!,'base64'));
  }finally{await f.close();}
});

test('incoming image is downloaded with its own LINE token, persisted and passed inline to OpenClaw',async()=>{
  const calls:{url:string;headers:Headers;body:any}[]=[];
  const f=await fixture(async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});
    if(String(url).startsWith('https://api-data.line.me/'))return new Response(Buffer.from(png.split(',')[1]!,'base64'),{headers:{'Content-Type':'image/png'}});
    return Response.json(answer('這是一張圖片'));
  });
  try{f.bridge.enqueue([{...event(),message_type:'image',message_id:'123456'}]);await f.bridge.tick();
    assert.equal(calls[0]!.url,'https://api-data.line.me/v2/bot/message/123456/content');
    assert.equal(calls[0]!.headers.get('authorization'),'Bearer line-secret');
    assert.equal(calls[1]!.headers.get('authorization'),'Bearer secret');
    assert.equal(calls[1]!.body.input[0].content[1].source.data,png.split(',')[1]);assert.equal(f.sent[0]?.text,'這是一張圖片');
  }finally{await f.close();}
});

test('uncertain send pauses only its conversation and manual review resumes from the next unsent part',async()=>{
  const f=await fixture(async()=>Response.json(answer('a'.repeat(5001))));
  let calls=0;f.sender.send=async(who,text)=>{calls++;f.sent.push({who,text});return calls===2?{result:'UNKNOWN',sendId:'uncertain'}:ok();};
  try{
    f.bridge.enqueue([event(),event('event-000002')]);await f.bridge.tick();assert.equal(f.bridge.status().counts.unknown,1);
    await f.restart();await f.bridge.tick();assert.equal(calls,2);
    const job=f.bridge.status().jobs.find(j=>j.state==='unknown')!;
    assert.equal(job.next_part,1);f.bridge.review(job.id,'mark_submitted');
    await f.bridge.tick();assert.equal(calls,4);assert.equal(f.bridge.status().counts.submitted,2);
  }finally{await f.close();}
});

test('explicit preflight busy and rate limits retry without regenerating the answer; failed jobs are retained',async()=>{
  let generations=0;const f=await fixture(async()=>{generations++;return Response.json(answer('answer'));});
  let sends=0;f.sender.send=async()=>{sends++;if(sends===1)throw new Error('SEND_BUSY');return ok();};
  try{f.bridge.enqueue([event()]);await f.bridge.tick();assert.equal(f.bridge.status().counts.ready,1);
    f.advance();await f.restart();await f.bridge.tick();assert.equal(generations,1);assert.equal(sends,2);
    f.sender.send=async()=>({result:'FAILED',sendId:'bad',status:403,error:'CSRF'});
    f.bridge.enqueue([event('event-000002')]);await f.bridge.tick();assert.equal(f.bridge.status().counts.failed,1);
    await assert.rejects(async()=>f.bridge.removeAccount('aiassistant'),/OPENCLAW_JOBS_PENDING/);
  }finally{await f.close();}
});

test('incomplete, unsupported and lost AI responses are never silently submitted or automatically rerun',async()=>{
  assert.throws(()=>parseAnswer({...answer('partial'),status:'incomplete'}),/INCOMPLETE/);
  assert.throws(()=>parseAnswer(answer('MEDIA:/Users/test/private.png')),/ADAPTER_REQUIRED/);
  assert.throws(()=>parseAnswer({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_audio'}]}]}),/UNSUPPORTED/);
  let calls=0;const f=await fixture(async()=>{calls++;throw new Error('network');});
  try{f.bridge.enqueue([event()]);await f.bridge.tick();await f.restart();f.advance();await f.bridge.tick();
    assert.equal(calls,1);assert.equal(f.sent.length,0);assert.equal(f.bridge.status().jobs[0]?.error,'OPENCLAW_RESULT_UNCERTAIN');
  }finally{await f.close();}
});

test('restart during sending never replays the in-flight part; during generation requires review',async()=>{
  const f=await fixture();
  try{
    f.bridge.enqueue([event(),{...event('event-000002'),user_id:user}]);
    const ids=f.bridge.status().jobs.map(j=>j.id);await f.bridge.stop();
    const db=new DatabaseSync(join(f.root,'openclaw.sqlite'));
    for(const [i,id] of ids.entries()){
      const row=db.prepare('SELECT body FROM jobs WHERE id=?').get(id) as {body:string};const job=JSON.parse(row.body);
      job.state=i===0?'sending':'generating';
      db.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run(job.state,JSON.stringify(job),id);
    }db.close();
    // stop is deliberately idempotent, as a process teardown can be repeated.
    await f.restart();assert.equal(f.bridge.status().counts.unknown,1);assert.equal(f.bridge.status().counts.failed,1);
    await f.bridge.tick();assert.equal(f.sent.length,0);
  }finally{await f.close();}
});

test('configuration validates routes, secret redaction, URL credentials and source/alias ownership',async()=>{
  const f=await fixture();
  try{
    assert.throws(()=>f.bridge.configure({url:'http://user:pass@mac/v1/responses'}),/INVALID_OPENCLAW_URL/);
    assert.throws(()=>f.bridge.configure({url:'file:///v1/responses'}),/INVALID_OPENCLAW_URL/);
    assert.throws(()=>f.bridge.configure({enabled:true,routes:[{source_type:'group',source_id:user,who:'simon'}]},'aiassistant'),/INVALID_OPENCLAW_ROUTE/);
    f.bridge.configure({enabled:false},'aiassistant');f.bridge.enqueue([event()]);assert.equal(f.bridge.status().jobs.length,0);
  }finally{await f.close();}
});

test('queue capacity refuses entire webhook batch and leaves retry possible',async()=>{
  const f=await fixture();
  try{
    f.bridge.enqueue(Array.from({length:999},(_,i)=>event(`event-${i.toString().padStart(8,'0')}`)));
    assert.throws(()=>f.bridge.enqueue([event('extra-event-001'),event('extra-event-002')]),/OPENCLAW_QUEUE_FULL/);
    assert.equal(f.bridge.status().counts.pending,999);
  }finally{await f.close();}
});

test('Mac adapter embeds local image parts, preserves text and rejects paths outside its media root',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oa-mac-'));const root=join(dir,'workspace');await mkdir(root);
  try{
    await writeFile(join(root,'test.png'),Buffer.from(png.split(',')[1]!,'base64'));
    await writeFile(join(dir,'private.png'),Buffer.from(png.split(',')[1]!,'base64'));
    const result=await inlineMedia(answer('第一段\nMEDIA:test.png\n第二段'),root);
    const outputs=parseAnswer(result);assert.equal(outputs[1]?.type,'image');
    assert.equal(outputs.filter(p=>p.type==='text').map(p=>p.text).join(''),'第一段\n\n第二段');
    assert.equal(parseAnswer(await inlineMedia(answer('![圖](test.png)'),root))[0]?.type,'image');
    await assert.rejects(inlineMedia(answer('MEDIA:../private.png'),root),/OUTSIDE_ALLOWED_ROOT/);
    const token='t'.repeat(40);let upstream=0;
    const server=createMacAdapter({gatewayUrl:'http://127.0.0.1:18789',gatewayToken:'gateway-secret',bridgeToken:token,mediaRoot:root,
      fetcher:async(_url,init)=>{upstream++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer gateway-secret');return Response.json(answer('MEDIA:test.png'));}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/responses`;
      assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);assert.equal(upstream,0);
      const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({input:'hi'})});
      assert.equal(response.status,200);assert.equal(parseAnswer(await response.json())[0]?.type,'image');
    }finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
  }finally{await rm(dir,{recursive:true,force:true});}
});
