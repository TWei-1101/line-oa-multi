import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { FamilyBridge } from '../src/family-bridge.js';
import { createFamilyBridgeServer } from '../src/family-bridge-server.js';
import { parseFamilyAnswer } from '../src/openclaw.js';
const token='synthetic-bridge-token',group='C'+'a'.repeat(32),other='C'+'b'.repeat(32);
const dto={version:1,event_id:'event-test',group_id:group,text:'hello'};
const answer={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'safe'}]}]};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
for(const kind of ['stream-cap','declared-cap','utf8','json'])test('bounded upstream '+kind+' rejects and never replays intent',async()=>{
 let cancelled=false,calls=0;
 const bridge=new FamilyBridge({token,groups:[group],fetch:async()=>{calls++;const bytes=kind==='utf8'?new Uint8Array([0xc3,0x28]):new TextEncoder().encode(kind==='json'?'{':'x'.repeat(65537));return new Response(new ReadableStream({start(c){c.enqueue(bytes);if(kind==='utf8'||kind==='json')c.close();},cancel(){cancelled=true;}}),kind==='declared-cap'?{headers:{'content-length':'65537'}}:{});}});
 await assert.rejects(()=>bridge.dispatch(dto,token),kind.includes('cap')?/FAMILY_UPSTREAM_TOO_LARGE/:/FAMILY_UPSTREAM_MALFORMED/);
 if(kind.includes('cap'))assert.equal(cancelled,true);
 await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_EVENT_HELD/);assert.equal(calls,1);bridge.close();
});
test('loopback URL rejects embedded credentials and command filtering has no mention length bypass',async()=>{
 assert.throws(()=>new FamilyBridge({token,groups:[group],upstream:'http://user:pass@127.0.0.1:18790/v1/responses'}),/FAMILY_UPSTREAM_CONFIGURATION/);
 let calls=0;const bridge=new FamilyBridge({token,groups:[group],fetch:async()=>{calls++;return Response.json(answer);}});
 for(const text of [' /config','@'+ 'a'.repeat(500)+' /config',' @bot  @other /reset','	@bot /status'])await assert.rejects(()=>bridge.dispatch({...dto,text},token),/FAMILY_COMMAND_REJECTED/);
 assert.equal(calls,0);bridge.close();await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_LEDGER_CLOSED/);
});
test('upstream abort timeout is held with no automatic redispatch',async()=>{
 let calls=0;const bridge=new FamilyBridge({token,groups:[group],upstreamTimeoutMs:20,fetch:async(_u:unknown,init:RequestInit)=>{calls++;return new Promise<Response>((_r,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));}} as any);
 // A referenced timer keeps the synthetic fetch alive, not a polling sleep.
 const keep=setTimeout(()=>{},1000);try{await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_UPSTREAM_UNCERTAIN/);await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_EVENT_HELD/);assert.equal(calls,1);}finally{clearTimeout(keep);bridge.close();}
});
test('ledger storage failures before dispatch and after answer are closed; same-group serializes, global bound and cached HA parser agree',async()=>{
 const root=await mkdtemp(tmpdir()+'/family-storage-');let calls=0;const entered=deferred(),release=deferred();
 const path=root+'/ledger.sqlite';const bridge=new FamilyBridge({token,groups:[group,other],ledgerPath:path,fetch:async()=>{calls++;entered.resolve();await release.promise;return Response.json(answer);}});
 const db=new DatabaseSync(path);
 try{
  db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON family_ledger BEGIN SELECT RAISE(ABORT,'storage'); END");
  await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_LEDGER_FAILURE/);assert.equal(calls,0);db.exec('DROP TRIGGER fail_intent');
  const active=bridge.dispatch(dto,token);await entered.promise;
  await assert.rejects(()=>bridge.dispatch({...dto,event_id:'same-group'},token),/FAMILY_BUSY/);
  await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_EVENT_HELD/);
  db.exec("CREATE TRIGGER fail_complete BEFORE UPDATE ON family_ledger BEGIN SELECT RAISE(ABORT,'storage'); END");release.resolve();await assert.rejects(()=>active,/FAMILY_LEDGER_FAILURE/);
  db.exec('DROP TRIGGER fail_complete');await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_EVENT_HELD/);
  const result=await bridge.dispatch({...dto,event_id:'completed',group_id:other},token);assert.deepEqual(parseFamilyAnswer(result),[{type:'text',text:'safe'}]);
  const cached=await bridge.dispatch({text:'hello',group_id:other,event_id:'completed',version:1},token);assert.deepEqual(parseFamilyAnswer(cached),parseFamilyAnswer(result));assert.equal(calls,2);
 }finally{db.close();bridge.close();await rm(root,{recursive:true,force:true});}
});
function post(port:number,body:Buffer|string,headers:Record<string,string|string[]>={}){return new Promise<{status:number;body:string}>((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,path:'/v1/responses',method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end(body);});}
test('HTTP authenticates before body/quota, duplicate raw headers, fatal request UTF8, fake-time rate and request timeout',async()=>{
 const root=await mkdtemp(tmpdir()+'/family-limit-');let calls=0,now=100000;
 const server=createFamilyBridgeServer({token,groups:[group],ledgerPath:root+'/ledger.sqlite',now:()=>now,requestTimeoutMs:30,fetch:async()=>{calls++;return Response.json(answer);}} as any);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 try{
  for(let i=0;i<65;i++)assert.equal((await post(port,'{',{authorization:'Bearer wrong'})).status,401);
  assert.equal((await post(port,JSON.stringify(dto))).status,200);assert.equal(calls,1);
  assert.equal((await post(port,'{}',{'content-type':['application/json','application/json']})).status,400);
  assert.equal((await post(port,'{}',{authorization:['Bearer '+token,'Bearer '+token]})).status,400);
  const parts=JSON.stringify({...dto,event_id:'utf8',text:'INVALID_UTF8_HERE'}).split('INVALID_UTF8_HERE');const bad=Buffer.concat([Buffer.from(parts[0]),Buffer.from([0xc3,0x28]),Buffer.from(parts[1])]);assert.equal((await post(port,bad)).status,400);
  for(let i=0;i<59;i++)await post(port,'{}');assert.equal((await post(port,'{}')).status,429);now+=60000;assert.equal((await post(port,'{}')).status,400);
  // Auth headers sent without body: server must end/destroy within the configured test deadline.
  await new Promise<void>((resolve,reject)=>{const socket=connect(port,'127.0.0.1',()=>socket.write(['POST /v1/responses HTTP/1.1','Host: localhost','Authorization: Bearer '+token,'Content-Type: application/json','Content-Length: 100','',''].join(String.fromCharCode(13,10))));const deadline=setTimeout(()=>{socket.destroy();reject(Error('request timeout not enforced'));},1000);socket.on('data',()=>{});socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(deadline);resolve();});});
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});

test('real process crash after durable intent remains held after restart',async()=>{
 const {spawn}=await import('node:child_process');
 const root=await mkdtemp(tmpdir()+'/family-crash-'),path=root+'/ledger.sqlite';
 const moduleURL=new URL('../src/family-bridge.js',import.meta.url).href;
 const script="const {FamilyBridge}=await import("+JSON.stringify(moduleURL)+");const b=new FamilyBridge({token:"+JSON.stringify(token)+",groups:["+JSON.stringify(group)+"],ledgerPath:"+JSON.stringify(path)+",fetch:async()=>{process.stdout.write('intent\\n');setInterval(()=>{},1000);return new Promise(()=>{});}});await b.dispatch("+JSON.stringify(dto)+","+JSON.stringify(token)+");";
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),2000);
 try{
  await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const bridge=new FamilyBridge({token,groups:[group],ledgerPath:path,fetch:async()=>{throw Error('must not run');}});
  await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_EVENT_HELD/);bridge.close();
 }finally{clearTimeout(deadline);child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
test('bounded global work and per-group session routing are constructed server-side',async()=>{
 const groups=Array.from({length:9},(_,i)=>'C'+i.toString(16).padStart(32,'0'));const release=deferred();const sessions:string[]=[];
 const bridge=new FamilyBridge({token,groups,upstreamToken:'synthetic-upstream-secret',fetch:async(_url,init)=>{
  const h=new Headers(init?.headers),b=JSON.parse(String(init?.body));assert.equal(h.get('authorization'),'Bearer synthetic-upstream-secret');assert.equal(h.get('x-openclaw-agent-id'),'family-line');assert.equal(h.get('x-openclaw-session-key'),b.user);assert.equal(init?.redirect,'error');assert.equal(b.input[0].content[0].text,'hello');sessions.push(b.user);await release.promise;return Response.json(answer);
 }});
 const tasks=groups.slice(0,8).map((g,i)=>bridge.dispatch({...dto,event_id:'work-'+i,group_id:g},token));
 await assert.rejects(()=>bridge.dispatch({...dto,event_id:'overflow',group_id:groups[8]},token),/FAMILY_BUSY/);assert.equal(new Set(sessions).size,8);release.resolve();await Promise.all(tasks);bridge.close();
});
test('cached adapter HTTP result feeds actual HA worker and sends once without regenerating',async()=>{
 const {OpenClawBridge}=await import('../src/openclaw.js');const root=await mkdtemp(tmpdir()+'/family-cache-ha-');let generations=0,sends=0;
 const server=createFamilyBridgeServer({token,groups:[group],ledgerPath:root+'/ledger.sqlite',fetch:async()=>{generations++;return Response.json(answer);}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port,url='http://127.0.0.1:'+port+'/v1/responses';
 const bridge=new OpenClawBridge(root+'/ha',{boundDestination:()=> 'U'+'b'.repeat(32),sender:()=>({send:async(_who,text,expected)=>{assert.equal(text,'safe');assert.equal(expected,'approved-oa-chat');sends++;return {result:'SUBMITTED',sendId:'x'};},sendImage:async()=>{throw Error('no image');}}),hasAlias:()=>true,resolveAlias:()=> 'approved-oa-chat'});
 try{
  const request={...dto,text:'hello @bot'};
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(request)})).status,200);
  await bridge.load();const destination='U'+'b'.repeat(32);
  bridge.configure({enabled:true,expected_destination:destination,admission:'self-mention-group-text',endpoint:{mode:'override',url,token,agent:'family-line',timeout_seconds:30,protocol:'family-text-v1'},routes:[{source_type:'group',source_id:group,who:'family'}]},'family');
  bridge.enqueue([{sequence:1,account:'family',webhook_event_id:dto.event_id,type:'message',source_type:'group',group_id:group,message_type:'text',text:request.text,destination,mentions:[{index:6,length:4,type:'user',isSelf:true}],is_redelivery:false}]);
  await bridge.tick();assert.equal(generations,1);assert.equal(sends,1);assert.equal(bridge.status().counts.submitted,1);
 }finally{await bridge.stop();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});

test('corrupt durable completion fails closed instead of returning unbounded cached text',async()=>{
 const root=await mkdtemp(tmpdir()+'/family-ledger-corrupt-'),path=root+'/ledger.sqlite';let calls=0;
 const bridge=new FamilyBridge({token,groups:[group],ledgerPath:path,fetch:async()=>{calls++;return Response.json(answer);}});
 try{await bridge.dispatch(dto,token);const db=new DatabaseSync(path);db.prepare('UPDATE family_ledger SET text=?').run('x'.repeat(5001));db.close();await assert.rejects(()=>bridge.dispatch(dto,token),/FAMILY_LEDGER_FAILURE/);assert.equal(calls,1);}finally{bridge.close();await rm(root,{recursive:true,force:true});}
});

test('mention-prefixed URLs remain inert text, while multiline and spaced display-name commands reject',async()=>{
 let calls=0;const text='@Family Bot https://example.invalid/path';const bridge=new FamilyBridge({token,groups:[group],fetch:async(url,init)=>{calls++;assert.equal(String(url),'http://127.0.0.1:18790/v1/responses');assert.equal(JSON.parse(String(init?.body)).input[0].content[0].text,text);return Response.json(answer);}});
 try{await bridge.dispatch({...dto,text},token);for(const input of ['@Family Bot /config','@bot\n/config','@'+'name '.repeat(100)+'/reset'])await assert.rejects(()=>bridge.dispatch({...dto,event_id:'command-rejected',text:input},token),/FAMILY_COMMAND_REJECTED/);assert.equal(calls,1);}finally{bridge.close();}
});
