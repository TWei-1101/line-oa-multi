import { createHash } from 'node:crypto';
import type { SendResult } from './types.js';
import { ContactService } from './contacts.js';
import { LineClient, LineError } from './line-client.js';
import { SessionManager } from './session.js';
import { MemoryLogger } from './logger.js';

export class MessageSender {
  private recent = new Map<string, number>();
  private rate: number[] = [];
  private active = false;
  public submittedCount = 0;
  public lastSubmittedAt?: string;

  constructor(private readonly client: LineClient, private readonly sessions: SessionManager, private readonly contacts: ContactService,
    private readonly logger: MemoryLogger, private readonly duplicateWindowMs: number, private readonly rateLimit: number,
    private readonly onMessageSent: () => void = () => {}) {}

  isBusy(): boolean { return this.active; }

  async send(alias: string, message: string): Promise<SendResult> {
    if (!/^[a-z0-9_-]{1,32}$/.test(alias)) throw new Error('INVALID_TARGET');
    if (typeof message !== 'string' || !message.trim() || message.length > 5000 || /\u0000/.test(message)) throw new Error('INVALID_MESSAGE');
    const target = this.contacts.resolve(alias);
    if (!target) throw new Error('TARGET_NOT_ALLOWED');
    if (this.active) throw new Error('SEND_BUSY');
    const now = Date.now();
    this.rate = this.rate.filter(value => now - value < 60_000);
    if (this.rate.length >= this.rateLimit) throw new Error('RATE_LIMITED');
    const fingerprint = createHash('sha256').update(`${alias}\0${message}`).digest('hex');
    const last = this.recent.get(fingerprint);
    if (last && now - last < this.duplicateWindowMs) throw new Error('DUPLICATE_BLOCKED');
    this.recent.set(fingerprint, now);
    for (const [key, at] of this.recent) if (now - at > this.duplicateWindowMs * 2) this.recent.delete(key);
    this.rate.push(now);
    this.active = true;
    try {
      try {
        await this.client.validate();
        this.sessions.mark('CONNECTED', 'Session 驗證成功');
      } catch (error) {
        const kind = error instanceof LineError ? error.kind : 'NETWORK';
        if (kind === 'AUTH') this.sessions.mark('EXPIRED', 'LINE Session 已失效，需要人工重新授權');
        else if (kind === 'CSRF') this.sessions.mark('ERROR', 'CSRF 驗證失敗，已停止發送');
        else this.sessions.mark('DISCONNECTED', `連線驗證失敗：${kind}`);
        this.logger.add('SEND_TEXT', 'FAILED', alias, kind);
        throw new Error(`SESSION_${kind}`);
      }
      const result = await this.client.sendText(target.chatId, message);
      if (result.result === 'SUBMITTED') {
        this.submittedCount += 1;
        this.lastSubmittedAt = new Date().toISOString();
      } else if (result.error === 'AUTH') this.sessions.mark('EXPIRED', 'LINE Session 已失效，需要人工重新授權');
      else if (result.error === 'CSRF') this.sessions.mark('ERROR', 'CSRF 驗證失敗，已停止發送');
      else if (result.error === 'RATE_LIMIT') this.sessions.mark('ERROR', 'LINE 回報速率限制，已停止發送');
      else if (result.error === 'NETWORK') this.sessions.mark('DISCONNECTED', 'LINE 連線恢復失敗，請稍後重試');
      else if (result.error === 'INVALID_RESPONSE') this.sessions.mark('ERROR', 'LINE 連線恢復回應異常，請查看日誌');
      this.logger.add('SEND_TEXT', result.result, alias, result.error);
      this.onMessageSent();
      return result;
    } finally { this.active = false; }
  }

  async sendImage(alias: string, image: Buffer, mime: 'image/jpeg' | 'image/png'): Promise<SendResult> {
    if (!/^[a-z0-9_-]{1,32}$/.test(alias)) throw new Error('INVALID_TARGET');
    const target = this.contacts.resolve(alias);
    if (!target) throw new Error('TARGET_NOT_ALLOWED');
    if (this.active) throw new Error('SEND_BUSY');
    const now = Date.now();
    this.rate = this.rate.filter(value => now - value < 60_000);
    if (this.rate.length >= this.rateLimit) throw new Error('RATE_LIMITED');
    const fingerprint = createHash('sha256').update(alias).update('\0').update(mime).update('\0').update(image).digest('hex');
    const last = this.recent.get(fingerprint);
    if (last && now - last < this.duplicateWindowMs) throw new Error('DUPLICATE_BLOCKED');
    this.recent.set(fingerprint, now);
    for (const [key, at] of this.recent) if (now - at > this.duplicateWindowMs * 2) this.recent.delete(key);
    this.rate.push(now);
    this.active = true;
    try {
      try {
        await this.client.validate();
        this.sessions.mark('CONNECTED', 'Session 驗證成功');
      } catch (error) {
        const kind = error instanceof LineError ? error.kind : 'NETWORK';
        if (kind === 'AUTH') this.sessions.mark('EXPIRED', 'LINE Session 已失效，需要人工重新授權');
        else if (kind === 'CSRF') this.sessions.mark('ERROR', 'CSRF 驗證失敗，已停止發送');
        else this.sessions.mark('DISCONNECTED', `連線驗證失敗：${kind}`);
        this.logger.add('SEND_IMAGE', 'FAILED', alias, kind);
        throw new Error(`SESSION_${kind}`);
      }
      const result = await this.client.sendImage(target.chatId, image, mime);
      if (result.result === 'SUBMITTED') {
        this.submittedCount += 1;
        this.lastSubmittedAt = new Date().toISOString();
      } else if (result.error === 'AUTH') this.sessions.mark('EXPIRED', 'LINE Session 已失效，需要人工重新授權');
      else if (result.error === 'CSRF') this.sessions.mark('ERROR', 'CSRF 驗證失敗，已停止發送');
      else if (result.error === 'RATE_LIMIT') this.sessions.mark('ERROR', 'LINE 回報速率限制，已停止發送');
      else if (result.error === 'NETWORK') this.sessions.mark('DISCONNECTED', 'LINE 連線恢復失敗，請稍後重試');
      else if (result.error === 'INVALID_RESPONSE') this.sessions.mark('ERROR', 'LINE 連線恢復回應異常，請查看日誌');
      this.logger.add('SEND_IMAGE', result.result, alias, result.error);
      this.onMessageSent();
      return result;
    } finally { this.active = false; }
  }
}
