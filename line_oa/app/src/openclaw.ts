/** Durable HA webhook -> OpenClaw Responses -> existing OA Manager sender.
 * No official LINE reply/push API is used. Uncertain sends require review.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { familyMentionAdmitted, type ReceivedEvent } from './webhook.js';
import type { SendResult } from './types.js';
import { ensurePrivateDir } from './storage.js';
import { bridgeDatabasePath } from './data-paths.js';

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const WHO = /^[a-z0-9_-]{1,32}$/;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_PENDING = 1000;
export const VALID_FAMILY_ADMISSIONS = [
  'self-mention-group-text',
  'keyword-prefix',
  'followup-window',
  'keyword-or-followup',
  'smart-intent'
] as const;
export type FamilyAdmission = typeof VALID_FAMILY_ADMISSIONS[number];
export type Admission = 'legacy' | FamilyAdmission;

export function isFamilyKeywordTrigger(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  return /^(?:喵喵?|助理喵|小貓|貓咪|請問|問一下|@自動回覆喵|@助理喵)(?:[，,：:\s\s+]|$)/i.test(t) ||
         /^(?:喵喵?|助理喵|小貓|貓咪)$/i.test(t);
}

export function isSmartIntentTrigger(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 3 || t.length > 500) return false;
  const hasQuestionMark = /[？?]/.test(t);
  const hasInquiryKeywords = /(?:幾點|什麼時候|哪裡|多少錢|推薦|怎麼辦|如何|請教|有沒有|是不是|能不能|可以嗎|幫我|查一下|有人知道|誰知道)/.test(t);
  return hasQuestionMark && hasInquiryKeywords;
}

export function isFamilyEventAdmitted(event: ReceivedEvent, policy: {
  account: string;
  groups: ReadonlySet<string>;
  destination: string;
  admission: FamilyAdmission;
  isWithinFollowup?: (event: ReceivedEvent) => boolean;
}): boolean {
  if (event.account !== policy.account || event.source_type !== 'group' || !event.group_id || !policy.groups.has(event.group_id) || event.message_type !== 'text' || !event.text) return false;
  if (familyMentionAdmitted(event, { account: policy.account, groups: policy.groups, destination: policy.destination })) {
    return true;
  }
  if (policy.admission === 'self-mention-group-text') {
    return false;
  }
  if (policy.admission === 'keyword-prefix') {
    return isFamilyKeywordTrigger(event.text);
  }
  if (policy.admission === 'followup-window') {
    return policy.isWithinFollowup?.(event) ?? false;
  }
  if (policy.admission === 'keyword-or-followup') {
    return isFamilyKeywordTrigger(event.text) || (policy.isWithinFollowup?.(event) ?? false);
  }
  if (policy.admission === 'smart-intent') {
    return isFamilyKeywordTrigger(event.text) || (policy.isWithinFollowup?.(event) ?? false) || isSmartIntentTrigger(event.text);
  }
  return false;
}

type Route = { source_type: 'user' | 'group' | 'room'; source_id: string; who: string };
type EndpointOverride = { mode:'override'; url:string; token:string; agent:string; timeout_seconds:number; protocol:'legacy-responses'|'family-text-v1' };
type AccountConfig = { enabled: boolean; channel_access_token: string; routes: Route[]; endpoint?: EndpointOverride; admission?: Admission; expected_destination?: string };
type Config = { url: string; token: string; agent: string; timeout_seconds: number; accounts: Record<string, AccountConfig> };
type Output = { type: 'text'; text: string } | { type: 'image'; data: string; mime: 'image/jpeg' | 'image/png' };
type Job = { id: string; account: string; lane: string; who: string; event: ReceivedEvent; input_image?: string;
  state: 'pending' | 'generating' | 'ready' | 'sending' | 'submitted' | 'unknown' | 'failed' | 'ignored';
  outputs: Output[]; total?: number; next: number; attempts: number; due: number; error: string | null; created: number;
  /** Endpoint as accepted time. The token is deliberately absent from the job row:
   * it lives only in credential_revisions, addressed by credential_revision. */
  snapshot?: Omit<EndpointSnapshot,'token'> & {version:1; admission:Admission;session_policy:'legacy-lane-v1'|'family-group-v1';session_key:string;expected_destination?:string}; credential_revision?: number; media_credential_revision?:number; recipient?: string };
type Sender = { send(who: string, text: string, expectedTarget?: string): Promise<SendResult>;
  sendImage(who: string, image: Buffer, mime: 'image/jpeg' | 'image/png', expectedTarget?: string): Promise<SendResult> };
type Dependencies = { sender(account: string): Sender | undefined; hasAlias(account: string, who: string): boolean; resolveAlias?(account: string, who: string): string | undefined;
  boundDestination?(account:string):string|undefined; fetch?: typeof fetch; now?: () => number };
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
export type EndpointSnapshot = {url:string;token:string;agent:string;timeout_seconds:number;protocol:'legacy-responses'|'family-text-v1'};
export function effectiveEndpoint(global: {url:string;token:string;agent:string;timeout_seconds:number}, account: {endpoint?: EndpointOverride;admission?:string}): EndpointSnapshot {
  if (account.endpoint) { const {mode, ...snapshot}=account.endpoint; return snapshot; }
  if (account.admission && VALID_FAMILY_ADMISSIONS.includes(account.admission as any)) fail('FAMILY_ENDPOINT_SNAPSHOT_REQUIRED');
  if (!global.url || !global.token) fail('OPENCLAW_CONFIGURATION_REQUIRED');
  return {...global,protocol:'legacy-responses'};
}

/** An account PATCH may omit the token to keep the stored one. An explicit single-key
 * `inherit` clears the override; the family account cannot fall back to the shared
 * endpoint, so validateConfig rejects that shape while family is enabled. */
function mergedEndpoint(old: EndpointOverride | undefined, patch: unknown): EndpointOverride | undefined {
  if (patch === undefined) return old;
  if (!object(patch)) return patch as EndpointOverride;
  if (patch.mode === 'inherit' && Object.keys(patch).length === 1) return undefined;
  if (old && patch.mode === 'override' && patch.token === undefined && Object.keys(patch).length === 5)
    return { ...old, ...(patch as unknown as EndpointOverride) };
  return patch as unknown as EndpointOverride;
}
/** Allowed family groups are exactly the account's own group routes, so there is no
 * second whitelist that could drift away from what is actually reachable. */
function groupWhitelist(cfg: AccountConfig): ReadonlySet<string> {
  return new Set(cfg.routes.filter(r => r.source_type === 'group').map(r => r.source_id));
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
export function parseFamilyAnswer(value: unknown): Output[] {
  if (!object(value) || Object.keys(value).length !== 1 || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 5000 || value.text.includes('\0')) return fail('FAMILY_RESPONSE_INVALID');
  return [{type:'text',text:value.text}];
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

function snapshotSessionKey(account:string,lane:string,group?:string):string {
  return account==='family' ? 'line-family:v1:family:'+createHash('sha256').update(group??'').digest('hex') : 'line-oa-multi:'+account+':'+lane;
}
export function storedSnapshotValid(value:unknown):boolean {
    if(!object(value)||!object(value.event))return false;
    const job=value as unknown as Job;
    const x=job.snapshot;
    if(!Number.isSafeInteger(job.credential_revision)||Number(job.credential_revision)<=0)return false;
    if(job.event.message_type==='image'&&(!Number.isSafeInteger(job.media_credential_revision)||Number(job.media_credential_revision)<=0))return false;
    if(!Array.isArray(job.outputs)||!Number.isSafeInteger(job.next)||job.next<0||job.next>job.outputs.length)return false;
    if(!object(x)||x.version!==1||typeof x.agent!=='string'||!NAME.test(x.agent)||!Number.isInteger(x.timeout_seconds)||x.timeout_seconds<30||x.timeout_seconds>1800)return false;
    const family=job.account==='family';
    const keys=['version','url','agent','timeout_seconds','protocol','admission','session_policy','session_key',...(family?['expected_destination']:[])];
    if(Object.keys(x).length!==keys.length||!keys.every(k=>Object.hasOwn(x,k)))return false;
    try { checkUrl(x.url); } catch { return false; }
    if(typeof job.account!=='string'||typeof job.who!=='string'||!NAME.test(job.account)||!WHO.test(job.who)||sourceKey(job.event)!==job.lane||job.event.account!==job.account||typeof job.recipient!=='string'||!job.recipient)return false;
    if(x.session_key!==snapshotSessionKey(job.account,job.lane,job.event.group_id))return false;
    if(family) {
      if(x.protocol!=='family-text-v1'||x.agent!=='family-line'||!VALID_FAMILY_ADMISSIONS.includes(x.admission as any)||x.session_policy!=='family-group-v1'||!/^C[0-9a-f]{32}$/i.test(job.event.group_id??'')||job.event.destination!==x.expected_destination)return false;
      if(x.admission==='self-mention-group-text') {
        if(!familyMentionAdmitted(job.event,{account:'family',groups:new Set([job.event.group_id!]),destination:x.expected_destination??''}))return false;
      } else {
        if(typeof job.event.text!=='string'||!job.event.text.trim())return false;
      }
      if(job.outputs.some(p=>!object(p)||p.type!=='text'||typeof p.text!=='string'||!p.text.trim()||p.text.length>5000||p.text.includes('\0')))return false;
    } else if(x.protocol!=='legacy-responses'||x.admission!=='legacy'||x.session_policy!=='legacy-lane-v1')return false;
    return true;
  }

export class OpenClawBridge {
  private db!: DatabaseSync;
  private dbOpened = false;
  private config: Config = defaults();
  private timer?: ReturnType<typeof setInterval>;
  private task?: Promise<void>;
  private mediaTask?: Promise<void>;
  private stopping = false; private paused = false;
  private abort = new AbortController();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private lastActivity = new Map<string, number>();

  private followupActivityKey(event: ReceivedEvent): string | undefined {
    if (event.source_type !== 'group' || !event.group_id || !/^U[0-9a-f]{32}$/i.test(event.user_id ?? '')) return undefined;
    return `${event.account}\0${event.group_id}\0${event.user_id}`;
  }

  private touchGroupActivity(event: ReceivedEvent): void {
    const key = this.followupActivityKey(event);
    if (key) this.lastActivity.set(key, this.now());
  }

  private isWithinFollowupWindow(event: ReceivedEvent, windowMs = 180_000): boolean {
    const key = this.followupActivityKey(event);
    if (!key) return false;
    const last = this.lastActivity.get(key);
    if (last === undefined) return false;
    const elapsed = this.now() - last;
    return elapsed >= 0 && elapsed < windowMs;
  }
  private fault: string | null = null;
  private stopped?: Promise<void>;
  constructor(private readonly root: string, private readonly deps: Dependencies) {
    this.fetcher = deps.fetch ?? fetch; this.now = deps.now ?? Date.now;
  }
  async load(): Promise<void> {
    await ensurePrivateDir(this.root);
    const path = bridgeDatabasePath(this.root);
    this.db = new DatabaseSync(path);
    this.dbOpened = true;
    await chmod(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, lane TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_state ON jobs(state);
      CREATE TABLE IF NOT EXISTS credential_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, created INTEGER NOT NULL);`);
    const saved = this.db.prepare('SELECT body FROM config WHERE id=1').get() as {body: string} | undefined;
    if (saved) this.config = this.validateConfig(JSON.parse(saved.body));
    for (const job of this.jobs()) {
      if (job.state === 'sending') { job.state = 'unknown'; job.error = 'RESTART_DURING_SEND'; this.save(job); }
      if (job.state === 'generating') { job.state = 'failed'; job.error = 'OPENCLAW_RESULT_UNCERTAIN'; this.save(job); }
      if (!['submitted','ignored'].includes(job.state) && !this.snapshotValid(job)) { job.state='unknown';job.error='SNAPSHOT_INVALID_REVIEW_REQUIRED';this.save(job); }
    }
  }
  private validateOverride(value: unknown): EndpointOverride | undefined {
    if (value === undefined) return undefined;
    if (object(value) && value.mode === 'inherit' && Object.keys(value).length === 1) return undefined;
    if (!object(value) || value.mode !== 'override' || Object.keys(value).length !== 6 || typeof value.token !== 'string' || !value.token || !cleanToken(value.token) || typeof value.agent!=='string' || !NAME.test(value.agent) || !Number.isInteger(value.timeout_seconds) || Number(value.timeout_seconds)<30 || Number(value.timeout_seconds)>1800 || !['legacy-responses','family-text-v1'].includes(String(value.protocol))) fail('INVALID_OPENCLAW_OVERRIDE');
    const x=value as {url:unknown;token:string;agent:string;timeout_seconds:number;protocol:'legacy-responses'|'family-text-v1'}; return {mode:'override',url:checkUrl(x.url),token:x.token,agent:x.agent,timeout_seconds:x.timeout_seconds,protocol:x.protocol};
  }
  private validateConfig(v: unknown): Config {
    if (!object(v) || typeof v.url !== 'string' || !cleanToken(v.token) || typeof v.agent!=='string' || !NAME.test(v.agent) ||
        !Number.isInteger(v.timeout_seconds) || Number(v.timeout_seconds) < 30 || Number(v.timeout_seconds) > 1800 ||
        !object(v.accounts) || Object.keys(v.accounts).length > 20) return fail('INVALID_OPENCLAW_SETTINGS');
    if (v.url) checkUrl(v.url);
    for (const [id, cfg] of Object.entries(v.accounts)) {
      if (!NAME.test(id) || !object(cfg) || typeof cfg.enabled !== 'boolean' || !cleanToken(cfg.channel_access_token) ||
          !Array.isArray(cfg.routes) || cfg.routes.length > 100) return fail('INVALID_OPENCLAW_SETTINGS');
      const endpoint=this.validateOverride(cfg.endpoint);
      const admission=cfg.admission === undefined ? 'legacy' : cfg.admission;
      if (!['legacy', ...VALID_FAMILY_ADMISSIONS].includes(admission as string)) return fail('INVALID_OPENCLAW_ADMISSION');
      if (cfg.expected_destination!==undefined && (typeof cfg.expected_destination!=='string'||!/^U[0-9a-f]{32}$/i.test(cfg.expected_destination)) && cfg.expected_destination!=='') fail('FAMILY_DESTINATION_REQUIRED');
      if (id==='family' && cfg.enabled && !/^U[0-9a-f]{32}$/i.test(String(cfg.expected_destination??''))) fail('FAMILY_DESTINATION_REQUIRED');
      if(id==='family'&&cfg.enabled&&this.deps.boundDestination?.(id)!==cfg.expected_destination)fail('FAMILY_SIGNED_BINDING_REQUIRED',409);
      if (id==='family' && cfg.enabled && (!endpoint || endpoint.agent!=='family-line' || endpoint.protocol!=='family-text-v1' || !VALID_FAMILY_ADMISSIONS.includes(admission as any))) return fail('FAMILY_CONFIGURATION_REQUIRED');
      const seen = new Set<string>();
      for (const route of cfg.routes) {
        if (!object(route) || !['user','group','room'].includes(String(route.source_type)) || typeof route.source_id !== 'string' ||
            !/^[UCR][0-9a-f]{32}$/i.test(route.source_id) || !WHO.test(String(route.who)) ||
            seen.has(`${route.source_type}:${route.source_id}`)) return fail('INVALID_OPENCLAW_ROUTE');
        const prefix = {user:'U',group:'C',room:'R'}[String(route.source_type)]!;
        if (!route.source_id.startsWith(prefix)) return fail('INVALID_OPENCLAW_ROUTE');
        seen.add(`${route.source_type}:${route.source_id}`);
      }
      if(id==='family'&&cfg.enabled&&!cfg.routes.some(r=>object(r)&&r.source_type==='group'))fail('FAMILY_GROUP_ROUTE_REQUIRED');
      if (cfg.enabled && ((!endpoint && (!v.url || !v.token)) || !cfg.routes.length)) return fail('OPENCLAW_CONFIGURATION_REQUIRED');
    }
    const result=structuredClone(v) as Config; for (const [id,cfg] of Object.entries(result.accounts)) { cfg.endpoint=this.validateOverride((v.accounts as Record<string,unknown>)[id] && (v.accounts as Record<string,Record<string,unknown>>)[id]!.endpoint); cfg.admission=cfg.admission ?? 'legacy'; } return result;
  }
  configure(patch: Record<string, unknown>, account?: string): void {
    // In-flight work owns immutable revisions; intake disable and new-job settings remain available.
    const next = structuredClone(this.config);
    // A scoped safety action changes only intake state. Previously validated
    // routes/bindings may have drifted; they must not veto emergency disable.
    // Any additional field, enablement or identity change still takes the strict path.
    if(account && Object.keys(patch).length===1 && Object.hasOwn(patch,'enabled') && patch.enabled===false) {
      if(!NAME.test(account))return fail('INVALID_OPENCLAW_SETTINGS');
      if(!Object.hasOwn(next.accounts,account))next.accounts[account]={enabled:false,channel_access_token:'',routes:[]};
      next.accounts[account]!.enabled=false;
      this.db.prepare('INSERT OR REPLACE INTO config(id,body) VALUES(1,?)').run(JSON.stringify(next));
      this.config=next;
      return;
    }
    if (account) {
      const old = Object.hasOwn(next.accounts,account) ? next.accounts[account]! : {enabled:false, channel_access_token:'', routes:[]};
      next.accounts[account] = {enabled: patch.enabled === undefined ? old.enabled : patch.enabled as boolean,
        channel_access_token: patch.channel_access_token === undefined ? old.channel_access_token : patch.channel_access_token as string,
        routes: patch.routes === undefined ? old.routes : patch.routes as Route[],
        endpoint: mergedEndpoint(old.endpoint, patch.endpoint),
        admission: patch.admission === undefined ? old.admission : patch.admission as Admission,
        expected_destination:patch.expected_destination===undefined?old.expected_destination:patch.expected_destination as string};
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
    return { ...base, token_configured:!!token, fault:this.fault, paused:this.paused,
      accounts: Object.fromEntries(Object.entries(accounts).filter(([id])=>!account || id===account).map(([id,cfg])=>
        [id,{enabled:cfg.enabled, channel_access_token_configured:!!cfg.channel_access_token, routes:cfg.routes, admission:cfg.admission, expected_destination:cfg.expected_destination, endpoint:cfg.endpoint ? {mode:'override',url:cfg.endpoint.url,agent:cfg.endpoint.agent,timeout_seconds:cfg.endpoint.timeout_seconds,protocol:cfg.endpoint.protocol,token_configured:true} : {mode:'inherit'}}])),
      counts:Object.fromEntries(['pending','generating','ready','sending','submitted','unknown','failed','ignored'].map(s=>[s,jobs.filter(j=>j.state===s).length])),
      jobs: jobs.slice(-100).reverse().map(j=>({id:j.id,account:j.account,source:j.lane,who:j.who,state:j.state,
        error:j.error,next_part:j.next,total_parts:j.total??j.outputs.length,attempts:j.attempts,created:j.created})),
      recent_sources:this.db.prepare('SELECT account,lane FROM jobs GROUP BY account,lane ORDER BY rowid DESC LIMIT 100').all() };
  }
  hasOutstanding(account: string, who?:string): boolean {
    return this.jobs().some(j=>j.account===account && (who===undefined||j.who===who) && !['submitted','ignored'].includes(j.state));
  }
  ownsEvent(account: string, webhookEventId: string): boolean {
    if (!NAME.test(account) || !/^[A-Za-z0-9_-]{8,128}$/.test(webhookEventId)) return false;
    const id = createHash('sha256').update(`${account}\0${webhookEventId}`).digest('hex');
    return !!this.db.prepare('SELECT id FROM jobs WHERE id=?').get(id);
  }
  removeAccount(account: string): void {
    if (this.task || this.hasOutstanding(account)) return fail('OPENCLAW_JOBS_PENDING',409);
    const next = structuredClone(this.config); delete next.accounts[account];
    this.db.prepare('INSERT OR REPLACE INTO config(id,body) VALUES(1,?)').run(JSON.stringify(next));
    this.config=next;
    this.db.prepare('DELETE FROM jobs WHERE account=?').run(account);
  }
  isAdmitted(event: ReceivedEvent, isWithinFollowup?: (event: ReceivedEvent) => boolean): boolean {
    const cfg = this.config.accounts[event.account], lane = sourceKey(event);
    if (!cfg?.enabled || !lane || event.type !== 'message' || !['text', 'image'].includes(event.message_type ?? '')) return false;
    if (event.account === 'family') {
      if (!cfg.expected_destination || event.destination !== cfg.expected_destination || this.deps.boundDestination?.(event.account) !== cfg.expected_destination) return false;
      const admission = (cfg.admission ?? 'self-mention-group-text') as FamilyAdmission;
      const admitted = isFamilyEventAdmitted(event, {
        account: event.account,
        groups: groupWhitelist(cfg),
        destination: cfg.expected_destination,
        admission,
        isWithinFollowup: candidate => isWithinFollowup?.(candidate) ?? this.isWithinFollowupWindow(candidate)
      });
      if (!admitted) return false;
    }
    const route = cfg.routes.find(r => `${r.source_type}:${r.source_id}` === lane);
    return !!route;
  }
  /** Called before the webhook returns 200, including redeliveries. A full queue
   * refuses the entire batch. Already submitted IDs are retained for deduplication. */
  enqueue(events: ReceivedEvent[]): Set<string> {
    const admitted = new Set<string>();
    const committedActivity: ReceivedEvent[] = [];
    const batchActivity = new Set<string>();
    const isWithinBatchFollowup = (event: ReceivedEvent): boolean => {
      const key = this.followupActivityKey(event);
      return (key !== undefined && batchActivity.has(key)) || this.isWithinFollowupWindow(event);
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const all=this.jobs();
      let pending=all.filter(j=>!['submitted','ignored'].includes(j.state)).length;
      for (const event of events) {
        if (!this.isAdmitted(event, isWithinBatchFollowup)) continue;
        const cfg=this.config.accounts[event.account]!, lane=sourceKey(event)!;
        const route=cfg.routes.find(r=>`${r.source_type}:${r.source_id}`===lane)!;
        const id=createHash('sha256').update(`${event.account}\0${event.webhook_event_id}`).digest('hex');
        admitted.add(event.webhook_event_id);
        if (this.db.prepare('SELECT id FROM jobs WHERE id=?').get(id)) continue;
        if (++pending>MAX_PENDING) return fail('OPENCLAW_QUEUE_FULL',503);
        const endpoint=effectiveEndpoint(this.config,cfg);
        const revision=this.db.prepare('INSERT INTO credential_revisions(value,created) VALUES(?,?)').run(endpoint.token,this.now());
        this.checkCapacity(Buffer.byteLength(JSON.stringify(event))+1024);
        const recipient=this.deps.resolveAlias?.(event.account,route.who);
        const family=event.account==='family';
        const snapshot:NonNullable<Job['snapshot']>={version:1,url:endpoint.url,agent:endpoint.agent,timeout_seconds:endpoint.timeout_seconds,protocol:endpoint.protocol,admission:cfg.admission??'legacy',session_policy:family?'family-group-v1':'legacy-lane-v1',session_key:this.sessionKey(event.account,lane,event.group_id),...(family?{expected_destination:cfg.expected_destination}:{})};
        const mediaRevision=event.message_type==='image'&&cfg.channel_access_token ? Number(this.db.prepare('INSERT INTO credential_revisions(value,created) VALUES(?,?)').run(cfg.channel_access_token,this.now()).lastInsertRowid):undefined;
        this.save({id,account:event.account,lane,who:route.who,...(recipient ? {recipient} : {}),event,snapshot,credential_revision:Number(revision.lastInsertRowid),...(mediaRevision?{media_credential_revision:mediaRevision}:{}),state:'pending',outputs:[],next:0,attempts:0,due:0,error:null,created:this.now()});
        if (event.account === 'family') {
          committedActivity.push(event);
          const key = this.followupActivityKey(event);
          if (key) batchActivity.add(key);
        }
      }
      // Never prune pending/failed/uncertain work. Completion retention is bounded.
      const complete=this.jobs().filter(j=>['submitted','ignored'].includes(j.state));
      for (const job of complete.filter((j,i)=>j.created < this.now()-30*86400_000 || i<complete.length-4000))
        this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
      this.db.exec('COMMIT');
      for (const event of committedActivity) this.touchGroupActivity(event);
      return admitted;
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
    if (this.timer || this.paused || this.stopping) return;
    this.timer=setInterval(()=>{void this.tick().catch(()=>{this.fault='OPENCLAW_STORAGE_OR_WORKER_ERROR';});},1000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopping || this.paused || this.fault) return Promise.resolve();
    // A slow model turn must not prevent caching newly arriving LINE images.
    if(!this.mediaTask)this.mediaTask=this.prefetch().catch(()=>{this.fault='OPENCLAW_STORAGE_OR_WORKER_ERROR';})
      .finally(()=>{this.mediaTask=undefined;});
    if(this.task)return this.task;
    const media=this.mediaTask;
    this.task=(async()=>{await media;if(!this.stopping && !this.fault)await this.process();})().finally(()=>{this.task=undefined;});
    return this.task;
  }
  private sessionKey(account:string,lane:string,group?:string):string {
    return snapshotSessionKey(account,lane,group);
  }
  private credential(revision:unknown):string|undefined {
    if(!Number.isSafeInteger(revision)||Number(revision)<=0)return undefined;
    const value=(this.db.prepare('SELECT value FROM credential_revisions WHERE id=?').get(revision as number) as {value?:unknown}|undefined)?.value;
    return cleanToken(value)&&value ? value : undefined;
  }
  private snapshotValid(job:Job):boolean { return storedSnapshotValid(job); }
  private async prefetch(): Promise<void> {
    // Cache incoming images even while an earlier turn is waiting on the Mac.
    // LINE content is not a permanent archive, so don't wait for that turn.
    const image=this.jobs().find(j=>j.state==='pending' && j.event.message_type==='image' && !j.input_image &&
      this.config.accounts[j.account]?.enabled && j.due<=this.now());
    if(image){
      if(!this.snapshotValid(image)){image.state='unknown';image.error='SNAPSHOT_INVALID_REVIEW_REQUIRED';this.save(image);return;}
      try{const token=this.credential(image.media_credential_revision);if(!this.credential(image.credential_revision)||!token){image.state='unknown';image.error='CREDENTIAL_REVISION_MISSING';this.save(image);return;}await this.downloadImage(image,token);}
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
    if (!this.snapshotValid(job)) { job.state='unknown'; job.error='SNAPSHOT_INVALID_REVIEW_REQUIRED'; this.save(job); return; }
    // A job runs only with its own credential revision. Missing revision data fails
    // closed instead of silently borrowing whichever token is configured now.
    const token=this.credential(job.credential_revision);
    if (!token) { job.state='unknown'; job.error='CREDENTIAL_REVISION_MISSING'; this.save(job); return; }
    const cfg:EndpointSnapshot={...(job.snapshot as Omit<EndpointSnapshot,'token'>),token};
    const sender=this.deps.sender(job.account);
    if (!sender || !this.deps.hasAlias(job.account,job.who) || !job.recipient) { job.state='failed';job.error='ALIAS_SNAPSHOT_REQUIRED';this.save(job);return; }
    const family=cfg.protocol==='family-text-v1';
    if (job.state==='pending') {
      try {
        if(job.event.message_type==='image' && !job.input_image)return;
        const input: Record<string,unknown>[] = job.input_image ? [
          {type:'input_text',text:'請閱讀這張使用者傳來的圖片並回覆。'}, {type:'input_image',source:{type:'base64',media_type:job.input_image.split(';')[0]!.slice(5),data:job.input_image.split(',')[1]}}
        ] : [{type:'input_text',text:job.event.text??''}];
        job.state='generating';this.save(job);
        // family-text-v1 is a fixed, text-only contract: no agent id, no session key,
        // and no route from this endpoint to any tool.
        const response=await this.fetcher(cfg.url,{method:'POST',redirect:'error',
          headers:family?{Authorization:`Bearer ${cfg.token}`,'Content-Type':'application/json'}:
            {Authorization:`Bearer ${cfg.token}`,'Content-Type':'application/json','x-openclaw-agent-id':cfg.agent,
              'x-openclaw-session-key':job.snapshot!.session_key},
          body:family?JSON.stringify({version:1,event_id:job.event.webhook_event_id,group_id:job.event.group_id,text:job.event.text??''}):
            JSON.stringify({model:`openclaw/${cfg.agent}`,stream:false,user:job.snapshot!.session_key,
              input:[{type:'message',role:'user',content:input}]}),
          signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(cfg.timeout_seconds*1000)])});
        if (!response.ok) {
          await response.body?.cancel();
          // An explicit refusal before a run can be retried; a server error may
          // follow committed agent tool effects and therefore needs review.
          if (!family && response.status===429) { job.state='pending';return fail('OPENCLAW_HTTP_429'); }
          if (family && response.status===503 && response.headers.get('x-line-oa-retry-safe')==='before-agent') { job.state='pending';return fail('FAMILY_HTTP_RETRY_SAFE'); }
          return fail(`OPENCLAW_HTTP_${response.status}`);
        }
        const decoded=JSON.parse((await boundedBody(response,MAX_BODY)).toString('utf8'));
        const outputs=family ? parseFamilyAnswer(decoded) : parseAnswer(decoded);
        this.checkCapacity(Buffer.byteLength(JSON.stringify(outputs)));
        job.outputs=outputs;job.total=outputs.length;
        job.state='ready';job.error=null;job.attempts=0;this.save(job);
      } catch (e) {
        const disconnected=job.state==='generating' && connectFailure(e);
        if(disconnected)job.state='pending';
        const code=e instanceof BridgeError ? e.code : disconnected?'OPENCLAW_CONNECT_UNAVAILABLE':
          job.state==='generating'?'OPENCLAW_RESULT_UNCERTAIN':'LINE_CONTENT_UNAVAILABLE';
        job.error=code;
        if (job.state==='pending' && ((!family && ['OPENCLAW_CONNECT_UNAVAILABLE','LINE_CONTENT_UNAVAILABLE','OPENCLAW_HTTP_429','OPENCLAW_HTTP_503'].includes(code)) || (family && code==='FAMILY_HTTP_RETRY_SAFE') || /^LINE_CONTENT_HTTP_5/.test(code))) {
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
        result=part.type==='text'?await sender.send(job.who,part.text,job.recipient):
          await sender.sendImage(job.who,Buffer.from(part.data.split(',')[1]!, 'base64'),part.mime,job.recipient);
      } catch(e) {
        // The existing sender throws its preflight errors before issuing a send.
        const code=e instanceof Error?e.message:'';
        if (['SEND_BUSY','RATE_LIMITED','DUPLICATE_BLOCKED','SESSION_NETWORK'].includes(code) ||
          code.startsWith('SEND_QUEUE_')) {
          job.state='ready';this.retry(job,code);return;
        }
        job.state=/^(SESSION_|TARGET_|INVALID_|AUTH_|SEND_CONTEXT_CHANGED$)/.test(code)?'failed':'unknown';
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
      if (job.account === 'family' && job.state === 'submitted' && job.event.group_id) {
        this.touchGroupActivity(job.event);
      }
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
  async pause(): Promise<void> { this.paused=true; if(this.timer)clearInterval(this.timer); this.timer=undefined; await Promise.all([this.task?.catch(()=>undefined),this.mediaTask?.catch(()=>undefined)]); }
  resume(): void { if(this.stopping)return; this.paused=false; this.start(); }
  stop(): Promise<void> {
    if(this.stopped)return this.stopped;
    this.stopping=true;if(this.timer)clearInterval(this.timer);this.abort.abort();
    this.stopped=(async()=>{
      await Promise.all([this.task?.catch(()=>undefined),this.mediaTask?.catch(()=>undefined)]);
      if(this.dbOpened){
        this.dbOpened=false;
        this.db.close();
      }
    })();
    return this.stopped;
  }
}
