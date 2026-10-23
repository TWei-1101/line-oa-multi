import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createMultiGateway } from '../src/multi-server.js';
import { OpenClawBridge } from '../src/openclaw.js';
import { MultiWebhook } from '../src/webhook.js';

const secret='a'.repeat(32), bot='U'+'b'.repeat(32);
const signature=(body:Buffer)=>createHmac('sha256',secret).update(body).digest('base64');
test('webhook verifies raw bytes, destination, deduplicates concurrent and restarted requests', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'multi-hook-'));
 try {
  let hook=new MultiWebhook(dir);await hook.load();await hook.set('alpha',true,secret);
  const verify=Buffer.from(JSON.stringify({destination:bot,events:[]}));
  const raw=Buffer.from(JSON.stringify({destination:bot,events:[{webhookEventId:'event-00000001',type:'message',message:{type:'text',text:'hello'}}]}));
  await assert.rejects(hook.receive(verify,'invalid'),/INVALID_LINE_SIGNATURE/);
  assert.deepEqual(await hook.receive(verify,signature(verify)),{accepted:0,duplicates:0});
  const other=Buffer.from(JSON.stringify({destination:'U'+'c'.repeat(32),events:[]}));
  await assert.rejects(hook.receive(other,signature(other)),/LINE_DESTINATION_MISMATCH/);
  const results=await Promise.all([hook.receive(raw,signature(raw)),hook.receive(raw,signature(raw))]);
  assert.equal(results.reduce((n,r)=>n+r.accepted,0),1);
  assert.equal(results.reduce((n,r)=>n+r.duplicates,0),1);
  hook=new MultiWebhook(dir);await hook.load();
  assert.equal((await hook.receive(raw,signature(raw))).duplicates,1);
  await assert.rejects(hook.receive(other,signature(other)),/LINE_DESTINATION_MISMATCH/);
  assert.equal(hook.events(0).events[0]?.text,'hello');
  assert.equal(hook.events(1).events.length,0);
  await hook.remove('alpha');assert.equal(hook.events(0).events.length,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('real multi gateway enforces Ingress/CSRF, isolates accounts, restores registry and routes shared pairing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'multi-real-'));
 let gw=await createMultiGateway(dir,{ingressTrust:()=>true});
 try{
  await gw.start(0,0,'127.0.0.1');
  const port=(s:typeof gw.uiServer)=>(s.address() as {port:number}).port;
  const ui=`http://127.0.0.1:${port(gw.uiServer)}`;
  const api=`http://127.0.0.1:${port(gw.apiServer)}`;
  const headers:Record<string,string>={'X-Ingress-Path':'/api/hassio_ingress/test'};
  assert.equal((await fetch(ui+'/')).status,403);
  const auth=await fetch(ui+'/api/auth/session',{headers});
  const data=await auth.json() as {csrfToken:string};headers.Cookie=auth.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(ui+'/api/accounts',{method:'POST',headers,body:'{"id":"alpha"}'})).status,403);
  assert.equal((await fetch(ui+'/api/openclaw',{method:'PUT',headers,body:'{}'})).status,403);
  headers['X-CSRF-Token']=data.csrfToken;headers['Content-Type']='application/json';
  for(const id of ['alpha','beta'])assert.equal((await fetch(ui+'/api/accounts',{method:'POST',headers,body:JSON.stringify({id})})).status,201);
  assert.equal((await fetch(api+'/api/v1/openclaw/status')).status,401);
  const bridgeSettings=await fetch(ui+'/api/openclaw',{headers});assert.equal(bridgeSettings.status,200);
  assert.equal((await bridgeSettings.json() as {token_configured:boolean}).token_configured,false);
  assert.equal((await fetch(ui+'/api/openclaw',{method:'PUT',headers,body:JSON.stringify({url:'http://mac.local:18790/v1/responses',token:'private-mac-token'})})).status,200);
  assert.ok(!(await (await fetch(ui+'/api/openclaw',{headers})).text()).includes('private-mac-token'));
  assert.equal((await fetch(ui+'/api/accounts/alpha/openclaw',{headers})).status,200);
  assert.equal((await fetch(ui+'/api/accounts/alpha/openclaw',{method:'PUT',headers,body:JSON.stringify({enabled:true,routes:[]})})).status,409);
  assert.equal((await fetch(ui+'/api/accounts',{method:'POST',headers,body:'{"id":"../escape"}'})).status,400);
  assert.equal((await fetch(api+'/api/v1/accounts')).status,401);
  const pair=await fetch(ui+'/accounts/alpha/api/pairing/status',{headers});assert.equal(pair.status,200);
  assert.deepEqual(await pair.json(),await (await fetch(ui+'/api/pairing/status',{headers})).json());
  const child=await fetch(ui+'/accounts/alpha/',{headers});assert.equal(child.status,200);assert.match(await child.text(),/app.js/);
  // Different persisted identities prove independent upstream gateway directories.
  const cfg=async(id:string)=>JSON.parse(await readFile(join(dir,'multi/accounts',id,'config.json'),'utf8'));
  assert.notEqual((await cfg('alpha')).instanceId,(await cfg('beta')).instanceId);
  await gw.stop();gw=await createMultiGateway(dir,{ingressTrust:()=>true});
  assert.deepEqual(gw.accountStatus().map(a=>a.id),['alpha','beta']);
  await gw.removeAccount('alpha');assert.deepEqual(gw.accountStatus().map(a=>a.id),['beta']);
 }finally{await gw.stop();await rm(dir,{recursive:true,force:true});}
});

test('normal startup reports ordered phases and occupied listeners release both servers', async () => {
 const listen=(server:http.Server)=>new Promise<number>((resolve,reject)=>{
   server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port));
 });
 const close=(server:http.Server)=>new Promise<void>(resolve=>server.close(()=>resolve()));
 const normalDir=await mkdtemp(join(tmpdir(),'multi-startup-phases-'));
 const phases:string[]=[];
 const normal=await createMultiGateway(normalDir,{onStartupPhase:phase=>phases.push(phase)});
 try {
   await normal.start(0,0,'127.0.0.1');
   assert.deepEqual(phases,['webhook','registry','control','accounts','bridge','api-listen','ui-listen']);
 } finally { await normal.stop();await rm(normalDir,{recursive:true,force:true}); }
 for (const which of ['api','ui'] as const) {
   const dir=await mkdtemp(join(tmpdir(),`multi-occupied-${which}-`));
   const occupied=http.createServer();const port=await listen(occupied);
   const gw=await createMultiGateway(dir);
   try {
     await assert.rejects(gw.start(which==='api'?port:0,which==='ui'?port:0,'127.0.0.1'),error=>{
       assert.equal((error as NodeJS.ErrnoException).code,'EADDRINUSE');return true;
     });
     assert.equal(gw.apiServer.listening,false);
     assert.equal(gw.uiServer.listening,false);
   } finally { await gw.stop();await close(occupied);await rm(dir,{recursive:true,force:true}); }
 }
});

test('bridge-load failure closes its opened database and preserves the original error when cleanup fails', async () => {
 const dir=await mkdtemp(join(tmpdir(),'multi-bridge-cleanup-'));
 const root=join(dir,'multi'), database=join(root,'openclaw.sqlite');
 await mkdir(root,{recursive:true});
 const setup=new DatabaseSync(database);
 setup.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, lane TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)');
 setup.prepare('INSERT INTO jobs(id,account,lane,state,body) VALUES(?,?,?,?,?)').run('bad','alpha','lane','ready','{not json');
 setup.close();
 const originalStop=OpenClawBridge.prototype.stop;
 let stopped=0, captured:OpenClawBridge|undefined;
 OpenClawBridge.prototype.stop=async function(this:OpenClawBridge){
   captured=this;stopped++;await originalStop.call(this);throw new Error('cleanup failure');
 };
 try {
   await assert.rejects(createMultiGateway(dir),error=>{
     assert.ok(error instanceof SyntaxError);return true;
   });
   assert.equal(stopped,1);
   assert.throws(()=>((captured as unknown as {db:DatabaseSync}).db.prepare('SELECT 1')),/not open|closed/i);
 } finally {
   OpenClawBridge.prototype.stop=originalStop;
   await rm(dir,{recursive:true,force:true});
 }
});
