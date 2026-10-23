/** Strict account-fixed bridge protocol. It is deliberately not the Mac adapter. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type FamilyRequest = { version: 1; event_id: string; group_id: string; text: string };
export class FamilyBridgeError extends Error { constructor(public readonly code: string, public readonly status = 400) { super(code); } }
const fail = (code: string, status = 400): never => { throw new FamilyBridgeError(code, status); };
export const FAMILY_MAX_BYTES = 32 * 1024;
const GROUP = /^C[0-9a-f]{32}$/i;
const commandLike = {test(text:string):boolean { const s=text.trimStart();return s.startsWith('/') || (s.startsWith('@')&&/\s\//u.test(s)); }};

export function validateFamilyRequest(value: unknown, groups: ReadonlySet<string>): FamilyRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FAMILY_INVALID_BODY');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || !['version', 'event_id', 'group_id', 'text'].every(k => k in v)) fail('FAMILY_UNKNOWN_FIELD');
  if (v.version !== 1 || typeof v.event_id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(v.event_id)) fail('FAMILY_EVENT_ID');
  if (typeof v.group_id !== 'string' || !GROUP.test(v.group_id) || !groups.has(v.group_id)) fail('FAMILY_GROUP');
  if (typeof v.text !== 'string' || !v.text.length || v.text.length > 5000 || v.text.includes('\0') || Buffer.byteLength(JSON.stringify(v)) > FAMILY_MAX_BYTES) fail('FAMILY_TEXT');
  return v as FamilyRequest;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared=Number(response.headers.get('content-length')??'0'); if(!Number.isFinite(declared)||declared<0||declared>64*1024) { await response.body?.cancel();fail('FAMILY_UPSTREAM_TOO_LARGE',502); }
  if(!response.body) fail('FAMILY_UPSTREAM_MALFORMED',502); const reader=response.body!.getReader(),parts:Uint8Array[]=[];let n=0;
  try{for(;;){const x=await reader.read();if(x.done)break;n+=x.value.byteLength;if(n>64*1024){await reader.cancel();fail('FAMILY_UPSTREAM_TOO_LARGE',502);}parts.push(x.value);}}finally{reader.releaseLock();}
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts.map(x=>Buffer.from(x))));return JSON.parse(text);}catch{fail('FAMILY_UPSTREAM_MALFORMED',502);}
}
/** The .241 response is accepted only when it is a completed, single text answer. */
export function parseFamilyUpstream(value: unknown): string {
  if (!value || typeof value !== 'object') fail('FAMILY_UPSTREAM_MALFORMED', 502);
  const root = value as Record<string, unknown>;
  if (root.status !== 'completed' || !Array.isArray(root.output) || root.output.length !== 1) fail('FAMILY_UPSTREAM_MALFORMED', 502);
  const output = root.output as unknown[];
  const item = output[0] as Record<string, unknown>;
  if (!item || item.type !== 'message' || item.role !== 'assistant' || (item.status !== undefined && item.status !== 'completed') || !Array.isArray(item.content) || item.content.length !== 1) fail('FAMILY_UPSTREAM_MALFORMED', 502);
  const content = item.content as unknown[];
  const part = content[0] as Record<string, unknown>;
  if (!part || part.type !== 'output_text' || typeof part.text !== 'string' || !part.text.trim() || part.text.length > 5000 || part.text.includes('\0')) fail('FAMILY_UPSTREAM_MALFORMED', 502);
  return part.text as string;
}

export type FamilyBridgeOptions = { token: string; groups: readonly string[]; fetch?: typeof fetch; upstream?: string; upstreamToken?:string; ledgerPath?: string; upstreamTimeoutMs?:number };
type Ledger = { hash: string; state: 'dispatching' | 'completed'; text?: string };

/** Ledger entries are written before dispatch and before a successful reply. A restart
 * sees dispatching as held, rather than guessing whether the upstream ran. */
export class FamilyBridge {
  private readonly groups: Set<string>; private readonly fetcher: typeof fetch; private readonly upstream: string;
  private readonly ledger = new Map<string, Ledger>(); private db?: DatabaseSync; private readonly activeGroups = new Set<string>(); private active = 0; private closed=false;
  constructor(private readonly options: FamilyBridgeOptions) {
    this.groups = new Set(options.groups); this.fetcher = options.fetch ?? fetch;
    this.upstream = options.upstream ?? 'http://127.0.0.1:18790/v1/responses';
    const u=new URL(this.upstream); if(u.protocol!=='http:' || !['127.0.0.1','::1','localhost'].includes(u.hostname) || u.pathname!=='/v1/responses' || u.search || u.hash || u.username || u.password) fail('FAMILY_UPSTREAM_CONFIGURATION',500);
    if (!options.token || !options.ledgerPath) return;
    this.db = new DatabaseSync(options.ledgerPath); chmodSync(options.ledgerPath, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS family_ledger (event_id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, text TEXT)');
  }
  close(): void { this.closed=true;this.db?.close(); this.db = undefined; }
  authenticate(token: string): void { const a = Buffer.from(token), b = Buffer.from(this.options.token); if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) fail('FAMILY_UNAUTHORIZED', 401); }
  sessionKey(groupId: string): string { return 'line-family:v1:family:' + createHash('sha256').update(groupId).digest('hex'); }
  private prior(id:string):Ledger|undefined {
    let row:Ledger|undefined;try{row=this.db?this.db.prepare('SELECT hash,state,text FROM family_ledger WHERE event_id=?').get(id) as Ledger|undefined:this.ledger.get(id);}catch{fail('FAMILY_LEDGER_FAILURE',503);}
    if(row&&(!/^[a-f0-9]{64}$/.test(row.hash)||!['dispatching','completed'].includes(row.state)||(row.state==='completed'&&(typeof row.text!=='string'||!row.text.trim()||row.text.length>5000||row.text.includes('\0')))))fail('FAMILY_LEDGER_FAILURE',503);
    return row;
  }
  private intent(id: string, hash: string): void { if (!this.db) { this.ledger.set(id, {hash, state:'dispatching'}); return; } this.db.prepare('INSERT INTO family_ledger(event_id,hash,state) VALUES(?,?,?)').run(id, hash, 'dispatching'); }
  private complete(id: string, hash: string, text: string): void { if (!this.db) { this.ledger.set(id, {hash, state:'completed', text}); return; } const changed = this.db.prepare("UPDATE family_ledger SET state='completed',text=? WHERE event_id=? AND hash=? AND state='dispatching'").run(text, id, hash); if (changed.changes !== 1) fail('FAMILY_LEDGER_FAILURE', 503); }
  async dispatch(value: unknown, bearer: string): Promise<{text: string; cached?: boolean}> {
    this.authenticate(bearer); if(this.closed)fail('FAMILY_LEDGER_CLOSED',503); const request = validateFamilyRequest(value, this.groups);
    if (commandLike.test(request.text)) fail('FAMILY_COMMAND_REJECTED');
    const hash = createHash('sha256').update([request.version,request.event_id,request.group_id,request.text].join('\0')).digest('hex'), prior = this.prior(request.event_id);
    if (prior) { if (prior.hash !== hash) fail('FAMILY_EVENT_CONFLICT', 409); if (prior.state !== 'completed') fail('FAMILY_EVENT_HELD', 409); return {text: prior.text!}; }
    if (this.active >= 8 || this.activeGroups.has(request.group_id)) fail('FAMILY_BUSY', 429);
    this.active++; this.activeGroups.add(request.group_id);
    try {
    try { this.intent(request.event_id, hash); } catch { fail('FAMILY_LEDGER_FAILURE', 503); }
    let response: Response | undefined;
    try { response = await this.fetcher(this.upstream, {method:'POST', redirect:'error', signal:AbortSignal.timeout(this.options.upstreamTimeoutMs??30_000), headers:{'content-type':'application/json',...(this.options.upstreamToken?{authorization:'Bearer '+this.options.upstreamToken}:{}),'x-openclaw-agent-id':'family-line','x-openclaw-session-key':this.sessionKey(request.group_id)}, body:JSON.stringify({model:'openclaw/family-line',stream:false,user:this.sessionKey(request.group_id),input:[{type:'message',role:'user',content:[{type:'input_text',text:request.text}]}]})}); } catch { fail('FAMILY_UPSTREAM_UNCERTAIN', 503); }
    if (!response!.ok) { await response!.body?.cancel(); fail('FAMILY_UPSTREAM_FAILED', 502); }
    let text: string | undefined; try { text = parseFamilyUpstream(await boundedJson(response!)); } catch (e) { if (e instanceof FamilyBridgeError) throw e; fail('FAMILY_UPSTREAM_MALFORMED', 502); }
    try { this.complete(request.event_id, hash, text!); } catch (e) { if (e instanceof FamilyBridgeError) throw e; fail('FAMILY_LEDGER_FAILURE', 503); }
    return {text:text!};
    } finally { this.active--; this.activeGroups.delete(request.group_id); }
  }
}
