/** Durable HA webhook -> OpenClaw Responses -> existing OA Manager sender.
 * No official LINE reply/push API is used. Uncertain sends require review.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ReceivedEvent } from './webhook.js';
import type { SendResult } from './types.js';
import { ensurePrivateDir } from './storage.js';

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const WHO = /^[a-z0-9_-]{1,32}$/;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_PENDING = 1000;
type Route = { source_type: 'user' | 'group' | 'room'; source_id: string; who: string };
type AccountConfig = { enabled: boolean; channel_access_token: string; routes: Route[] };
type Config = { url: string; token: string; agent: string; timeout_seconds: number; accounts: Record<string, AccountConfig> };
type Output = { type: 'text'; text: string } | { type: 'image'; data: string; mime: 'image/jpeg' | 'image/png' };
type Job = { id: string; account: string; lane: string; who: string; event: ReceivedEvent; input_image?: string;
  state: 'pending' | 'generating' | 'ready' | 'sending' | 'submitted' | 'unknown' | 'failed' | 'ignored';
  outputs: Output[]; total?: number; next: number; attempts: number; due: number; error: string | null; created: number };
type Sender = { send(who: string, text: string): Promise<SendResult>;
  sendImage(who: string, image: Buffer, mime: 'image/jpeg' | 'image/png'): Promise<SendResult> };
type Dependencies = { sender(account: string): Sender | undefined; hasAlias(account: string, who: string): boolean;
  fetch?: typeof fetch; now?: () => number };
const defaults = (): Config => ({url: '', token: '', agent: 'main', timeout_seconds: 300, accounts: {}});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const connectFailure = (e: unknown): boolean => {
  const cause=object(e) && object(e.cause)?e.cause:undefined;
  return ['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(String(cause?.code));
};

export class BridgeError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
function fail(code: string, status = 400): never { throw new BridgeError(code, status); }
function cleanToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function checkUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return fail('INVALID_OPENCLAW_URL');
  let u: URL; try { u = new URL(value); } catch { return fail('INVALID_OPENCLAW_URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash ||
      u.pathname !== '/v1/responses') return fail('INVALID_OPENCLAW_URL');
  return u.href;
}
export function sourceKey(e: ReceivedEvent): string | undefined {
  const id = e.source_type === 'group' ? e.group_id : e.source_type === 'room' ? e.room_id :
    e.source_type === 'user' ? e.user_id : undefined;
  return id ? `${e.source_type}:${id}` : undefined;
}
export function splitText(text: string, limit = 5000): string[] {
  if (!text.trim() || text.includes('\0')) return fail('INVALID_OPENCLAW_TEXT');
  const result: string[] = [];
  while (text.length) {
    let end = Math.min(limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    // No trim: concatenating chunks reconstructs every character of the answer.
    result.push(text.slice(0, end)); text = text.slice(end);
  }
  return result;
}
export function imageData(data: string): {data: string; mime: 'image/jpeg' | 'image/png'} {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match || match[2]!.length > Math.ceil(MAX_IMAGE / 3) * 4) return fail('INVALID_IMAGE_DATA');
  const buffer = Buffer.from(match[2]!, 'base64');
  const mime = match[1] as 'image/jpeg' | 'image/png';
  if (!buffer.length || buffer.length > MAX_IMAGE || buffer.toString('base64') !== match[2] ||
      (mime === 'image/png' ? !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
        !(buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255))) return fail('INVALID_IMAGE_DATA');
  return {data, mime};
}
export function parseAnswer(value: unknown): Output[] {
  if (!object(value) || value.status !== 'completed' || !Array.isArray(value.output)) return fail('OPENCLAW_RESPONSE_INCOMPLETE');
  const result: Output[] = [];
  for (const item of value.output) {
    if (!object(item)) return fail('OPENCLAW_RESPONSE_INVALID');
    if (item.type === 'image_generation_call' && typeof item.result === 'string') {
      result.push({type: 'image', ...imageData(`data:image/png;base64,${item.result}`)});
    } else if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      if(item.status!==undefined && item.status!=='completed')return fail('OPENCLAW_RESPONSE_INCOMPLETE');
      for (const part of item.content) {
        if (!object(part)) return fail('OPENCLAW_RESPONSE_INVALID');
        if (part.type === 'output_text' && typeof part.text === 'string') {
          // A local Mac file path cannot be opened by HA. The optional Mac adapter
          // turns these references into inline image parts before returning them.
          if (/(?:^|\n)\s*MEDIA:/.test(part.text) || /!\[[^\]]*\]\(/.test(part.text)) return fail('OPENCLAW_MEDIA_ADAPTER_REQUIRED');
          if (part.text.trim()) result.push(...splitText(part.text).map(text => ({type: 'text' as const, text})));
        } else if (part.type === 'output_image' && typeof part.image_url === 'string') {
          result.push({type: 'image', ...imageData(part.image_url)});
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          result.push(...splitText(part.refusal).map(text => ({type: 'text' as const, text})));
        } else return fail('OPENCLAW_OUTPUT_UNSUPPORTED');
      }
    } else if (!['reasoning', 'function_call', 'function_call_output'].includes(String(item.type))) {
      return fail('OPENCLAW_OUTPUT_UNSUPPORTED');
    }
  }
  if (!result.length || result.length > 200 || Buffer.byteLength(JSON.stringify(result)) > MAX_BODY) return fail('OPENCLAW_OUTPUT_LIMIT');
  return result;
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return fail('EMPTY_HTTP_BODY');
  const chunks: Buffer[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return fail('HTTP_BODY_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class OpenClawBridge {
  private db!: DatabaseSync;
  private config: Config = defaults();
  private timer?: ReturnType<typeof setInterval>;
  private task?: Promise<void>;
  private mediaTask?: Promise<void>;
  private stopping = false;
  private abort = new AbortController();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private fault: string | null = null;
  private stopped?: Promise<void>;
  constructor(private readonly root: string, private readonly deps: Dependencies) {
    this.fetcher = deps.fetch ?? fetch; this.now = deps.now ?? Date.now;
  }
  async load(): Promise<void> {
    await ensurePrivateDir(this.root);
    const path = join(this.root, 'openclaw.sqlite');
    this.db = new DatabaseSync(path);
    await chmod(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, lane TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_state ON jobs(state);`);
    const saved = this.db.prepare('SELECT body FROM config WHERE id=1').get() as {body: string} | undefined;
    if (saved) this.config = this.validateConfig(JSON.parse(saved.body));
    for (const job of this.jobs()) {
      if (job.state === 'sending') { job.state = 'unknown'; job.error = 'RESTART_DURING_SEND'; this.save(job); }
      if (job.state === 'generating') { job.state = 'failed'; job.error = 'OPENCLAW_RESULT_UNCERTAIN'; this.save(job); }
    }
  }
  private validateConfig(v: unknown): Config {
    if (!object(v) || typeof v.url !== 'string' || !cleanToken(v.token) || !NAME.test(String(v.agent)) ||
        !Number.isInteger(v.timeout_seconds) || Number(v.timeout_seconds) < 30 || Number(v.timeout_seconds) > 1800 ||
        !object(v.accounts) || Object.keys(v.accounts).length > 20) return fail('INVALID_OPENCLAW_SETTINGS');
    if (v.url) checkUrl(v.url);
    for (const [id, cfg] of Object.entries(v.accounts)) {
      if (!NAME.test(id) || !object(cfg) || typeof cfg.enabled !== 'boolean' || !cleanToken(cfg.channel_access_token) ||
          !Array.isArray(cfg.routes) || cfg.routes.length > 100) return fail('INVALID_OPENCLAW_SETTINGS');
      const seen = new Set<string>();
      for (const route of cfg.routes) {
        if (!object(route) || !['user','group','room'].includes(String(route.source_type)) || typeof route.source_id !== 'string' ||
            !/^[UCR][0-9a-f]{32}$/i.test(route.source_id) || !WHO.test(String(route.who)) ||
            seen.has(`${route.source_type}:${route.source_id}`)) return fail('INVALID_OPENCLAW_ROUTE');
        const prefix = {user:'U',group:'C',room:'R'}[String(route.source_type)]!;
        if (!route.source_id.startsWith(prefix)) return fail('INVALID_OPENCLAW_ROUTE');
        seen.add(`${route.source_type}:${route.source_id}`);
      }
      if (cfg.enabled && (!v.url || !v.token || !cfg.routes.length)) return fail('OPENCLAW_CONFIGURATION_REQUIRED');
    }
    return structuredClone(v) as Config;
  }
  configure(patch: Record<string, unknown>, account?: string): void {
    if (this.task) return fail('OPENCLAW_BUSY',409);
    const next = structuredClone(this.config);
    if (account) {
      const old = Object.hasOwn(next.accounts,account) ? next.accounts[account]! : {enabled:false, channel_access_token:'', routes:[]};
      next.accounts[account] = {enabled: patch.enabled as boolean,
        channel_access_token: patch.channel_access_token === undefined ? old.channel_access_token : patch.channel_access_token as string,
        routes: patch.routes === undefined ? old.routes : patch.routes as Route[]};
    } else {
      for (const key of ['url','token','agent','timeout_seconds'] as const) {
        if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key];
      }
    }
    const valid = this.validateConfig(next);
    for (const [id, cfg] of Object.entries(valid.accounts)) for (const route of cfg.routes) {
      if (!this.deps.hasAlias(id,route.who)) return fail('ALIAS_NOT_FOUND',404);
    }
    this.db.prepare('INSERT OR REPLACE INTO config(id,body) VALUES(1,?)').run(JSON.stringify(valid));
    this.config = valid;
  }
  status(account?: string) {
    const jobs = this.jobs().filter(j=>!account || j.account===account);
    const {token, accounts, ...base} = this.config;
    return { ...base, token_configured:!!token, fault:this.fault,
      accounts: Object.fromEntries(Object.entries(accounts).filter(([id])=>!account || id===account).map(([id,cfg])=>
        [id,{enabled:cfg.enabled, channel_access_token_configured:!!cfg.channel_access_token, routes:cfg.routes}])),
      counts:Object.fromEntries(['pending','generating','ready','sending','submitted','unknown','failed','ignored'].map(s=>[s,jobs.filter(j=>j.state===s).length])),
      jobs: jobs.slice(-100).reverse().map(j=>({id:j.id,account:j.account,source:j.lane,who:j.who,state:j.state,
        error:j.error,next_part:j.next,total_parts:j.total??j.outputs.length,attempts:j.attempts,created:j.created})),
      recent_sources:this.db.prepare('SELECT account,lane FROM jobs GROUP BY account,lane ORDER BY rowid DESC LIMIT 100').all() };
  }
  hasOutstanding(account: string): boolean {
    return this.jobs().some(j=>j.account===account && !['submitted','ignored'].includes(j.state));
  }
  removeAccount(account: string): void {
    if (this.task || this.hasOutstanding(account)) return fail('OPENCLAW_JOBS_PENDING',409);
    const next = structuredClone(this.config); delete next.accounts[account];
    this.db.prepare('INSERT OR REPLACE INTO config(id,body) VALUES(1,?)').run(JSON.stringify(next));
    this.config=next;
    this.db.prepare('DELETE FROM jobs WHERE account=?').run(account);
  }
  /** Called before the webhook returns 200, including redeliveries. A full queue
   * refuses the entire batch. Already submitted IDs are retained for deduplication. */
  enqueue(events: ReceivedEvent[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const all=this.jobs();
      let pending=all.filter(j=>!['submitted','ignored'].includes(j.state)).length;
      for (const event of events) {
        const cfg=this.config.accounts[event.account], lane=sourceKey(event);
        if (!cfg?.enabled || !lane || event.type!=='message' || !['text','image'].includes(event.message_type??'')) continue;
        const route=cfg.routes.find(r=>`${r.source_type}:${r.source_id}`===lane);
        if (!route) continue;
        const id=createHash('sha256').update(`${event.account}\0${event.webhook_event_id}`).digest('hex');
        if (this.db.prepare('SELECT id FROM jobs WHERE id=?').get(id)) continue;
        if (++pending>MAX_PENDING) return fail('OPENCLAW_QUEUE_FULL',503);
        this.checkCapacity(Buffer.byteLength(JSON.stringify(event))+1024);
        this.save({id,account:event.account,lane,who:route.who,event,state:'pending',outputs:[],next:0,attempts:0,due:0,error:null,created:this.now()});
      }
      // Never prune pending/failed/uncertain work. Completion retention is bounded.
      const complete=this.jobs().filter(j=>['submitted','ignored'].includes(j.state));
      for (const job of complete.filter((j,i)=>j.created < this.now()-30*86400_000 || i<complete.length-4000))
        this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  review(id: string, action: 'retry' | 'skip' | 'mark_submitted'): void {
    if (this.task) return fail('OPENCLAW_BUSY',409);
    const job=this.jobs().find(j=>j.id===id);
    if (!job || !['failed','unknown'].includes(job.state)) return fail('OPENCLAW_JOB_NOT_REVIEWABLE',409);
    if (action==='skip') job.state='ignored';
    else if (action==='mark_submitted') {
      if (job.state!=='unknown') return fail('OPENCLAW_JOB_NOT_REVIEWABLE',409);
      job.next++; job.state=job.next===job.outputs.length?'submitted':'ready';
    } else { job.state=job.outputs.length?'ready':'pending'; job.attempts=0;job.due=0; }
    job.error=null; this.save(job);
  }
  private jobs(): Job[] {
    return (this.db.prepare('SELECT body FROM jobs ORDER BY rowid').all() as {body:string}[]).map(r=>JSON.parse(r.body) as Job);
  }
  private save(job: Job): void {
    if (['submitted','ignored'].includes(job.state)) {
      job.total ??= job.outputs.length;
      job.outputs=[];delete job.input_image;delete job.event.text;
    }
    this.db.prepare('INSERT INTO jobs(id,account,lane,state,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body')
      .run(job.id,job.account,job.lane,job.state,JSON.stringify(job));
  }
  start(): void {
    if (this.timer) return;
    this.timer=setInterval(()=>{void this.tick().catch(()=>{this.fault='OPENCLAW_STORAGE_OR_WORKER_ERROR';});},1000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopping || this.fault) return Promise.resolve();
    // A slow model turn must not prevent caching newly arriving LINE images.
    if(!this.mediaTask)this.mediaTask=this.prefetch().catch(()=>{this.fault='OPENCLAW_STORAGE_OR_WORKER_ERROR';})
      .finally(()=>{this.mediaTask=undefined;});
    if(this.task)return this.task;
    const media=this.mediaTask;
    this.task=(async()=>{await media;if(!this.stopping && !this.fault)await this.process();})().finally(()=>{this.task=undefined;});
    return this.task;
  }
  private async prefetch(): Promise<void> {
    // Cache incoming images even while an earlier turn is waiting on the Mac.
    // LINE content is not a permanent archive, so don't wait for that turn.
    const image=this.jobs().find(j=>j.state==='pending' && j.event.message_type==='image' && !j.input_image &&
      this.config.accounts[j.account]?.enabled && j.due<=this.now());
    if(image){
      try{await this.downloadImage(image,this.config.accounts[image.account]!.channel_access_token);}
      catch(e){
        const code=e instanceof BridgeError?e.code:'LINE_CONTENT_UNAVAILABLE';
        if(code==='LINE_CONTENT_UNAVAILABLE' || /^LINE_CONTENT_HTTP_(?:429|5)/.test(code))this.retry(image,code);
        else{image.state='failed';image.error=code;this.save(image);}
      }
    }
  }
  private async process(): Promise<void> {
    const seen=new Set<string>();
    const job=this.jobs().find(j=>{
      if (['submitted','ignored'].includes(j.state)) return false;
      const lane=`${j.account}:${j.lane}`;
      if (seen.has(lane)) return false; seen.add(lane);
      return this.config.accounts[j.account]?.enabled && ['pending','ready'].includes(j.state) && j.due<=this.now();
    });
    if (!job) return;
    const cfg=structuredClone(this.config);
    const sender=this.deps.sender(job.account);
    if (!sender || !this.deps.hasAlias(job.account,job.who)) { job.state='failed';job.error='ALIAS_NOT_FOUND';this.save(job);return; }
    if (job.state==='pending') {
      try {
        if(job.event.message_type==='image' && !job.input_image)return;
        const input: Record<string,unknown>[] = job.input_image ? [
          {type:'input_text',text:'請閱讀這張使用者傳來的圖片並回覆。'}, {type:'input_image',source:{type:'base64',media_type:job.input_image.split(';')[0]!.slice(5),data:job.input_image.split(',')[1]}}
        ] : [{type:'input_text',text:job.event.text??''}];
        job.state='generating';this.save(job);
        const response=await this.fetcher(cfg.url,{method:'POST',redirect:'error',
          headers:{Authorization:`Bearer ${cfg.token}`,'Content-Type':'application/json','x-openclaw-agent-id':cfg.agent,
            'x-openclaw-session-key':`line-oa-multi:${job.account}:${job.lane}`},
          body:JSON.stringify({model:`openclaw/${cfg.agent}`,stream:false,user:`line-oa-multi:${job.account}:${job.lane}`,
            input:[{type:'message',role:'user',content:input}]}),
          signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(cfg.timeout_seconds*1000)])});
        if (!response.ok) {
          await response.body?.cancel();
          // An explicit refusal before a run can be retried; a server error may
          // follow committed agent tool effects and therefore needs review.
          if (response.status===429 || (response.status===503 && response.headers.get('x-line-oa-retry-safe')==='before-agent')) {
            job.state='pending';return fail(`OPENCLAW_HTTP_${response.status}`);
          }
          return fail(`OPENCLAW_HTTP_${response.status}`);
        }
        const outputs=parseAnswer(JSON.parse((await boundedBody(response,MAX_BODY)).toString('utf8')));
        this.checkCapacity(Buffer.byteLength(JSON.stringify(outputs)));
        job.outputs=outputs;job.total=outputs.length;
        job.state='ready';job.error=null;job.attempts=0;this.save(job);
      } catch (e) {
        if(job.state==='generating' && connectFailure(e))job.state='pending';
        const code=e instanceof BridgeError ? e.code : job.state==='generating'?'OPENCLAW_RESULT_UNCERTAIN':'LINE_CONTENT_UNAVAILABLE';
        job.error=code;
        if (job.state==='pending' && (['LINE_CONTENT_UNAVAILABLE','OPENCLAW_HTTP_429','OPENCLAW_HTTP_503'].includes(code) || /^LINE_CONTENT_HTTP_5/.test(code))) {
          this.retry(job,code);
        } else { job.state='failed';this.save(job); }
        return;
      }
    }
    while (job.next<job.outputs.length && !this.stopping) {
      const part=job.outputs[job.next]!;
      job.state='sending';this.save(job);
      let result: SendResult;
      try {
        result=part.type==='text'?await sender.send(job.who,part.text):
          await sender.sendImage(job.who,Buffer.from(part.data.split(',')[1]!, 'base64'),part.mime);
      } catch(e) {
        // The existing sender throws its preflight errors before issuing a send.
        const code=e instanceof Error?e.message:'';
        if (['SEND_BUSY','RATE_LIMITED','DUPLICATE_BLOCKED','SESSION_NETWORK'].includes(code)) {
          job.state='ready';this.retry(job,code);return;
        }
        job.state=/^(SESSION_|TARGET_|INVALID_|AUTH_)/.test(code)?'failed':'unknown';
        job.error=job.state==='unknown'?'SEND_RESULT_UNCERTAIN':'SEND_PREFLIGHT_FAILED';this.save(job);return;
      }
      if (result.result==='UNKNOWN') { job.state='unknown';job.error='SEND_RESULT_UNCERTAIN';this.save(job);return; }
      if (result.result==='FAILED') {
        job.state='ready';
        if (result.status===429) this.retry(job,'LINE_RATE_LIMIT');
        else {job.state='failed';job.error='LINE_SEND_REJECTED';this.save(job);}
        return;
      }
      job.next++;job.state=job.next===job.outputs.length?'submitted':'ready';job.attempts=0;job.error=null;this.save(job);
    }
  }
  private checkCapacity(extra: number): void {
    const row=this.db.prepare('SELECT COALESCE(SUM(length(body)),0) AS bytes FROM jobs').get() as {bytes:number};
    if(row.bytes+extra>128*1024*1024)return fail('OPENCLAW_STORAGE_CAPACITY',503);
  }
  private async downloadImage(job: Job,token: string): Promise<void> {
    if(!token)return fail('LINE_CONTENT_TOKEN_REQUIRED');
    if(!job.event.message_id || !/^[0-9]{1,64}$/.test(job.event.message_id))return fail('LINE_MESSAGE_ID_REQUIRED');
    const response=await this.fetcher(`https://api-data.line.me/v2/bot/message/${job.event.message_id}/content`,{
      headers:{Authorization:`Bearer ${token}`},redirect:'error',
      signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])});
    if(!response.ok){await response.body?.cancel();return fail(`LINE_CONTENT_HTTP_${response.status}`);}
    const mime=response.headers.get('content-type')?.split(';')[0];
    const bytes=await boundedBody(response,MAX_IMAGE);
    const data=imageData(`data:${mime};base64,${bytes.toString('base64')}`).data;
    this.checkCapacity(Buffer.byteLength(data));job.input_image=data;this.save(job);
  }
  private retry(job: Job, code: string): void {
    job.error=code;job.attempts++;
    if (job.attempts>=8) job.state='failed';
    job.due=this.now()+Math.min(300_000,5000*2**job.attempts);this.save(job);
  }
  stop(): Promise<void> {
    if(this.stopped)return this.stopped;
    this.stopping=true;if(this.timer)clearInterval(this.timer);this.abort.abort();
    this.stopped=(async()=>{await Promise.all([this.task?.catch(()=>undefined),this.mediaTask?.catch(()=>undefined)]);this.db.close();})();
    return this.stopped;
  }
}
