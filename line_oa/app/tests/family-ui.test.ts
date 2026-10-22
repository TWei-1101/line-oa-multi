import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { MultiWebhook } from '../src/webhook.js';
import { createContext,runInContext } from 'node:vm';
import { createMultiGateway } from '../src/multi-server.js';
class Element {
 children:Element[]=[];listeners:Record<string,Function[]>={};textContent='';value='';checked=false;disabled=false;type='';id='';open=false;onclick?:Function;parent?:Element;
 constructor(public tag:string){}
 append(...nodes:Element[]){for(const n of nodes){n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes:Element[]){this.children=[];this.append(...nodes);}
 setAttribute(){} remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
 addEventListener(name:string,fn:Function){(this.listeners[name]??=[]).push(fn);}
 showModal(){this.open=true;} close(){this.open=false;}
 async fire(name:string){const e={preventDefault(){},submitter:new Element('button')};for(const fn of this.listeners[name]??[])await fn(e);if(name==='click')await this.onclick?.(e);}
 all():Element[]{return [this,...this.children.flatMap(x=>x.all())];}
}
test('staged UI uses real handlers and authenticated HTTP: own token, binding, inherit, errors, enable-disable-pause and scoped alias guards',async()=>{
 const root=await mkdtemp(tmpdir()+'/family-dom-');let gw=await createMultiGateway(root,{ingressTrust:()=>true});
 try{
  await gw.start(0,0,'127.0.0.1');let base='http://127.0.0.1:'+(gw.uiServer.address() as any).port;
  let r=await fetch(base+'/api/auth/session',{headers:{'X-Ingress-Path':'/api/hassio_ingress/test'}});let auth=await r.json() as any;
  let headers:Record<string,string>={'X-Ingress-Path':'/api/hassio_ingress/test',Cookie:r.headers.get('set-cookie')!.split(';')[0]!,'X-CSRF-Token':auth.csrfToken,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/accounts',{method:'POST',headers,body:'{"id":"family"}'})).status,201);
  assert.equal((await fetch(base+'/api/accounts/family/webhook',{method:'PUT',headers,body:JSON.stringify({enabled:true,channel_secret:'s'.repeat(32)})})).status,200);
  const premature=await fetch(base+'/api/accounts/family/openclaw',{method:'PUT',headers,body:JSON.stringify({enabled:true,expected_destination:'U'+'b'.repeat(32),admission:'self-mention-group-text',endpoint:{mode:'override',url:'http://family.local/v1/responses',token:'synthetic-own-token',agent:'family-line',timeout_seconds:30,protocol:'family-text-v1'},routes:[{source_type:'group',source_id:'C'+'a'.repeat(32),who:'family_group'}]})});assert.equal(premature.status,409);assert.match(await premature.text(),/FAMILY_SIGNED_BINDING_REQUIRED/);
  await gw.stop();const hook=new MultiWebhook(root+'/multi');await hook.load();await hook.set('family',true,'s'.repeat(32));const binding=Buffer.from(JSON.stringify({destination:'U'+'b'.repeat(32),events:[]}));await hook.receive(binding,createHmac('sha256','s'.repeat(32)).update(binding).digest('base64'));
  await writeFile(root+'/multi/accounts/family/aliases.json',JSON.stringify({family_group:{chatId:'oa-chat-approved',name:'family'},free_alias:{chatId:'oa-chat-freealias',name:'free'}}));
  gw=await createMultiGateway(root,{ingressTrust:()=>true});await gw.start(0,0,'127.0.0.1');base='http://127.0.0.1:'+(gw.uiServer.address() as any).port;
  r=await fetch(base+'/api/auth/session',{headers:{'X-Ingress-Path':'/api/hassio_ingress/test'}});auth=await r.json();headers={...headers,Cookie:r.headers.get('set-cookie')!.split(';')[0]!,'X-CSRF-Token':auth.csrfToken};
  const api=async(path:string,body?:unknown,method='PUT')=>fetch(base+path,{method:body===undefined?'GET':method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await api('/api/accounts/family/webhook',{enabled:true,channel_secret:'s'.repeat(32)})).status,200);
  const ids=new Map<string,Element>();const el=(id:string)=>{if(!ids.has(id))ids.set(id,new Element('div'));return ids.get(id)!;};
  const writes:any[]=[];
  const context=createContext({document:{getElementById:el,createElement:(tag:string)=>new Element(tag)},confirm:()=>true,prompt:()=>null,console,
   fetch:async(path:string,opts:any={})=>{if(opts.body)writes.push({path,body:JSON.parse(opts.body)});return fetch(base+'/'+(path.startsWith('/')?path.slice(1):path),{...opts,headers:{...headers,...opts.headers}});}});
  const source=await readFile(process.cwd()+'/web/multi.js','utf8');runInContext(source.replace('void boot();','globalThis.bootPromise=boot();'),context);await runInContext('bootPromise',context);
  const open=async()=>{await runInContext("openAccountBridge('family')",context);};
  const input=(label:string)=>{const node=el('claw-fields').all().find(n=>n.textContent.startsWith(label));assert.ok(node,'missing UI control '+label);return node!.children[0]!;};
  const save=()=>el('claw-form').fire('submit');
  await open();input('使用 Family').checked=true;input('Family API').value='http://family.local/v1/responses';input('Family Bridge Token').value='synthetic-own-token';input('預期 Family Bot').value='U'+'b'.repeat(32);
  const selects=el('claw-fields').all().filter(n=>n.tag==='select');selects.at(-1)!.value='self-mention-group-text';
  // Add an approved route through the real DOM button/row handlers.
  await el('claw-fields').all().find(n=>n.textContent==='新增來源綁定')!.fire('click');
  const row=el('claw-fields').all().find(n=>(n as any).readRoute)!;const routeSelect=row.all().filter(n=>n.tag==='select');routeSelect[0].value='group';routeSelect[1].value='family_group';row.all().find(n=>n.textContent==='LINE Webhook 來源 ID')!.children[0].value='C'+'a'.repeat(32);
  await save();assert.equal(el('claw-error').textContent,'');
  await open();assert.equal(input('Family Bridge Token').value,'');input('啟用自動回覆').checked=true;await save();assert.equal(el('claw-error').textContent,'');
  const last=writes.filter(w=>w.path.endsWith('/openclaw')).at(-1);assert.equal(last.body.endpoint.token,undefined);assert.equal(last.body.expected_destination,'U'+'b'.repeat(32));
  let status=await (await api('/api/accounts/family/openclaw')).json() as any;assert.equal(status.accounts.family.enabled,true);assert.ok(!JSON.stringify(status).includes('synthetic-own-token'));
  await open();input('使用 Family').checked=false;await save();assert.match(el('claw-error').textContent,/FAMILY_CONFIGURATION_REQUIRED/);assert.equal(el('claw-dialog').open,true);
  input('啟用自動回覆').checked=false;await save();status=await (await api('/api/accounts/family/openclaw')).json();assert.equal(status.accounts.family.endpoint.mode,'inherit');
  await open();const pause=el('claw-fields').all().find(n=>n.textContent==='暫停並排空 Worker');assert.ok(pause);await pause!.fire('click');status=await (await api('/api/openclaw')).json();assert.equal(status.paused,true);
  const resume=el('claw-fields').all().find(n=>n.textContent==='繼續 Worker');assert.ok(resume);await resume!.fire('click');await api('/api/openclaw/worker',{action:'pause'},'POST');
  // Real HTTP mutation routes, scoped by account+alias, include failed/uncertain jobs.
  const db=new DatabaseSync(root+'/multi/openclaw.sqlite');const job={id:'j',account:'family',who:'family_group',state:'unknown',outputs:[],event:{},lane:'group:x'};db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('j','family','group:x','unknown',JSON.stringify(job));db.close();
  for(const method of ['PUT','DELETE']){const path='/accounts/family/api/aliases'+(method==='DELETE'?'/family_group':'');const r=await api(path,method==='PUT'?{alias:'family_group',chatId:'replacement-chat'}:{},method);assert.equal(r.status,409);assert.match(await r.text(),/OPENCLAW_JOBS_PENDING/);}
  assert.equal((await api('/accounts/family/api/aliases/free_alias',{},'DELETE')).status,200);
  const arbitrary=await api('/accounts/family/api/messages/send',{target:'oa-chat-approved',chatId:'replacement',message:'must not send'},'POST');assert.notEqual(arbitrary.status,202);assert.match(await arbitrary.text(),/TARGET_NOT_ALLOWED/);
  assert.ok(!el('claw-fields').all().some(n=>n.value==='synthetic-own-token'));
 }finally{await gw.stop();await rm(root,{recursive:true,force:true});}
});
