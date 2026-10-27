export type SessionState = 'CONNECTED' | 'VALIDATING' | 'AUTH_REQUIRED' | 'EXPIRED' | 'DISCONNECTED' | 'ERROR';

export interface CookieValue { name: 'ses' | '__Host-chat-ses' | 'XSRF-TOKEN'; value: string }

export interface SessionCredentials {
  version: 1;
  botId: string;
  accountName?: string;
  clientVersion?: string;
  csrfToken?: string;
  cookies: CookieValue[];
  loginCookies?: import('./cookie-jar.js').StoredCookie[];
  importedAt: string;
}

export interface Contact {
  chatId: string;
  name: string;
  kind: 'user' | 'group';
  friend: boolean;
  chatAvailable: boolean;
}

export interface ContactAlias { chatId: string; name: string }
export type AliasMap = Record<string, ContactAlias>;

export interface GatewayConfig {
  instanceId: string;
  listenHost: string;
  port: number;
  contactsCacheTtlMs: number;
  sessionCheckIntervalMinutes: number;
  uiAuthEnabled: boolean;
  apiEnabled: boolean;
  secureCookies: boolean;
  rateLimitPerMinute: number;
  duplicateWindowMs: number;
  maxImageBytes: number;
  maxTempBytes: number;
  requestTimeoutMs: number;
}

export interface SendResult {
  error_name?: string;
  details?: string;
  result: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
  sendId: string;
  status?: number;
  error?: string;
}

export interface OperationLog {
  localTime?: string;
  timezone?: string;
  details?: string;
  time: string;
  operation: string;
  target?: string;
  result: string;
  error?: string;
}
