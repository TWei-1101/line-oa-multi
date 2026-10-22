import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { OpenClawBridge } from "../src/openclaw.js";
import { MultiWebhook } from "../src/webhook.js";
const group = "C" + "a".repeat(32),
  dest = "U" + "b".repeat(32),
  secret = "c".repeat(32);
const endpoint = {
  mode: "override",
  url: "http://family.local/v1/responses",
  token: "family-secret",
  agent: "family-line",
  timeout_seconds: 30,
  protocol: "family-text-v1",
};
const answer = { text: "reply" };
async function setup() {
  const root = await mkdtemp(tmpdir() + "/family-int-");
  const calls: any[] = [],
    sent: any[] = [];
  const deps = {
    boundDestination:()=>dest,
    hasAlias: () => true,
    resolveAlias: () => "oa-chat-not-messaging-id",
    sender: () => ({
      send: async (...args: any[]) => {
        sent.push(args);
        return { result: "SUBMITTED" as const, sendId: "x" };
      },
      sendImage: async () => {
        throw Error("unexpected image");
      },
    }),
    fetch: async (url: any, init: any) => {
      calls.push({ url, init });
      return Response.json(answer);
    },
  };
  let bridge = new OpenClawBridge(root, deps);
  await bridge.load();
  bridge.configure({
    url: "http://mac.local/v1/responses",
    token: "mac-secret",
  });
  bridge.configure(
    {
      enabled: true,
      expected_destination:dest,
      endpoint,
      admission: "self-mention-group-text",
      groups: [group],
      routes: [{ source_type: "group", source_id: group, who: "family-group" }],
    },
    "family",
  );
  const hook = new MultiWebhook(root, (e) => bridge.enqueue(e));
  await hook.load();
  await hook.set("family", true, secret);
  return {
    root,
    calls,
    sent,
    hook,
    get bridge() {
      return bridge;
    },
    async restart() {
      await bridge.stop();
      bridge = new OpenClawBridge(root, deps);
      await bridge.load();
    },
    async close() {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function receive(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  mention: any,
  text = "hi @bot",
) {
  const raw = Buffer.from(
    JSON.stringify({
      destination: dest,
      events: [
        {
          webhookEventId: id,
          type: "message",
          source: { type: "group", groupId: group },
          message: { type: "text", text, mention: { mentionees: mention } },
        },
      ],
    }),
  );
  return f.hook.receive(
    raw,
    createHmac("sha256", secret).update(raw).digest("base64"),
  );
}
test("signed family policy rejects negatives only from bridge, keeps HA inbox and queues positives once", async () => {
  const f = await setup();
  try {
    for (const [i, m] of [
      [],
      [{ index: 3, length: 4, type: "all" }],
      [{ index: 3, length: 4, type: "user", isSelf: false, userId: dest }],
      [
        {
          index: 3,
          length: 4,
          type: "user",
          isSelf: true,
          userId: "U" + "d".repeat(32),
        },
      ],
      [{ index: 3, length: 4, type: "user", isSelf: "true" }],
    ].entries())
      await receive(f, "negative-" + i, m);
    assert.equal(f.hook.events(0).events.length, 5);
    assert.equal(f.bridge.status().jobs.length, 0);
    for (const [i, m] of [
      [{ index: 3, length: 4, type: "user", isSelf: true }],
      [{ index: 3, length: 4, type: "user", userId: dest }],
      [{ index: 3, length: 4, type: "user", isSelf: true, userId: dest }],
    ].entries()) {
      await receive(f, "positive-" + i, m);
      await receive(f, "positive-" + i, m);
    }
    assert.equal(f.bridge.status().jobs.length, 3);
  } finally {
    await f.close();
  }
});
test("family snapshot survives rotation and restart; wire exact DTO and private revision, original recipient", async () => {
  const f = await setup();
  try {
    await receive(f, "positive-rotate", [
      { index: 3, length: 4, type: "user", isSelf: true },
    ]);
    f.bridge.configure(
      {
        enabled: true,
        endpoint: {
          ...endpoint,
          token: "rotated",
          url: "http://new.local/v1/responses",
        },
      },
      "family",
    );
    const db = new DatabaseSync(f.root + "/openclaw.sqlite");
    const row = db.prepare("SELECT body FROM jobs").get() as any;
    assert.ok(!row.body.includes("family-secret"));
    db.close();
    await f.restart();
    await f.bridge.tick();
    assert.equal(f.calls[0].url, endpoint.url);
    const init = f.calls[0].init;
    assert.deepEqual(JSON.parse(init.body), {
      version: 1,
      event_id: "positive-rotate",
      group_id: group,
      text: "hi @bot",
    });
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer family-secret");
    assert.equal(headers.get("x-openclaw-agent-id"), null);
    assert.deepEqual(f.sent, [
      ["family-group", "reply", "oa-chat-not-messaging-id"],
    ]);
  } finally {
    await f.close();
  }
});
test("override PATCH preserves own token; empty rejects; explicit inherit cannot enable family", async () => {
  const f = await setup();
  try {
    const { token, ...rest } = endpoint;
    assert.doesNotThrow(() =>
      f.bridge.configure({ enabled: true, endpoint: rest }, "family"),
    );
    assert.throws(() =>
      f.bridge.configure(
        { enabled: true, endpoint: { ...endpoint, token: "" } },
        "family",
      ),
    );
    assert.throws(() =>
      f.bridge.configure(
        { enabled: true, endpoint: { mode: "inherit" } },
        "family",
      ),
    );
    assert.ok(!JSON.stringify(f.bridge.status()).includes("family-secret"));
  } finally {
    await f.close();
  }
});
test('missing immutable credential revision is held, never replaced by rotated credentials',async()=>{const f=await setup();try{await receive(f,'missing-revision',[{index:3,length:4,type:'user',isSelf:true}]);const db=new DatabaseSync(f.root+'/openclaw.sqlite');db.exec('DELETE FROM credential_revisions');db.close();await f.bridge.tick();const job=f.bridge.status().jobs.find(j=>j.id)!;assert.equal(job.state,'unknown');assert.equal(job.error,'CREDENTIAL_REVISION_MISSING');assert.equal(f.calls.length,0);}finally{await f.close();}});

test('corrupt family snapshot holds before any upstream dispatch',async()=>{const f=await setup();try{await receive(f,'corrupt-snapshot',[{index:3,length:4,type:'user',isSelf:true}]);const db=new DatabaseSync(f.root+'/openclaw.sqlite');const row=db.prepare('SELECT id,body FROM jobs').get() as any;const job=JSON.parse(row.body);job.snapshot.protocol='legacy-responses';db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job),row.id);db.close();await f.bridge.tick();const held=f.bridge.status().jobs.find(j=>j.id===row.id)!;assert.equal(held.state,'unknown');assert.equal(held.error,'SNAPSHOT_INVALID_REVIEW_REQUIRED');assert.equal(f.calls.length,0);}finally{await f.close();}});
test('family intake can disable and pause while worker is active',async()=>{const f=await setup();try{await receive(f,'pause-active',[{index:3,length:4,type:'user',isSelf:true}]);const active=f.bridge.tick();assert.doesNotThrow(()=>f.bridge.configure({enabled:false},'family'));await f.bridge.pause();await active;assert.equal(f.bridge.status('family').accounts.family.enabled,false);}finally{await f.close();}});

test('family requires independently configured expected destination',async()=>{
 const f=await setup();try{
  f.bridge.configure({enabled:false},'family');
  assert.throws(()=>f.bridge.configure({enabled:true,expected_destination:''},'family'),/FAMILY_DESTINATION_REQUIRED/);
  assert.throws(()=>f.bridge.configure({enabled:true,expected_destination:'U'+'e'.repeat(32)},'family'),/FAMILY_SIGNED_BINDING_REQUIRED/);
  f.bridge.configure({enabled:true,expected_destination:dest},'family');
  const raw=Buffer.from(JSON.stringify({destination:'U'+'e'.repeat(32),events:[{webhookEventId:'wrong-expected-bot',type:'message',source:{type:'group',groupId:group},message:{type:'text',text:'hi @bot',mention:{mentionees:[{index:3,length:4,type:'user',isSelf:true}]}}}]}));
  await f.hook.receive(raw,createHmac('sha256',secret).update(raw).digest('base64'));
  assert.equal(f.bridge.status().jobs.length,0);assert.equal(f.hook.events(0).events.length,1);
 }finally{await f.close();}
});
test('signed whole mention metadata and UTF16 retained span matrix',async()=>{
 const f=await setup();try{
  const good={index:3,length:4,type:'user',isSelf:true};
  const cases:any[]=[
   [[{...good,userId:null}]],[[{...good,userId:0}]],[[{...good,userId:''}]],[[{...good,isSelf:null}]],
   [[{...good,isSelf:1}]],[[{...good,index:3.5}]],[[{...good,length:0}]],[[{...good,index:-1}]],
   [[{...good,index:6,length:2}]],[[good,{...good,index:-1}]],[[good,null]],
   [Array(51).fill(good)],[[{...good,padding:'x'.repeat(17000)}]],
   [[{...good,index:4,length:1}],'abc🙂'],[[{...good,index:3,length:1}],'abc🙂'],
   [[{...good,index:4999,length:4}],'x'.repeat(4999)+'@bot'],
   [[{...good,index:0,length:1}],String.fromCharCode(0xd800)],[[{index:3,length:4,type:'user'}]],
  ];
  for(const [i,[mentions,text]] of cases.entries())await receive(f,'metadata-negative-'+i,mentions,text);
  assert.equal(f.hook.events(0).events.length,cases.length);assert.equal(f.bridge.status().jobs.length,0);
 }finally{await f.close();}
});
test('snapshot pins session and admission policy and corrupt ready snapshots hold',async()=>{
 const f=await setup();try{
  await receive(f,'policy-snapshot',[{index:3,length:4,type:'user',isSelf:true}]);
  const db=new DatabaseSync(f.root+'/openclaw.sqlite');const row=db.prepare('SELECT id,body FROM jobs').get() as any;const job=JSON.parse(row.body);
  assert.equal(job.snapshot.admission,'self-mention-group-text');assert.equal(job.snapshot.expected_destination,dest);
  assert.equal(job.snapshot.session_policy,'family-group-v1');assert.match(job.snapshot.session_key,/^line-family:v1:family:[a-f0-9]{64}$/);
  job.snapshot.session_key='owner:main';job.state='ready';job.outputs=[{type:'text',text:'must not send'}];db.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run('ready',JSON.stringify(job),row.id);db.close();
  await f.restart();await f.bridge.tick();assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.equal(f.bridge.status().counts.unknown,1);
 }finally{await f.close();}
});

test('repeated and interrupted migration never pins unsnapshotted family or legacy rows; terminal identities remain',async()=>{
 const f=await setup();try{
  await receive(f,'migration-fixture',[{index:3,length:4,type:'user',isSelf:true}]);
  const db=new DatabaseSync(f.root+'/openclaw.sqlite');const original=JSON.parse((db.prepare('SELECT body FROM jobs').get() as any).body);
  db.exec('DELETE FROM jobs');
  for(const account of ['family','aiassistant'])for(const state of ['pending','ready','generating','sending','submitted','ignored']){
   const job=structuredClone(original);job.id=account+'-'+state;job.account=account;job.event.account=account;job.state=state;delete job.snapshot;delete job.credential_revision;job.outputs=[{type:'text',text:'retained'}];job.next=0;
   db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,job.account,job.lane,job.state,JSON.stringify(job));
  }
  db.close();await f.restart();await f.bridge.tick();await f.restart();await f.bridge.tick();
  const check=new DatabaseSync(f.root+'/openclaw.sqlite');const jobs=check.prepare('SELECT body FROM jobs').all().map((r:any)=>JSON.parse(r.body));check.close();
  assert.equal(jobs.length,12);for(const job of jobs){assert.equal(job.snapshot,undefined);assert.equal(job.credential_revision,undefined);assert.equal(job.recipient,original.recipient);assert.equal(job.next,0);if(!job.id.endsWith('submitted')&&!job.id.endsWith('ignored')){assert.equal(job.state,'unknown');assert.equal(job.error,'SNAPSHOT_INVALID_REVIEW_REQUIRED');}else assert.ok(['submitted','ignored'].includes(job.state));}
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
 }finally{await f.close();}
});
test('ready restart and manual review keep endpoint recipient revision and policy snapshot unchanged',async()=>{
 const f=await setup();try{
  await receive(f,'ready-restart',[{index:3,length:4,type:'user',isSelf:true}]);
  const db=new DatabaseSync(f.root+'/openclaw.sqlite');const job=JSON.parse((db.prepare('SELECT body FROM jobs').get() as any).body),snapshot=structuredClone(job.snapshot),revision=job.credential_revision;
  job.state='sending';job.outputs=[{type:'text',text:'first'},{type:'text',text:'second'}];job.next=0;
  db.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run('sending',JSON.stringify(job),job.id);db.close();
  await f.restart();assert.equal(f.bridge.status().counts.unknown,1);f.bridge.review(job.id,'mark_submitted');await f.bridge.tick();
  assert.deepEqual(f.sent,[['family-group','second','oa-chat-not-messaging-id']]);assert.equal(f.calls.length,0);
  const check=new DatabaseSync(f.root+'/openclaw.sqlite');const saved=JSON.parse((check.prepare('SELECT body FROM jobs').get() as any).body);check.close();assert.deepEqual(saved.snapshot,snapshot);assert.equal(saved.credential_revision,revision);assert.equal(saved.next,2);
 }finally{await f.close();}
});
test('maintenance pause actually waits for generation and suppresses fresh work until explicit resume',async()=>{
 const f=await setup();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let calls=0;
 const controlled=new OpenClawBridge(f.root,{boundDestination:()=>dest,hasAlias:()=>true,resolveAlias:()=> 'oa-chat-not-messaging-id',sender:()=>({send:async()=>({result:'SUBMITTED',sendId:'x'}),sendImage:async()=>{throw Error('unexpected');}}),fetch:async()=>{calls++;entered();await gate;return Response.json(answer);}});
 try{
  await f.bridge.stop();await controlled.load();controlled.enqueue([{sequence:1,account:'family',webhook_event_id:'pause-generation',type:'message',message_type:'text',text:'hi @bot',source_type:'group',group_id:group,destination:dest,mentions:[{index:3,length:4,type:'user',isSelf:true}],is_redelivery:false}]);
  const active=controlled.tick();await started;let drained=false;const pause=controlled.pause().then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);
  assert.doesNotThrow(()=>controlled.configure({enabled:false},'family'));release();await pause;await active;assert.equal(drained,true);assert.equal(calls,1);
  controlled.configure({enabled:true},'family');controlled.enqueue([{sequence:2,account:'family',webhook_event_id:'pause-next-job',type:'message',message_type:'text',text:'hi @bot',source_type:'group',group_id:group,destination:dest,mentions:[{index:3,length:4,type:'user',isSelf:true}],is_redelivery:false}]);
  controlled.start();await controlled.tick();assert.equal(calls,1);assert.equal(controlled.status().counts.pending,1);controlled.resume();await controlled.tick();assert.equal(calls,2);
 }finally{release?.();await controlled.stop();await f.close();}
});

test('every immutable snapshot field and malformed revision rejects before ready send or pending generation',async()=>{
 const corruptions:((j:any)=>void)[]=[j=>delete j.snapshot,j=>j.snapshot.version=99,j=>j.snapshot.url='http://u:p@family.local/v1/responses',j=>j.snapshot.agent='main',j=>j.snapshot.agent=null,j=>j.snapshot.timeout_seconds='30',j=>j.snapshot.timeout_seconds=0,j=>j.snapshot.protocol='legacy-responses',j=>delete j.snapshot.admission,j=>j.snapshot.admission='legacy',j=>j.snapshot.session_policy='owner',j=>j.snapshot.session_key='owner:main',j=>j.snapshot.expected_destination='U'+'e'.repeat(32),j=>j.snapshot.extra='untrusted',j=>j.recipient=null,j=>j.credential_revision='1',j=>j.credential_revision=0,j=>j.credential_revision=null,j=>j.event.destination='U'+'e'.repeat(32)];
 for(const [i,mutate] of corruptions.entries()){
  const f=await setup();try{await receive(f,'snapshot-matrix-'+i,[{index:3,length:4,type:'user',isSelf:true}]);const db=new DatabaseSync(f.root+'/openclaw.sqlite');const row=db.prepare('SELECT id,body FROM jobs').get() as any;const job=JSON.parse(row.body);job.state=i%2?'ready':'pending';job.outputs=job.state==='ready'?[{type:'text',text:'must not send'}]:[];mutate(job);db.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run(job.state,JSON.stringify(job),row.id);db.close();await f.bridge.tick();assert.equal(f.calls.length,0,'corruption '+i);assert.equal(f.sent.length,0,'corruption '+i);assert.equal(f.bridge.status().counts.unknown,1,'corruption '+i);}finally{await f.close();}
 }
});
test('valid family generating restart is uncertain and explicit review preserves original snapshot',async()=>{
 const f=await setup();try{await receive(f,'generating-family',[{index:3,length:4,type:'user',isSelf:true}]);const db=new DatabaseSync(f.root+'/openclaw.sqlite');const job=JSON.parse((db.prepare('SELECT body FROM jobs').get() as any).body),before=structuredClone(job.snapshot);job.state='generating';db.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run('generating',JSON.stringify(job),job.id);db.close();await f.restart();await f.bridge.tick();assert.equal(f.bridge.status().counts.failed,1);assert.equal(f.calls.length,0);f.bridge.configure({endpoint:{...endpoint,url:'http://changed.local/v1/responses',token:'changed'}},'family');f.bridge.review(job.id,'retry');await f.bridge.tick();assert.equal(f.calls[0].url,endpoint.url);const check=new DatabaseSync(f.root+'/openclaw.sqlite');const saved=JSON.parse((check.prepare('SELECT body FROM jobs').get() as any).body);check.close();assert.deepEqual(saved.snapshot,before);assert.equal(saved.credential_revision,job.credential_revision);}finally{await f.close();}
});

test('signed admission retains bounded original mentions through truncation and accepts count limit',async()=>{
 const f=await setup();try{const mention={index:3,length:4,type:'user',userId:dest};await receive(f,'count-limit-positive',Array(50).fill(mention));await receive(f,'truncated-positive',[mention],'hi @bot '+'x'.repeat(5000));await receive(f,'malformed-second-type',[mention,{...mention,type:'unknown'}]);assert.equal(f.bridge.status().jobs.length,2);assert.equal(f.hook.events(0).events.length,3);assert.equal(f.hook.events(0).events[1].text!.length,5000);}finally{await f.close();}
});
