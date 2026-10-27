import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';

import { diagnosticText, networkDetails } from './diagnostics.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Contact, SendResult, SessionCredentials } from './types.js';
import { SessionManager } from './session.js';
import { LINE_USER_AGENT } from './line-browser.js';

export type RecoveryTrigger = 'scheduled_check' | 'startup_check' | 'manual_check' | 'send' | 'contacts';

type RawResponse = { status: number; body: unknown; contentType: string; details?: string; headers?: Record<string, unknown> };
export type RequestFn = (method: string, path: string, headers: Record<string, string>, body?: string | Buffer) => Promise<RawResponse>;

export class LineError extends Error {
  constructor(public readonly kind: 'AUTH' | 'CSRF' | 'RATE_LIMIT' | 'SERVER' | 'NETWORK' | 'INVALID_RESPONSE' | 'REJECTED', public readonly status?: number, public readonly details?: string, public readonly code = status === 403 ? 'LINE_HTTP_403_CSRF_OR_PERMISSION_DENIED' : `LINE_${kind}${status ? '_HTTP_' + status : ''}`) {
    super(kind);
    this.name = code;
  }
}

function requestHttps(timeoutMs: number): RequestFn {
  return (method, path, headers, body) => new Promise((resolve, reject) => {
    const req = https.request({ protocol: 'https:', hostname: 'chat.line.biz', port: 443, method, path, headers, timeout: timeoutMs, agent: false }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new Error('RESPONSE_LIMIT'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
        resolve({ status: res.statusCode ?? 0, body: parsed, contentType: String(res.headers['content-type'] ?? ''), headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('TIMEOUT'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function classify(status: number, details?: string): LineError {
  if (status === 401) return new LineError('AUTH', status, details);
  if (status === 403) return new LineError('CSRF', status, details);
  if (status === 429) return new LineError('RATE_LIMIT', status, details);
  if (status >= 500) return new LineError('SERVER', status, details);
  return new LineError('REJECTED', status, details);
}

export class LineClient {
  private readonly request: RequestFn;
  private readonly recoveryTrigger = new AsyncLocalStorage<RecoveryTrigger>();
  private validation?: { credentials: SessionCredentials; promise: Promise<void> };
  private recovery?: { credentials: SessionCredentials; promise: Promise<void> };
  constructor(private readonly sessions: SessionManager, timeoutMs: number, request?: RequestFn,
    private readonly onFailure?: (code: string, details: string) => void,
    private readonly recoverSession?: (credentials: SessionCredentials, trigger: RecoveryTrigger) => Promise<void>,
    private readonly recoveryAllowed: (trigger: RecoveryTrigger) => boolean = () => true) {
    const rawRequest = request ?? requestHttps(timeoutMs);
    this.request = async (method, path, headers, body) => {
      const credentials = this.sessions.getCredentials();
      const secrets = [...(credentials?.cookies.map(c => c.value) ?? []), ...(credentials?.loginCookies?.map(c => c.value) ?? []), credentials?.csrfToken ?? ''];
      try {
        let sentCookie = headers.Cookie;
        let response = await rawRequest(method, path, headers, body);
        if (credentials && this.sessions.getCredentials() !== credentials) throw new Error('SESSION_CHANGED');
        const trigger = this.recoveryTrigger.getStore() ?? (method === 'POST' ? 'send' : 'contacts');
        if (credentials && this.recoverSession && this.recoveryAllowed(trigger) && response.status === 401 &&
          (response.body as { code?: unknown } | null)?.code === 'not_login') {
          // Retry only an explicit unauthenticated rejection, never an ambiguous send.
          // Another request may already have renewed this exact credential object.
          if (sentCookie === this.headers(credentials).Cookie) await this.repair(credentials, trigger);
          if (this.sessions.getCredentials() !== credentials) throw new Error('SESSION_CHANGED');
          sentCookie = this.headers(credentials).Cookie;
          response = await rawRequest(method, path, { ...headers, ...this.headers(credentials) }, body);
          if (this.sessions.getCredentials() !== credentials) throw new Error('SESSION_CHANGED');
        }
        if (credentials && response.status >= 200 && response.status < 300 && sentCookie === this.headers(credentials).Cookie) {
          const setCookie = response.headers?.['set-cookie'];
          if (setCookie) await this.sessions.updateCookies(Array.isArray(setCookie) ? setCookie.map(String) : [String(setCookie)], credentials, sentCookie);
        }
        secrets.push(...(credentials?.cookies.map(c => c.value) ?? []), ...(credentials?.loginCookies?.map(c => c.value) ?? []));
        if (response.status < 200 || response.status >= 300) {
          response.details = diagnosticText({ method, endpoint: path, httpStatus: response.status,
            contentType: response.contentType, responseHeaders: response.headers ?? {}, response: response.body }, secrets);
          this.onFailure?.(classify(response.status).code, response.details);
        }
        return response;
      } catch (error) {
        if (error instanceof Error && error.message === 'SESSION_CHANGED') throw error;
        if (error instanceof LineError) throw error;
        const details = diagnosticText({ method, endpoint: path, networkError: networkDetails(error) }, secrets);
        this.onFailure?.('LINE_NETWORK_ERROR', details);
        throw new LineError('NETWORK', undefined, details, 'LINE_NETWORK_ERROR');
      }
    };
  }

  private async repair(credentials: SessionCredentials, trigger: RecoveryTrigger): Promise<void> {
    if (this.recovery?.credentials === credentials) return this.recovery.promise;
    const promise = (async () => {
      try { await this.recoverSession!(credentials, trigger); }
      catch (error) {
        if (error instanceof Error && error.message === 'SESSION_CHANGED') throw error;
        const code = error instanceof Error && /^LOGIN_[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOGIN_RECOVERY_FAILED';
        const kind = /(?:REAUTH_REQUIRED|HTTP_401)$/.test(code) ? 'AUTH' : /HTTP_429$|RATE_LIMITED$/.test(code) ? 'RATE_LIMIT'
          : /HTTP_403$/.test(code) ? 'CSRF' : /NETWORK|TIMEOUT|BUSY/.test(code) ? 'NETWORK' : 'INVALID_RESPONSE';
        // The original operation was rejected before submission, even if recovery went offline.
        throw new LineError(kind, 401, undefined, code);
      }
    })();
    this.recovery = { credentials, promise };
    try { await promise; } finally { if (this.recovery?.promise === promise) this.recovery = undefined; }
  }

  private invalid(response: RawResponse, code: string, endpoint: string): LineError {
    const credentials = this.sessions.getCredentials();
    const details = diagnosticText({ endpoint, httpStatus: response.status, contentType: response.contentType,
      responseHeaders: response.headers ?? {}, response: response.body }, [...(credentials?.cookies.map(c => c.value) ?? []), ...(credentials?.loginCookies?.map(c => c.value) ?? []), credentials?.csrfToken ?? '']);
    this.onFailure?.(code, details);
    return new LineError('INVALID_RESPONSE', response.status, details, code);
  }

  private headers(credentials: SessionCredentials): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': LINE_USER_AGENT,
      Cookie: credentials.cookies.map(c => `${c.name}=${c.value}`).join('; '),
      Origin: 'https://chat.line.biz',
      Referer: 'https://chat.line.biz/'
    };
    if (credentials.csrfToken) headers['X-XSRF-TOKEN'] = credentials.csrfToken;
    if (credentials.clientVersion) headers['x-oa-chat-client-version'] = credentials.clientVersion;
    return headers;
  }

  private requireCredentials(): SessionCredentials {
    const value = this.sessions.getCredentials();
    if (!value) throw new LineError('AUTH');
    return value;
  }

  async refreshCsrf(): Promise<void> {
    const credentials = this.requireCredentials();
    const response = await this.request('GET', '/api/v1/csrfToken', this.headers(credentials));
    if (response.status !== 200) throw classify(response.status, response.details);
    const token = (response.body as { token?: unknown })?.token;
    if (typeof token !== 'string' || !token || /[\r\n;]/.test(token)) throw this.invalid(response, 'LINE_CSRF_TOKEN_MISSING_OR_INVALID', '/api/v1/csrfToken');
    await this.sessions.updateCsrf(token, credentials);
  }

  async getContacts(query = '', limit = 20, next?: string): Promise<{ list: Contact[]; next?: string }> {
    const credentials = this.requireCredentials();
    const params = new URLSearchParams({ query, sortKey: 'DISPLAY_NAME', sortOrder: 'ASC', filterKey: 'ALL', limit: String(Math.min(Math.max(limit, 1), 20)) });
    if (next) params.set('next', next);
    const response = await this.request('GET', `/api/v2/bots/${encodeURIComponent(credentials.botId)}/contacts?${params}`, this.headers(credentials));
    if (response.status !== 200) throw classify(response.status, response.details);
    const raw = response.body as { list?: unknown; next?: unknown };
    if (!Array.isArray(raw?.list)) throw this.invalid(response, 'LINE_CONTACT_LIST_INVALID_RESPONSE', '/api/v2/bots/:botId/contacts');
    const list: Contact[] = raw.list.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const profile = e.profile && typeof e.profile === 'object' ? e.profile as Record<string, unknown> : {};
      const chatId = typeof e.contactId === 'string' ? e.contactId : '';
      const name = typeof profile.name === 'string' ? profile.name : '';
      if (!/^[A-Za-z0-9_-]{10,128}$/.test(chatId) || !name) return [];
      return [{ chatId, name: name.slice(0, 100), kind: typeof profile.groupId === 'string' ? 'group' : 'user', friend: e.friend === true, chatAvailable: e.chatAvailable !== false } as Contact];
    });
    return { list, ...(typeof raw.next === 'string' && raw.next ? { next: raw.next } : {}) };
  }

  async validate(trigger: RecoveryTrigger = 'manual_check'): Promise<void> {
    const credentials = this.requireCredentials();
    if (this.validation?.credentials === credentials) return this.validation.promise;
    const validation = { credentials, promise: this.recoveryTrigger.run(trigger, async () => {
      await this.refreshCsrf();
      await this.getContacts('', 1);
    }) };
    this.validation = validation;
    try { await validation.promise; }
    finally { if (this.validation === validation) this.validation = undefined; }
  }

  async sendText(chatId: string, text: string): Promise<SendResult> {
    const credentials = this.requireCredentials();
    const sendId = randomUUID();
    const payload = JSON.stringify({ id: '', type: 'textV2', text, sendId });
    const headers = { ...this.headers(credentials), 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) };
    let response: RawResponse;
    try {
      response = await this.request('POST', `/api/v1/bots/${encodeURIComponent(credentials.botId)}/chats/${encodeURIComponent(chatId)}/messages/send`, headers, payload);
    } catch (error) {
      if (error instanceof LineError && error.status === 401) return { result: 'FAILED', sendId, status: 401, error: error.kind, error_name: error.code, details: error.details };
      return { result: 'UNKNOWN', sendId, error: 'NETWORK_OR_TIMEOUT' };
    }
    if (response.status === 200) return { result: 'SUBMITTED', sendId, status: 200 };
    const error = classify(response.status, response.details);
    return { result: 'FAILED', sendId, status: response.status, error: error.kind, details: error.details, error_name: error.code };
  }

  async sendImage(chatId: string, image: Buffer, mime: 'image/jpeg' | 'image/png'): Promise<SendResult> {
    const credentials = this.requireCredentials();
    const sendId = randomUUID();
    const boundary = `----line-oagw-${randomBytes(18).toString('hex')}`;
    const filename = mime === 'image/png' ? 'image.png' : 'image.jpg';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const multipart = Buffer.concat([head, image, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploadHeaders = { ...this.headers(credentials), Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(multipart.length) };
    let upload: RawResponse;
    try {
      upload = await this.request('POST', `/api/v1/bots/${encodeURIComponent(credentials.botId)}/messages/${encodeURIComponent(chatId)}/uploadFile`, uploadHeaders, multipart);
    } catch (error) {
      if (error instanceof LineError && error.status === 401) return { result: 'FAILED', sendId, status: 401, error: error.kind, error_name: error.code, details: error.details };
      return { result: 'UNKNOWN', sendId, error: 'UPLOAD_NETWORK_OR_TIMEOUT' };
    }
    if (upload.status < 200 || upload.status >= 300) {
      const error = classify(upload.status, upload.details);
      return { result: 'FAILED', sendId, status: upload.status, error: error.kind, details: error.details, error_name: error.code };
    }
    const token = (upload.body as { contentMessageToken?: unknown })?.contentMessageToken;
    if (typeof token !== 'string' || !token || token.length > 2048 || /[\r\n\u0000]/.test(token)) {
      const error = this.invalid(upload, 'LINE_UPLOAD_INVALID_RESPONSE', '/api/v1/bots/:botId/messages/:chatId/uploadFile');
      return { result: 'FAILED', sendId, status: upload.status, error: 'UPLOAD_INVALID_RESPONSE', error_name: error.code, details: error.details };
    }
    const payload = JSON.stringify({ items: [{ sendId, contentMessageToken: token }] });
    const sendHeaders = { ...this.headers(credentials), 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) };
    let response: RawResponse;
    try {
      response = await this.request('POST', `/api/v1/bots/${encodeURIComponent(credentials.botId)}/chats/${encodeURIComponent(chatId)}/messages/bulkSendFiles`, sendHeaders, payload);
    } catch (error) {
      if (error instanceof LineError && error.status === 401) return { result: 'FAILED', sendId, status: 401, error: error.kind, error_name: error.code, details: error.details };
      return { result: 'UNKNOWN', sendId, error: 'NETWORK_OR_TIMEOUT' };
    }
    if (response.status >= 200 && response.status < 300) return { result: 'SUBMITTED', sendId, status: response.status };
    const error = classify(response.status, response.details);
    return { result: 'FAILED', sendId, status: response.status, error: error.kind, details: error.details, error_name: error.code };
  }
}
