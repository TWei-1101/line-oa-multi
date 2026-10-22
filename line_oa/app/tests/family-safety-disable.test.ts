import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash,createHmac } from 'node:crypto';
import { createMultiGateway } from '../src/multi-server.js';
import { MultiWebhook } from '../src/webhook.js';
const group='C'+'a'.repeat(32),queuedGroup='C'+'c'.repeat(32),dest='U'+'b'.repeat(32);
const familyRoute={source_type:'group',source_id:group,who:'idle_alias'},queuedRoute={source_type:'group',source_id:queuedGroup,who:'queued_alias'};
async function fixture(){
 const root=await mkdtemp(tmpdir()+'/family-safety-disable-'),multi=root+'/multi';
 await mkdir(multi+'/accounts/family',{recursive:true});await mkdir(multi+'/accounts/aiassistant',{recursive:true});
 await writeFile(multi+'/accounts.json',JSON.stringify({version:1,accounts:['family','aiassistant'].map(id=>({id,createdAt:'2026-10-22T00:00:00Z'}))}));
 await writeFile(multi+'/accounts/family/aliases.json',JSON.stringify({idle_alias:{chatId:'idle-approved-oa',name:'idle'},queued_alias:{chatId:'queued-approved-oa',name:'queued'}}));
 await writeFile(multi+'/accounts/aiassistant/aliases.json',JSON.stringify({assistant:{chatId:'assistant-approved-oa',name:'assistant'}}));
 const hook=new MultiWebhook(multi);await hook.load();await hook.set('family',true,'synthetic-family-channel-secret');await hook.set('aiassistant',true,'synthetic-assistant-channel-secret');
 const raw=Buffer.from(JSON.stringify({destination:dest,events:[]}));await hook.receive(raw,createHmac('sha256','synthetic-family-channel-secret').update(raw).digest('base64'));
 const gw=await createMultiGateway(root,{ingressTrust:()=>true});
 try{
  await gw.start(0,0,'127.0.0.1');const base='http://127.0.0.1:'+(gw.uiServer.address() as any).port;
  const session=await fetch(base+'/api/auth/session',{headers:{'X-Ingress-Path':'/api/hassio_ingress/test'}}),auth=await session.json() as any;
  const headers={'X-Ingress-Path':'/api/hassio_ingress/test',Cookie:session.headers.get('set-cookie')!.split(';')[0]!,'X-CSRF-Token':auth.csrfToken,'Content-Type':'application/json'};
  const api=(path:string,body?:unknown,method='PUT')=>fetch(base+path,{method:body===undefined?'GET':method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await api('/api/openclaw/worker',{action:'pause'},'POST')).status,200);
  assert.equal((await api('/api/openclaw',{url:'http://127.0.0.1:1/v1/responses',token:'synthetic-global-model-token'})).status,200);
  assert.equal((await api('/api/accounts/family/openclaw',{enabled:true,expected_destination:dest,admission:'self-mention-group-text',channel_access_token:'synthetic-family-media-token',endpoint:{mode:'override',url:'http://127.0.0.1:2/v1/responses',token:'synthetic-family-model-token',agent:'family-line',timeout_seconds:30,protocol:'family-text-v1'},routes:[familyRoute,queuedRoute]})).status,200);
  assert.equal((await api('/api/accounts/aiassistant/openclaw',{enabled:true,routes:[{source_type:'user',source_id:'U'+'d'.repeat(32),who:'assistant'}]})).status,200);
  const db=new DatabaseSync(multi+'/openclaw.sqlite');
  const job={id:'immutable-pending-fixture',account:'family',who:'queued_alias',lane:'group:'+queuedGroup,state:'pending',due:0,created:1,attempts:0,next:0,outputs:[],recipient:'queued-approved-oa',credential_revision:1,
   event:{account:'family',webhook_event_id:'immutable-pending-fixture',type:'message',source_type:'group',group_id:queuedGroup,message_type:'text',text:'hi @bot',destination:dest,mentions:[{index:3,length:4,type:'user',isSelf:true}]},
   snapshot:{version:1,url:'http://127.0.0.1:2/v1/responses',agent:'family-line',timeout_seconds:30,protocol:'family-text-v1',admission:'self-mention-group-text',session_policy:'family-group-v1',session_key:'line-family:v1:family:'+createHash('sha256').update(queuedGroup).digest('hex'),expected_destination:dest}};
  db.prepare('INSERT INTO credential_revisions(id,value,created) VALUES(1,?,1)').run('synthetic-original-job-token');db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,job.account,job.lane,job.state,JSON.stringify(job));db.close();
  const stored=()=>{const db=new DatabaseSync(multi+'/openclaw.sqlite');try{return {config:JSON.parse((db.prepare('SELECT body FROM config WHERE id=1').get() as any).body),jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all(),credentials:db.prepare('SELECT * FROM credential_revisions ORDER BY id').all()};}finally{db.close();}};
  return {api,stored,close:async()=>{await gw.stop();await rm(root,{recursive:true,force:true});}};
 }catch(e){await gw.stop();await rm(root,{recursive:true,force:true});throw e;}
}
function assertOnlyDisabled(before:ReturnType<Awaited<ReturnType<typeof fixture>>['stored']>,after:ReturnType<Awaited<ReturnType<typeof fixture>>['stored']>,account:string){
 const expected=structuredClone(before.config);expected.accounts[account].enabled=false;
 assert.deepEqual(after.config,expected);assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.credentials,before.credentials);
}
test('actual HTTP emergency disable after idle alias deletion changes only enabled and preserves immutable queued work',async()=>{
 const f=await fixture();try{
  assert.equal((await f.api('/accounts/family/api/aliases/idle_alias',{},'DELETE')).status,200);
  const before=f.stored(),disabled=await f.api('/api/accounts/family/openclaw',{enabled:false});assert.equal(disabled.status,200,await disabled.text());assertOnlyDisabled(before,f.stored(),'family');
  const enable=await f.api('/api/accounts/family/openclaw',{enabled:true});assert.equal(enable.status,404);assert.match(await enable.text(),/ALIAS_NOT_FOUND/);assertOnlyDisabled(before,f.stored(),'family');
  // A disabled unrelated account's stale alias must not veto another safety disable either.
  const beforeOther=f.stored(),other=await f.api('/api/accounts/aiassistant/openclaw',{enabled:false});assert.equal(other.status,200,await other.text());assertOnlyDisabled(beforeOther,f.stored(),'aiassistant');
  const mixed=await f.api('/api/accounts/family/openclaw',{enabled:false,endpoint:{mode:'override',token:''}});assert.equal(mixed.status,400);assert.match(await mixed.text(),/INVALID_OPENCLAW_OVERRIDE/);assertOnlyDisabled(beforeOther,f.stored(),'aiassistant');
  const paused=await f.api('/api/openclaw/worker',{action:'pause'},'POST');assert.equal(paused.status,200);assert.equal((await paused.json() as any).paused,true);assertOnlyDisabled(beforeOther,f.stored(),'aiassistant');
 }finally{await f.close();}
});
test('actual HTTP scoped safety disable and pause tolerate unrelated enabled family binding drift but enable and mixed patches stay strict',async()=>{
 const f=await fixture();try{
  assert.equal((await f.api('/api/accounts/family/webhook',{enabled:true,channel_secret:'synthetic-rotated-family-secret'})).status,200);
  const before=f.stored(),disabled=await f.api('/api/accounts/aiassistant/openclaw',{enabled:false});assert.equal(disabled.status,200,await disabled.text());assertOnlyDisabled(before,f.stored(),'aiassistant');
  for(const [account,patch] of [['aiassistant',{enabled:true}],['family',{enabled:true}],['aiassistant',{enabled:false,unexpected:true}]] as const){const r=await f.api('/api/accounts/'+account+'/openclaw',patch);assert.equal(r.status,409);assert.match(await r.text(),/FAMILY_SIGNED_BINDING_REQUIRED/);assertOnlyDisabled(before,f.stored(),'aiassistant');}
  const paused=await f.api('/api/openclaw/worker',{action:'pause'},'POST');assert.equal(paused.status,200);assert.equal((await paused.json() as any).paused,true);assertOnlyDisabled(before,f.stored(),'aiassistant');
  const beforeFamily=f.stored(),family=await f.api('/api/accounts/family/openclaw',{enabled:false});assert.equal(family.status,200,await family.text());assertOnlyDisabled(beforeFamily,f.stored(),'family');
 }finally{await f.close();}
});
