import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { evaluateDowngrade } from '../scripts/family-downgrade-preflight.js';
test('downgrade preflight blocks legacy candidate for family config or nonterminal versioned work',async()=>{const root=await mkdtemp(join(tmpdir(),'family-down-')),path=join(root,'openclaw.sqlite');try{const db=new DatabaseSync(path);db.exec('CREATE TABLE config (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE jobs (id TEXT PRIMARY KEY, account TEXT, lane TEXT, state TEXT, body TEXT NOT NULL)');db.prepare('INSERT INTO config VALUES(1,?)').run(JSON.stringify({accounts:{family:{enabled:true}}}));db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('x','family','group:x','pending',JSON.stringify({account:'family',state:'pending',who:'family',lane:'group:C'+'a'.repeat(32),recipient:'oa-chat-approved',credential_revision:1,next:0,outputs:[],event:{account:'family',source_type:'group',group_id:'C'+'a'.repeat(32),destination:'U'+'b'.repeat(32),message_type:'text',text:'@bot',mentions:[{index:0,length:4,type:'user',isSelf:true}]},snapshot:{version:1,url:'http://127.0.0.1:1/v1/responses',agent:'family-line',timeout_seconds:30,protocol:'family-text-v1',admission:'self-mention-group-text',session_policy:'family-group-v1',session_key:'line-family:v1:family:'+createHash('sha256').update('C'+'a'.repeat(32)).digest('hex'),expected_destination:'U'+'b'.repeat(32)}}));db.close();assert.throws(()=>evaluateDowngrade(path,{familyAware:false}),/DOWNGRADE_BLOCKED/);assert.doesNotThrow(()=>evaluateDowngrade(path,{familyAware:true}));}finally{await rm(root,{recursive:true,force:true});}});

test('actual controlled CLI gates REAL multi/openclaw.sqlite before spawn and legacy candidate remains blocked',async()=>{
 const {spawnSync}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'family-cli-')),path=join(root,'multi','openclaw.sqlite'),guard=join(root,'no-spawn.mjs');
 await mkdir(join(root,'multi'));
 await writeFile(guard,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw Error('TEST_SPAWN_REACHED');};syncBuiltinESMExports();`);
 try{
  const db=new DatabaseSync(path);db.exec('CREATE TABLE config(id INTEGER PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE jobs(id TEXT PRIMARY KEY,account TEXT,lane TEXT,state TEXT,body TEXT NOT NULL)');db.prepare('INSERT INTO config VALUES(1,?)').run('{"accounts":{}}');
  for(const body of [JSON.stringify({state:'pending',account:'family',snapshot:{version:99}}),JSON.stringify({state:'pending',account:'family',snapshot:{version:1,protocol:'garbage'}}),'{',JSON.stringify({state:'submitted',account:'family',snapshot:{version:1}})]){
   db.exec('DELETE FROM jobs');db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('job','family','group:x','pending',body);
   for(const script of ['dist/scripts/family-downgrade-preflight.js','dist/scripts/controlled-start.js']){
    const result=spawnSync(process.execPath,['--import',guard,script,...(script.includes('preflight')?[path]:[])],{cwd:process.cwd(),env:{...process.env,DATA_DIR:root},encoding:'utf8',timeout:1000});
    assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stderr,/DOWNGRADE_BLOCKED/);assert.doesNotMatch(result.stderr,/Error: TEST_SPAWN_REACHED/);
   }
  }
  db.exec('DELETE FROM jobs');db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('legacy-family','family','group:x','pending',JSON.stringify({account:'family',state:'pending'}));
  const result=spawnSync(process.execPath,['dist/scripts/family-downgrade-preflight.js',path],{encoding:'utf8',timeout:1000});assert.notEqual(result.status,0);assert.match(result.stderr,/DOWNGRADE_BLOCKED/);
  db.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('actual controlled CLI default DATA_DIR and empty DATA_DIR match runtime /data/multi layout without accessing it',async()=>{
 const {spawnSync}=await import('node:child_process');const root=await mkdtemp(join(tmpdir(),'family-default-path-')),guard=join(root,'path-probe.mjs');
 try{
  // Intercept before any /data filesystem read and forbid child launch in both red and green runs.
  await writeFile(guard,"import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';fs.existsSync=path=>{process.stderr.write('DB_PATH:'+String(path)+'\\n');throw Error('TEST_DEFAULT_PATH_PROBE_STOP');};cp.spawn=()=>{throw Error('TEST_SPAWN_REACHED');};syncBuiltinESMExports();");
  for(const empty of [false,true]){
   const env={...process.env};if(empty)env.DATA_DIR='';else delete env.DATA_DIR;
   const result=spawnSync(process.execPath,['--import',guard,'dist/scripts/controlled-start.js'],{cwd:process.cwd(),env,encoding:'utf8',timeout:1000});
   assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stderr,/DB_PATH:\/data\/multi\/openclaw\.sqlite/);assert.match(result.stderr,/TEST_DEFAULT_PATH_PROBE_STOP/);assert.doesNotMatch(result.stderr,/Error: TEST_SPAWN_REACHED/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
