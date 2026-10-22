/** Repository-controlled startup/rollback interlock, not protection against manual bypass. */
import { DatabaseSync } from 'node:sqlite';
import { storedSnapshotValid } from '../src/openclaw.js';
export type CandidateCapability={familyAware:boolean};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function evaluateDowngrade(path:string,candidate:CandidateCapability):void {
 const db=new DatabaseSync(path,{readOnly:true});
 try {
  const cfg=db.prepare('SELECT body FROM config WHERE id=1').get() as {body:string}|undefined;
  let config:unknown;try{config=cfg?JSON.parse(cfg.body):{accounts:{}};}catch{throw Error('DOWNGRADE_BLOCKED_CONFIG');}
  if(!object(config)||!object(config.accounts))throw Error('DOWNGRADE_BLOCKED_CONFIG');
  const family=config.accounts.family;
  const familyConfigured=object(family)&&(family.enabled===true||(object(family.endpoint)&&family.endpoint.protocol==='family-text-v1'));
  const rows=db.prepare('SELECT account,state,body FROM jobs').all() as {account:string;state:string;body:string}[];
  let incompatible=false;
  for(const row of rows){
   let job:unknown;try{job=JSON.parse(row.body);}catch{throw Error('DOWNGRADE_BLOCKED_MALFORMED_STATE');}
   if(!object(job)||job.state!==row.state||job.account!==row.account||!['pending','generating','ready','sending','submitted','unknown','failed','ignored'].includes(row.state))throw Error('DOWNGRADE_BLOCKED_MALFORMED_STATE');
   if(['submitted','ignored'].includes(row.state))continue;
   if(job.snapshot!==undefined&&!storedSnapshotValid(job))throw Error('DOWNGRADE_BLOCKED_UNKNOWN_OR_MALFORMED_SNAPSHOT');
   // Family unsnapshotted work is incompatible even if config was disabled/removed.
   // Forward startup may load it only into a controlled manual-review hold.
   if(row.account==='family'||job.snapshot!==undefined)incompatible=true;
  }
  if(!candidate.familyAware&&(familyConfigured||incompatible))throw Error('DOWNGRADE_BLOCKED_FAMILY_STATE');
 } catch(e) {if(e instanceof Error&&e.message.startsWith('DOWNGRADE_BLOCKED'))throw e;throw Error('DOWNGRADE_BLOCKED_STORAGE_OR_SCHEMA');}
 finally{db.close();}
}
const [path,...flags]=process.argv.slice(2);
if(import.meta.url===new URL(process.argv[1]??'', 'file:').href){if(!path)throw Error('USAGE: family-downgrade-preflight SQLITE_PATH [--family-aware]');evaluateDowngrade(path,{familyAware:flags.includes('--family-aware')});}
