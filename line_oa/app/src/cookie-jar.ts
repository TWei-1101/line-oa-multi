import { isIP } from 'node:net';

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt?: number;
};

const COOKIE_DOMAINS = new Set(['chat.line.biz', 'account.line.biz', 'access.line.me', 'line.biz', 'line.me']);
const COOKIE_HOSTS = new Set(['chat.line.biz', 'account.line.biz', 'access.line.me']);
const AUTH_COOKIES = new Set(['ses', '__Host-chat-ses', '__Host-ses-account', 'llm', 'cert', 'qrPinCert', '__is_login_sso', '__Host-SID']);

export function validLoginCookies(value: unknown): value is StoredCookie[] {
  return Array.isArray(value) && value.length <= 64 && JSON.stringify(value).length <= 64 * 1024 && value.every(c =>
    c && typeof c === 'object' && COOKIE_DOMAINS.has(c.domain) && typeof c.hostOnly === 'boolean' &&
    (!c.hostOnly || COOKIE_HOSTS.has(c.domain)) && c.secure === true &&
    typeof c.path === 'string' && c.path.startsWith('/') && c.path.length <= 2048 && !/[\r\n;]/.test(c.path) &&
    typeof c.name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(c.name) &&
    typeof c.value === 'string' && c.value.length <= 8192 && !/[\r\n;]/.test(c.value) &&
    (c.expiresAt === undefined || (typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt))) &&
    (!c.name.startsWith('__Host-') || (c.hostOnly && c.path === '/')));
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith('/') || pathname === '/') return '/';
  const end = pathname.lastIndexOf('/');
  return end <= 0 ? '/' : pathname.slice(0, end);
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  return hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
}

export class MemoryCookieJar {
  private cookies = new Map<string, StoredCookie>();

  setFromHeaders(url: URL, headers: Headers): void {
    const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const value of values) this.set(url, value);
  }

  set(url: URL, header: string): void {
    if (url.protocol !== 'https:' || !COOKIE_HOSTS.has(url.hostname)) return;
    const parts = header.split(';').map(part => part.trim());
    const pair = parts.shift();
    if (!pair) return;
    const equals = pair.indexOf('=');
    if (equals <= 0) return;
    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name) || value.length > 8192 || /[\r\n;]/.test(value)) return;
    let domain = url.hostname.toLowerCase();
    let hostOnly = true;
    let path = defaultCookiePath(url.pathname);
    let secure = false;
    let expiresAt: number | undefined;
    let maxAge: number | undefined;
    for (const raw of parts) {
      const split = raw.indexOf('=');
      const key = (split < 0 ? raw : raw.slice(0, split)).trim().toLowerCase();
      const attr = split < 0 ? '' : raw.slice(split + 1).trim();
      if (key === 'domain') {
        const candidate = attr.replace(/^\./, '').toLowerCase();
        if (!COOKIE_DOMAINS.has(candidate) || isIP(candidate) || !domainMatches(url.hostname.toLowerCase(), candidate, false)) return;
        domain = candidate;
        hostOnly = false;
      } else if (key === 'path' && attr.startsWith('/')) path = attr;
      else if (key === 'secure') secure = true;
      else if (key === 'max-age' && /^-?\d+$/.test(attr)) maxAge = Number(attr);
      else if (key === 'expires') {
        const parsed = Date.parse(attr);
        if (Number.isFinite(parsed)) expiresAt = parsed;
      }
    }
    if (maxAge !== undefined && Number.isFinite(maxAge)) expiresAt = Date.now() + Math.min(maxAge, 400 * 86_400) * 1000;
    if (path.length > 2048 || /[\r\n;]/.test(path)) return;
    if (name.startsWith('__Host-') && (!secure || !hostOnly || path !== '/')) return;
    const key = `${domain}\n${path}\n${name}`;
    if (expiresAt !== undefined && expiresAt <= Date.now()) this.cookies.delete(key);
    else {
      if (!this.cookies.has(key) && this.cookies.size >= 64) throw new Error('LOGIN_COOKIE_LIMIT');
      this.cookies.set(key, { name, value, domain, hostOnly, path, secure, expiresAt });
    }
  }

  header(url: URL): string {
    const now = Date.now();
    const matches: StoredCookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) { this.cookies.delete(key); continue; }
      if (cookie.secure && url.protocol !== 'https:') continue;
      if (!domainMatches(url.hostname.toLowerCase(), cookie.domain, cookie.hostOnly)) continue;
      if (!(url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))) continue;
      matches.push(cookie);
    }
    matches.sort((a, b) => b.path.length - a.path.length);
    return matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  value(name: string, url: URL): string | undefined {
    const header = this.header(url);
    for (const pair of header.split('; ')) if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
    return undefined;
  }

  restore(cookies: StoredCookie[]): void {
    if (!validLoginCookies(cookies)) throw new Error('LOGIN_COOKIES_INVALID');
    for (const c of cookies) {
      if (c.expiresAt !== undefined && c.expiresAt <= Date.now()) continue;
      this.cookies.set(`${c.domain}\n${c.path}\n${c.name}`, structuredClone(c));
    }
  }

  /** Retain scoped authentication only; discard QR/CSRF intermediates and analytics. */
  snapshot(): StoredCookie[] {
    this.header(new URL('https://chat.line.biz/'));
    const cookies = [...this.cookies.values()].filter(c => c.secure && AUTH_COOKIES.has(c.name));
    if (!validLoginCookies(cookies)) throw new Error('LOGIN_COOKIE_LIMIT');
    return structuredClone(cookies);
  }

  clear(): void { this.cookies.clear(); }
}

