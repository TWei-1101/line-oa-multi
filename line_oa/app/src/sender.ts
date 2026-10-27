import { createHash } from 'node:crypto';
import type { SendResult } from './types.js';
import { ContactService } from './contacts.js';
import { LineClient, LineError } from './line-client.js';
import { SessionManager } from './session.js';
import { MemoryLogger } from './logger.js';
import { SendQueue, type SendQueueOptions } from './send-queue.js';
import { ImageSender } from './images.js';

export class MessageSender {
  private recent = new Map<string, number>();
  private pendingFingerprints = new Set<string>();
  private rate: number[] = [];
  private readonly queue: SendQueue;
  public submittedCount = 0;
  public lastSubmittedAt?: string;

  constructor(private readonly client: LineClient, private readonly sessions: SessionManager, private readonly contacts: ContactService,
    private readonly logger: MemoryLogger, private readonly duplicateWindowMs: number, private readonly rateLimit: number,
    private readonly onMessageSent: () => void = () => {}, queueOptions: SendQueueOptions = {},
    private readonly images?: ImageSender, private readonly preflightEnabled: () => boolean = () => true) {
    this.queue = new SendQueue(queueOptions);
  }

  isBusy(): boolean { return this.queue.isBusy(); }
  stop(): void { this.queue.stop(); }

  async send(alias: string, message: string, expectedTargetOrSignal?: string | AbortSignal,
    signal?: AbortSignal): Promise<SendResult> {
    if (!/^[a-z0-9_-]{1,32}$/.test(alias)) throw new Error('INVALID_TARGET');
    if (typeof message !== 'string' || !message.trim() || message.length > 5000 || /\u0000/.test(message)) throw new Error('INVALID_MESSAGE');
    const expectedTarget = typeof expectedTargetOrSignal === 'string' ? expectedTargetOrSignal : undefined;
    const requestSignal = typeof expectedTargetOrSignal === 'string' ? signal : expectedTargetOrSignal;
    const fingerprint = createHash('sha256').update(`${alias}\0${message}`).digest('hex');
    return this.enqueue(alias, fingerprint, Buffer.byteLength(message), 'SEND_TEXT',
      chatId => this.client.sendText(chatId, message), expectedTarget, requestSignal);
  }

  async sendImage(alias: string, image: Buffer, mime: 'image/jpeg' | 'image/png',
    expectedTargetOrSignal?: string | AbortSignal, signal?: AbortSignal): Promise<SendResult> {
    if (!/^[a-z0-9_-]{1,32}$/.test(alias)) throw new Error('INVALID_TARGET');
    const expectedTarget = typeof expectedTargetOrSignal === 'string' ? expectedTargetOrSignal : undefined;
    const requestSignal = typeof expectedTargetOrSignal === 'string' ? signal : expectedTargetOrSignal;
    const credentials = this.sessions.getCredentials();
    const fingerprint = createHash('sha256').update(alias).update('\0').update(mime).update('\0').update(image).digest('hex');
    return this.enqueue(alias, fingerprint, image.length, 'SEND_IMAGE', async chatId => {
      // Stage only at the head of the FIFO, not while waiting behind another job.
      if (!this.images) return this.client.sendImage(chatId, image, mime);
      const staged = await this.images.stage(image, mime);
      try {
        if (this.sessions.getCredentials() !== credentials) throw new Error('SEND_CONTEXT_CHANGED');
        const current = this.contacts.resolve(alias);
        if (!current) throw new Error('TARGET_NOT_ALLOWED');
        if (current.chatId !== chatId) throw new Error(expectedTarget ? 'TARGET_CHANGED' : 'TARGET_NOT_ALLOWED');
        return await this.client.sendImage(chatId, image, mime);
      } finally { await this.images.remove(staged); }
    }, expectedTarget, requestSignal);
  }

  private async enqueue(alias: string, fingerprint: string, bytes: number, operation: string,
    deliver: (chatId: string) => Promise<SendResult>, expectedTarget?: string, signal?: AbortSignal): Promise<SendResult> {
    const target = this.contacts.resolve(alias);
    if (!target) throw new Error('TARGET_NOT_ALLOWED');
    const targetChatId = target.chatId;
    if (expectedTarget !== undefined && expectedTarget !== targetChatId) throw new Error('TARGET_CHANGED');
    if (this.pendingFingerprints.has(fingerprint) || this.isDuplicate(fingerprint)) throw new Error('DUPLICATE_BLOCKED');
    const credentials = this.sessions.getCredentials();
    this.pendingFingerprints.add(fingerprint);
    try {
      return await this.queue.run(async () => {
        // Do not send to a new account or a changed/revoked alias after waiting.
        if (this.sessions.getCredentials() !== credentials) throw new Error('SEND_CONTEXT_CHANGED');
        const current = this.contacts.resolve(alias);
        if (!current) throw new Error('TARGET_NOT_ALLOWED');
        if (current.chatId !== targetChatId) throw new Error(expectedTarget ? 'TARGET_CHANGED' : 'TARGET_NOT_ALLOWED');
        const now = Date.now();
        this.rate = this.rate.filter(value => now - value < 60_000);
        if (this.rateLimit > 0 && this.rate.length >= this.rateLimit) throw new Error('RATE_LIMITED');
        if (this.isDuplicate(fingerprint)) throw new Error('DUPLICATE_BLOCKED');
        this.recent.set(fingerprint, now);
        for (const [key, at] of this.recent) if (now - at > this.duplicateWindowMs * 2) this.recent.delete(key);
        if (this.rateLimit > 0) this.rate.push(now);
        try {
          if (this.preflightEnabled()) await this.client.validate('send');
          if (this.preflightEnabled()) this.sessions.mark('CONNECTED', 'Session 驗證成功');
        } catch (error) {
          if (this.sessions.getCredentials() !== credentials) throw new Error('SEND_CONTEXT_CHANGED');
          const kind = error instanceof LineError ? error.kind : 'NETWORK';
          if (kind === 'AUTH') this.sessions.mark('EXPIRED', 'LINE Session 已失效，需要人工重新授權');
          else if (kind === 'CSRF') this.sessions.mark('ERROR', 'CSRF 驗證失敗，已停止發送');
          else this.sessions.mark('DISCONNECTED', `連線驗證失敗：${kind}`);
          this.logger.add(operation, 'FAILED', alias, kind);
          throw new Error(`SESSION_${kind}`);
        }
        if (this.sessions.getCredentials() !== credentials) throw new Error('SEND_CONTEXT_CHANGED');
        const beforeSend = this.contacts.resolve(alias);
        if (!beforeSend) throw new Error('TARGET_NOT_ALLOWED');
        if (beforeSend.chatId !== targetChatId) throw new Error(expectedTarget ? 'TARGET_CHANGED' : 'TARGET_NOT_ALLOWED');
        const result = await deliver(beforeSend.chatId);
        if (result.result === 'SUBMITTED' || result.result === 'CONFIRMED') {
          this.sessions.mark('CONNECTED', 'LINE 訊息提交成功');
          this.submittedCount += 1;
          this.lastSubmittedAt = new Date().toISOString();
        } else if (result.error === 'AUTH') this.sessions.mark('EXPIRED', 'LINE Session 已失效，需要人工重新授權');
        else if (result.error === 'CSRF') this.sessions.mark('ERROR', 'CSRF 驗證失敗，已停止發送');
        else if (result.error === 'RATE_LIMIT') this.sessions.mark('ERROR', 'LINE 回報速率限制，已停止發送');
        else if (result.error === 'NETWORK') this.sessions.mark('DISCONNECTED', 'LINE 連線恢復失敗，請稍後重試');
        else if (result.error === 'INVALID_RESPONSE') this.sessions.mark('ERROR', 'LINE 連線恢復回應異常，請查看日誌');
        this.logger.add(operation, result.result, alias, result.error);
        this.onMessageSent();
        return result;
      }, bytes, signal);
    } finally { this.pendingFingerprints.delete(fingerprint); }
  }

  private isDuplicate(fingerprint: string): boolean {
    const last = this.recent.get(fingerprint);
    return last !== undefined && Date.now() - last < this.duplicateWindowMs;
  }
}
