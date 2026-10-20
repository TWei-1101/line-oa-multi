/**
 * Dynamic multi-account supervisor for the LINE OA Home Assistant Add-on.
 * One Node process, one Supervisor identity, independent SessionManager per account.
 * Security: no public administrative listener; Web UI reachable only via HA Ingress.
 * NOTE: LINE OA chat sender is unofficial. Do not treat as a reliable delivery channel.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGateway } from './server.js';
import { DATA_DIR, loadConfig } from './config.js';
import { readJsonSafe, atomicWriteJson, ensurePrivateDir } from './storage.js';
import { trustedIngress, ingressPath, ingressMutationAllowed } from './ingress.js';
import { parseRequestId, requestFingerprint, RequestDeduplicator, sendResponse } from './api-v1.js';
import { MultiWebhook, WebhookError } from './webhook.js';

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_ACCOUNTS = 20;
const MAX_JSON = 64 * 1024;
const MAX_MESSAGE = 5000;
type Gateway = Awaited<ReturnType<typeof createGateway>>;
type Account = { id: string; createdAt: string };
type Registry = { version: 1; accounts: Account[] };
const validRegistry = (value: unknown): value is Registry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !Array.isArray(v.accounts) || v.accounts.length > MAX_ACCOUNTS) return false;
  const accounts = v.accounts as unknown[];
  return accounts.every(item => item !== null && typeof item === 'object' && !Array.isArray(item) &&
    NAME.test((item as Account).id) && typeof (item as Account).createdAt === 'string' &&
    Number.isFinite(Date.parse((item as Account).createdAt))) &&
    new Set(accounts.map(item => (item as Account).id)).size === accounts.length;
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(body));
}
function error(res: ServerResponse, code: string, status = 400): void {
  reply(res,status,{error:{code,message:code}});
}
async function jsonBody(req: IncomingMessage): Promise<Record<string,unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('INVALID_JSON'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('INVALID_JSON');
  return data as Record<string,unknown>;
}

export async function createMultiGateway(dataDir = DATA_DIR, options: { ingressTrust?: typeof trustedIngress } = {}) {
  const rootDir = join(dataDir,'multi');
  const accountDir = join(rootDir,'accounts');
  const registryPath = join(rootDir,'accounts.json');
  const webhook = new MultiWebhook(rootDir);
  await webhook.load();
  await ensurePrivateDir(rootDir);
  await ensurePrivateDir(accountDir);
  const loaded = await readJsonSafe<Registry>(registryPath,{version:1,accounts:[]},validRegistry);
  if (loaded.warning) throw new Error('MULTI_ACCOUNT_REGISTRY_CORRUPT_RESTORE_BACKUP');
  let registry: Registry = loaded.value;
  const { config: controlConfig } = await loadConfig(join(rootDir,'control'));
  const control = await createGateway({dataDir:join(rootDir,'control'), ingressTrust:options.ingressTrust});
  const running = new Map<string, Gateway>();
  const dedup = new Map<string,RequestDeduplicator<{status:number;body:ReturnType<typeof sendResponse>}>>();
  let mutating = false;
  const active = new Map<Gateway, number>();
  const webDir = join(dirname(fileURLToPath(import.meta.url)),'..','..','web');

  const accountStatus = () => registry.accounts.map(({id,createdAt}) => {
    const state = running.get(id)?.sessions.getStatus();
    return {id,createdAt, account_name:state?.accountName??null,
      session_status:state?.state??'ERROR',logged_in:state?.state==='CONNECTED',
      webhook:webhook.status(id)};
  });

  async function loadAccount(id: string): Promise<Gateway> {
    if (!NAME.test(id)) throw new Error('INVALID_ACCOUNT');
    const instance = await createGateway({
      dataDir:join(accountDir,id),
      authManager:control.auth,
      disableDiscovery:true,
      ingressTrust:options.ingressTrust
    });
    instance.startEmbedded();
    return instance;
  }
  try {
    for (const {id} of registry.accounts) {
      running.set(id,await loadAccount(id));
      dedup.set(id,new RequestDeduplicator(60_000,256));
    }
  } catch (e) {
    for (const gateway of running.values()) await gateway.stop();
    await control.stop();
    throw e;
  }

  async function addAccount(id: string): Promise<void> {
    if (!NAME.test(id)) throw new Error('INVALID_ACCOUNT');
    if (registry.accounts.some(a=>a.id===id)) throw new Error('ACCOUNT_EXISTS');
    if (registry.accounts.length>=MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');
    const gw=await loadAccount(id);
    const next:Registry={version:1,accounts:[...registry.accounts,{id,createdAt:new Date().toISOString()}]};
    try { await atomicWriteJson(registryPath,next,0o600); }
    catch(e){ await gw.stop(); throw e; }
    registry=next;
    running.set(id,gw);
    dedup.set(id,new RequestDeduplicator(60_000,256));
  }
  async function removeAccount(id:string):Promise<void> {
    const gw=running.get(id);
    if (!gw) throw new Error('ACCOUNT_NOT_FOUND');
    if (gw.sender.isBusy() || active.get(gw)) throw new Error('ACCOUNT_SENDING');
    // Stop the session monitor before deleting on-disk state.
    await gw.stop();
    const next:Registry={version:1,accounts:registry.accounts.filter(a=>a.id!==id)};
    await atomicWriteJson(registryPath,next,0o600);
    registry=next;
    running.delete(id);
    dedup.delete(id);
    await webhook.remove(id);
    // Destructive by design: UI requires explicit confirmation.
    await rm(join(accountDir,id),{recursive:true,force:true});
  }

  function route(req:IncomingMessage,res:ServerResponse, gw:Gateway, kind:'ui'|'api', url:string):void {
    if (gw !== control) {
      active.set(gw, (active.get(gw) ?? 0) + 1);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        const n = (active.get(gw) ?? 1) - 1;
        if (n) active.set(gw, n); else active.delete(gw);
      };
      res.once('finish', done); res.once('close', done);
    }
    req.url=url;
    if(kind==='ui') gw.uiServer.emit('request',req,res);
    else gw.apiServer.emit('request',req,res);
  }
  function requireBrowser(req:IncomingMessage,res:ServerResponse,mutation=false):boolean {
    const session=control.auth.browserSession(req.headers.cookie);
    if (!session) {error(res,'AUTH_REQUIRED',401);return false;}
    if (mutation && !control.auth.validCsrf(session,String(req.headers['x-csrf-token']??''))) {
      error(res,'CSRF_REJECTED',403);return false;
    }
    return true;
  }

  const uiServer=http.createServer(async(req,res)=>{
    // Supervisor Ingress is mandatory. Do not proxy arbitrary headers from the Internet.
    if(!(options.ingressTrust ?? trustedIngress)(req)||!ingressPath(req)||!ingressMutationAllowed(req)) return error(res,'INGRESS_REQUIRED',403);
    const url=new URL(req.url??'/','http://localhost');
    const path=url.pathname;
    try {
      if(req.method==='GET' && ['/','/multi.js','/multi.css'].includes(path)) {
        const file=path==='/'?'multi.html':path.slice(1);
        const buf=await readFile(join(webDir,file));
        const ct=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
        res.writeHead(200,{'Content-Type':ct+'; charset=utf-8','X-Content-Type-Options':'nosniff',
          'Referrer-Policy':'no-referrer','X-Frame-Options':'SAMEORIGIN',
          'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'",'Cache-Control':'no-store'});
        return res.end(buf);
      }
      if(['/api/auth/session','/api/auth/logout','/api/pairing/status','/api/pairing/reset'].includes(path)) return route(req,res,control,'ui',req.url??path);
      if(path==='/api/accounts') {
        if(!requireBrowser(req,res,req.method!=='GET'))return;
        if(req.method==='GET')return reply(res,200,{accounts:accountStatus()});
        if(req.method==='POST') {
          if(mutating) return error(res,'ACCOUNT_OPERATION_BUSY',409);
          mutating=true;
          try{
            const body=await jsonBody(req);
            if(typeof body.id!=='string')return error(res,'INVALID_ACCOUNT');
            await addAccount(body.id);
            return reply(res,201,{id:body.id});
          } finally{mutating=false;}
        }
      }
      const settings=/^\/api\/accounts\/([a-z][a-z0-9_-]{0,31})\/webhook$/.exec(path);
      if(settings && req.method==='PUT') {
        if(mutating)return error(res,'ACCOUNT_OPERATION_BUSY',409);
        if(!requireBrowser(req,res,true))return;
        if(!running.has(settings[1]!))return error(res,'ACCOUNT_NOT_FOUND',404);
        const body=await jsonBody(req);
        if(typeof body.enabled!=='boolean' || (body.channel_secret!==undefined && typeof body.channel_secret!=='string'))
          return error(res,'INVALID_WEBHOOK_SETTINGS',400);
        await webhook.set(settings[1]!,body.enabled,body.channel_secret as string|undefined);
        return reply(res,200,webhook.status(settings[1]!));
      }
      const deletion=/^\/api\/accounts\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
      if(deletion&&req.method==='DELETE') {
        if(!requireBrowser(req,res,true))return;
        if(mutating)return error(res,'ACCOUNT_OPERATION_BUSY',409);
        mutating=true;
        try{await removeAccount(deletion[1]!);return reply(res,200,{ok:true});}
        finally{mutating=false;}
      }
      // Child UI receives unchanged Supervisor Ingress request/cookie but the
      // path after /accounts/<id>/ is rewritten to the upstream UI route.
      const match=/^\/accounts\/([a-z][a-z0-9_-]{0,31})(\/.*)$/.exec(path);
      if(match){
        const gw=running.get(match[1]!);
        if(!gw)return error(res,'ACCOUNT_NOT_FOUND',404);
        if (['/api/pairing/status','/api/pairing/reset','/api/auth/session','/api/auth/logout'].includes(match[2]!))
          return route(req,res,control,'ui',match[2]!+url.search);
        return route(req,res,gw,'ui',match[2]!+url.search);
      }
      return error(res,'NOT_FOUND',404);
    }catch(e){
      const code=e instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'INTERNAL_ERROR';
      if(e instanceof WebhookError)return error(res,e.code,e.status);
      return error(res,code,['INVALID_JSON','INVALID_ACCOUNT','BODY_TOO_LARGE'].includes(code)?400:
        ['ACCOUNT_EXISTS','ACCOUNT_LIMIT','ACCOUNT_SENDING'].includes(code)?409:
        code==='ACCOUNT_NOT_FOUND'?404:500);
    }
  });

  const apiServer=http.createServer(async(req,res)=>{
    const url=new URL(req.url??'/','http://localhost');
    const path=url.pathname;
    try {
      if((req.method==='GET'&&path==='/api/v1/health')||
         (req.method==='POST'&&path==='/api/v1/pairing/exchange'))
        return route(req,res,control,'api',path);
      if(!control.auth.validApiKey(req.headers.authorization))return error(res,'UNAUTHORIZED',401);
      if(req.method==='POST' && path==='/api/v1/webhook/line') {
        if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))return error(res,'INVALID_CONTENT_TYPE',415);
        const signature=req.headers['x-line-signature'];
        if(typeof signature!=='string')return error(res,'INVALID_LINE_SIGNATURE',401);
        let size=0;
        const chunks:Buffer[]=[];
        for await(const chunk of req){size+=chunk.length;if(size>256*1024)return error(res,'WEBHOOK_TOO_LARGE',413);chunks.push(Buffer.from(chunk));}
        const result=await webhook.receive(Buffer.concat(chunks),signature);
        return reply(res,200,result);
      }
      if(req.method==='GET' && path==='/api/v1/webhook/events') {
        const cursor=url.searchParams.get('after');
        return reply(res,200,webhook.events(cursor===null?0:Number(cursor)));
      }
      if(req.method==='GET'&&path==='/api/v1/accounts')return reply(res,200,{accounts:accountStatus()});
      if(req.method==='GET'&&path==='/api/v1/status'&&!url.searchParams.has('account')){
        const states=accountStatus();
        const online=states.some(x=>x.logged_in);
        return reply(res,200,{instance_id:controlConfig.instanceId,api_version:1,version:'0.2.0-dev.1',
          gateway_status:'running',line_logged_in:online,session_status:online?'ready':'auth_required',
          account_name:'LINE OA Multi',last_error:null,updated_at:new Date().toISOString(),
          accounts_count:states.length,accounts_connected:states.filter(x=>x.logged_in).length});
      }
      if(mutating)return error(res,'ACCOUNT_OPERATION_BUSY',409);
      const account=url.searchParams.get('account');
      if(account!==null){
        const gw=NAME.test(account)?running.get(account):undefined;
        if(!gw)return error(res,'ACCOUNT_NOT_FOUND',404);
        if((req.method==='GET' && ['/api/v1/status','/api/v1/aliases'].includes(path)) ||
          (req.method==='POST' && ['/api/v1/messages/text','/api/v1/messages/image'].includes(path))) {
          return route(req,res,gw,'api',path);
        }
      }
      // Plain JSON account/who/message API, without URL query; delegates to the
      // *same* account-specific sender used by the original Gateway.
      if(req.method==='POST'&&path==='/api/v1/messages/text'){
        const body=await jsonBody(req);
        const id=typeof body.account==='string'?body.account:'';
        const who=typeof body.who==='string'?body.who:'';
        const message=typeof body.message==='string'?body.message:'';
        const gw=running.get(id);
        if(!NAME.test(id)||!gw)return error(res,'ACCOUNT_NOT_FOUND',404);
        if(!NAME.test(who)||!message.trim()||message.length>MAX_MESSAGE||message.includes('\u0000'))return error(res,'INVALID_REQUEST');
        if(!gw.contacts.resolve(who))return error(res,'ALIAS_NOT_FOUND',404);
        const st=gw.sessions.getStatus().state;
        if(st==='AUTH_REQUIRED'||st==='EXPIRED')return error(res,st==='EXPIRED'?'SESSION_EXPIRED':'AUTH_REQUIRED',409);
        const requestId=parseRequestId(body.request_id);
        const fingerprint=requestFingerprint(['text',id,who,message]);
        const result=await dedup.get(id)!.run(requestId,fingerprint,async()=>{
          const sent=await gw.sender.send(who,message);
          const response=sendResponse(requestId,sent);
          return {status: response.status==='confirmed'?200:response.status==='failed'?502:202,body:response};
        });
        return reply(res,result.value.status,result.value.body);
      }
      return error(res,'NOT_FOUND',404);
    }catch(e){
      const code=e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'INTERNAL_ERROR';
      if(e instanceof WebhookError)return error(res,e.code,e.status);
      return error(res,code,code.startsWith('INVALID_')?400:code==='REQUEST_ID_CONFLICT'?409:500);
    }
  });
  for(const server of [uiServer,apiServer]){
    server.requestTimeout=20_000;
    server.headersTimeout=10_000;
  }
  let stopping:Promise<void>|undefined;
  return {
    accountStatus,addAccount,removeAccount,uiServer,apiServer,
    async start(apiPort=8787,uiPort=8099,host='0.0.0.0') {
      const listen=(s:http.Server,port:number)=>new Promise<void>((resolve,reject)=>{
        s.once('error',reject);
        s.listen(port,host,()=>{s.off('error',reject);resolve();});
      });
      try {await listen(apiServer,apiPort);await listen(uiServer,uiPort);}
      catch(e){await this.stop();throw e;}
      control.discovery?.start();
    },
    stop():Promise<void>{
      if(stopping)return stopping;
      stopping=(async()=>{
        const close=(server:http.Server)=>new Promise<void>(resolve=>{
          if(!server.listening)return resolve();
          server.close(()=>resolve());server.closeIdleConnections();
        });
        await Promise.all([close(uiServer),close(apiServer)]);
        for(const gw of running.values())await gw.stop();
        await control.stop();
      })();
      return stopping;
    }
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  try{
    const gw=await createMultiGateway();
    for(const signal of ['SIGINT','SIGTERM'] as const){
      process.once(signal,()=>{void gw.stop().then(()=>process.exit(0),()=>process.exit(1));});
    }
    await gw.start();
  }catch{
    process.stderr.write('LINE OA Multi startup failed; inspect protected Add-on logs and backup.\n');
    process.exitCode=1;
  }
}
