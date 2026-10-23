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
    assert.equal(result.token,'b'.repeat(48));assert.equal(result.upstreamToken,'g'.repeat(48));assert.deepEqual(result.groups,['C'+'a'.repeat(32)]);
    for(const p of [bridgeTokenFile,upstreamTokenFile,groupsFile]){chmodSync(p,0o644);assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);chmodSync(p,0o600);}
    symlinkSync(bridgeTokenFile,join(d,'link'));assert.throws(()=>loaded.readFamilyBridgeFiles({...options,bridgeTokenFile:join(d,'link')}),/FAMILY_FILE_CONFIG/);
    for(const upstream of ['http://192.168.68.241:19789/v1/responses','http://127.0.0.1:18789/v1/responses','http://127.0.0.1:19789/v1/responses?x=1'])assert.throws(()=>loaded.readFamilyBridgeFiles({...options,upstream}),/FAMILY_FILE_CONFIG/);
    for(const groups of ['', '*', 'C'+'a'.repeat(32)+'\nC'+'a'.repeat(32)]){writeFileSync(groupsFile,groups);assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);}
    writeFileSync(groupsFile,'C'+'a'.repeat(32));writeFileSync(bridgeTokenFile,'bad\nsecret');assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);
    writeFileSync(bridgeTokenFile,'b'.repeat(48));chmodSync(d,0o777);assert.throws(()=>loaded.readFamilyBridgeFiles(options),/FAMILY_FILE_CONFIG/);
  } finally {rmSync(d,{recursive:true,force:true});}
});
