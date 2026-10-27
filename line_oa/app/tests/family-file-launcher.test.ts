import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('file launcher validates protected credentials, exact groups and local upstream',async()=>{
  const modulePath='../src/family-file-launcher.js';
  const loaded=await import(modulePath).catch(()=>null);
  assert.ok(loaded,'file-reading launcher must exist');
  const d=mkdtempSync(join(tmpdir(),'family-files-')); chmodSync(d,0o700);
  const put=(n:string,s:string)=>{const p=join(d,n);writeFileSync(p,s,{mode:0o600});return p;};
  const bridgeTokenFile=put('bridge','b'.repeat(48)),upstreamTokenFile=put('gateway','g'.repeat(48)),groupsFile=put('groups','C'+'a'.repeat(32)+'\n');
  const options={bridgeTokenFile,upstreamTokenFile,groupsFile,ledgerPath:join(d,'ledger.sqlite'),upstream:'http://127.0.0.1:19789/v1/responses'};
  try {
    const result=loaded.readFamilyBridgeFiles(options);
    assert.equal(result.upstreamTimeoutMs,30_000);
    assert.equal(loaded.readFamilyBridgeFiles({...options,upstreamTimeoutMs:270_000}).upstreamTimeoutMs,270_000);
    for(const upstreamTimeoutMs of [0,-1,1.5,NaN,Infinity,270_001,'270000',null]) assert.throws(()=>loaded.readFamilyBridgeFiles({...options,upstreamTimeoutMs}),/FAMILY_FILE_CONFIG/);
    assert.equal(result.token,'b'.repeat(48));assert.equal(result.upstreamToken,'g'.repeat(48));assert.deepEqual(result.groups,['C'+'a'.repeat(32)]);
    for(const p of [bridgeTokenFile,upstreamTokenFile,groupsFile]){chmodSync(p,0o644);assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);chmodSync(p,0o600);}
    symlinkSync(bridgeTokenFile,join(d,'link'));assert.throws(()=>loaded.readFamilyBridgeFiles({...options,bridgeTokenFile:join(d,'link')}),/FAMILY_FILE_CONFIG/);
    for(const upstream of ['http://192.168.68.241:19789/v1/responses','http://127.0.0.1:18789/v1/responses','http://127.0.0.1:19789/v1/responses?x=1'])assert.throws(()=>loaded.readFamilyBridgeFiles({...options,upstream}),/FAMILY_FILE_CONFIG/);
    for(const groups of ['', '*', 'C'+'a'.repeat(32)+'\nC'+'a'.repeat(32)]){writeFileSync(groupsFile,groups);assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);}
    writeFileSync(groupsFile,'C'+'a'.repeat(32));writeFileSync(bridgeTokenFile,'bad\nsecret');assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);
    writeFileSync(bridgeTokenFile,'b'.repeat(48));chmodSync(d,0o777);assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);
  } finally {rmSync(d,{recursive:true,force:true});}
});

test('configured launcher deadline permits a 45s turn and timeout still holds its durable event',async(t)=>{
  const {readFamilyBridgeFiles}=await import('../src/family-file-launcher.js');
  const {FamilyBridge}=await import('../src/family-bridge.js');
  const {DatabaseSync}=await import('node:sqlite');
  const d=mkdtempSync(join(tmpdir(),'family-deadline-'));chmodSync(d,0o700);
  const put=(n:string,s:string)=>{const p=join(d,n);writeFileSync(p,s,{mode:0o600});return p;};
  const group='C'+'a'.repeat(32),token='b'.repeat(48);
  const files={bridgeTokenFile:put('bridge',token),upstreamTokenFile:put('gateway','g'.repeat(48)),groupsFile:put('groups',group),ledgerPath:join(d,'ledger.sqlite'),upstream:'http://127.0.0.1:19789/v1/responses',upstreamTimeoutMs:270_000};
  let calls=0;
  // Virtual deadline: advancing elapsed time avoids live models and a 45-second wall-clock wait.
  let elapsed=45_000;
  const deadlines:number[]=[];
  const signals:AbortController[]=[];
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{deadlines.push(ms);const c=new AbortController();signals.push(c);return c.signal;});
  const bridge=new FamilyBridge({...readFamilyBridgeFiles(files),fetch:async(_url,init)=>{
    calls++;assert.ok(init?.signal);
    if(elapsed>=deadlines.at(-1)!){signals.at(-1)!.abort();throw init.signal.reason;}
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'local mock reply'}]}]});
  }});
  try{
    const request={version:1,event_id:'deadline-success',group_id:group,text:'local only'};
    assert.deepEqual(await bridge.dispatch(request,token),{text:'local mock reply'});
    assert.equal(deadlines[0],270_000);
    elapsed=270_001;
    const failed={...request,event_id:'deadline-held'};
    await assert.rejects(bridge.dispatch(failed,token),(e:unknown)=>{const x=e as {code:string;status:number};return x.code==='FAMILY_UPSTREAM_UNCERTAIN'&&x.status===503;});
    await assert.rejects(bridge.dispatch(failed,token),(e:unknown)=>(e as {code:string}).code==='FAMILY_EVENT_HELD');
    assert.equal(calls,2);
    const db=new DatabaseSync(files.ledgerPath,{readOnly:true});
    try{assert.equal(db.prepare("SELECT state FROM family_ledger WHERE event_id='deadline-held'").get()!.state,'dispatching');}finally{db.close();}
  }finally{bridge.close();rmSync(d,{recursive:true,force:true});}
});

test('deployed file entrypoint explicitly opts into the bounded 270s deadline',()=>{
  const entry=new URL('../scripts/family-bridge-files.js',import.meta.url);
  return import('node:fs').then(({readFileSync})=>assert.match(readFileSync(entry,'utf8'),/upstreamTimeoutMs:\s*270_000|upstreamTimeoutMs:\s*270000/));
});

test('real abort timer returns uncertain and prevents automatic event replay',async()=>{
  const {FamilyBridge}=await import('../src/family-bridge.js');
  const group='C'+'a'.repeat(32),token='local-test';let calls=0;
  const bridge=new FamilyBridge({token,groups:[group],upstreamTimeoutMs:10,fetch:async(_url,init)=>{
    calls++;return new Promise<Response>((_resolve,reject)=>{const signal=init!.signal!;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }});
  const keepAlive=setTimeout(()=>{},1000);
  try{
    const request={version:1,event_id:'real-timeout',group_id:group,text:'local only'};
    await assert.rejects(bridge.dispatch(request,token),(e:unknown)=>(e as {code:string}).code==='FAMILY_UPSTREAM_UNCERTAIN');
    await assert.rejects(bridge.dispatch(request,token),(e:unknown)=>(e as {code:string}).code==='FAMILY_EVENT_HELD');
    assert.equal(calls,1);
  }finally{clearTimeout(keepAlive);bridge.close();}
});
