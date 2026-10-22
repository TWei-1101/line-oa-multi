import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os';
import { FamilyBridge, FamilyBridgeError } from '../src/family-bridge.js';
import { createFamilyBridgeServer } from '../src/family-bridge-server.js';
const group='C'+'a'.repeat(32), token='bridge-token', request={version:1 as const,event_id:'event-1',group_id:group,text:'hello'};
const upstream={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'safe'}]}]};
test('durable ledger holds uncertain dispatch after restart and caches completed text',async()=>{
 const root=await mkdtemp(tmpdir()+'/family-ledger-'), path=root+'/ledger.sqlite';
 try { const uncertain=new FamilyBridge({token,groups:[group],ledgerPath:path,fetch:async()=>{throw Error('lost');}}); await assert.rejects(()=>uncertain.dispatch(request,token),FamilyBridgeError); uncertain.close();
 const held=new FamilyBridge({token,groups:[group],ledgerPath:path,fetch:async()=>Response.json(upstream)}); await assert.rejects(()=>held.dispatch(request,token),/FAMILY_EVENT_HELD/); held.close();
 const done=new FamilyBridge({token,groups:[group],ledgerPath:root+'/done.sqlite',fetch:async()=>Response.json(upstream)}); assert.equal((await done.dispatch(request,token)).text,'safe'); done.close();
 const cached=new FamilyBridge({token,groups:[group],ledgerPath:root+'/done.sqlite',fetch:async()=>{throw Error('must not call');}}); assert.deepEqual(await cached.dispatch(request,token),{text:'safe'}); cached.close();
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('HTTP entrypoint validates auth, path, headers and body before upstream',async()=>{
 const root=await mkdtemp(tmpdir()+'/family-http-'); let calls=0;
 const server=createFamilyBridgeServer({token,groups:[group],ledgerPath:root+'/ledger.sqlite',fetch:async()=>{calls++;return Response.json(upstream);}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); const port=(server.address() as {port:number}).port, url='http://127.0.0.1:'+port+'/v1/responses';
 try { let r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(r.status,401);
 r=await fetch(url,{method:'POST',headers:{authorization:'Bearer bad','content-type':'application/json'},body:'{'});assert.equal(r.status,401);
 r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'text/plain'},body:JSON.stringify(request)});assert.equal(r.status,415);
 r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-openclaw-agent-id':'main'},body:JSON.stringify(request)});assert.equal(r.status,400);
 r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...request,tools:[]})});assert.equal(r.status,400);assert.equal(calls,0);
 r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(r.status,200);assert.deepEqual(await r.json(),{text:'safe'});
 r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({text:request.text,group_id:request.group_id,event_id:request.event_id,version:1})});assert.deepEqual(await r.json(),{text:'safe'});assert.equal(calls,1);
 } finally { await new Promise<void>(r=>server.close(()=>r())); await rm(root,{recursive:true,force:true}); }
});
