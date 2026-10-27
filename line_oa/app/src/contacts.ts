import { join } from 'node:path';
import type { AliasMap, Contact, ContactAlias } from './types.js';
import { atomicWriteJson, readJsonSafe } from './storage.js';
import { LineClient } from './line-client.js';

interface ContactCacheFile {
  version: 2;
  accountId: string | null;
  updatedAt: string;
  contacts: Contact[];
}

function validAliases(value: unknown): value is AliasMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => /^[a-z0-9_-]{1,32}$/.test(key) && !!item && typeof item === 'object' &&
    /^[A-Za-z0-9_-]{10,128}$/.test((item as ContactAlias).chatId) && typeof (item as ContactAlias).name === 'string');
}

function validContact(value: unknown): value is Contact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<Contact>;
  return /^[A-Za-z0-9_-]{10,128}$/.test(item.chatId ?? '') && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 100 &&
    (item.kind === 'user' || item.kind === 'group') && typeof item.friend === 'boolean' && typeof item.chatAvailable === 'boolean';
}

function validContactCache(value: unknown): value is ContactCacheFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Partial<ContactCacheFile>;
  return file.version === 2 && (file.accountId === null || typeof file.accountId === 'string' && /^U[0-9a-f]{32}$/.test(file.accountId)) && typeof file.updatedAt === 'string' && Number.isFinite(Date.parse(file.updatedAt)) &&
    Array.isArray(file.contacts) && file.contacts.length <= 10_000 && file.contacts.every(validContact);
}

export class ContactService {
  private cache = new Map<string, { at: number; list: Contact[]; next?: string }>();
  private stored = new Map<string, Contact>();
  private aliases = new Map<string, ContactAlias>();
  private generation = 0;
  private accountId: string | null = null;
  private readonly contactsPath: string;
  private readonly aliasesPath: string;
  public warning?: string;

  constructor(private readonly client: LineClient, dataDir: string, private readonly ttlMs: number,
    private readonly currentAccount: () => string | null = () => null) {
    this.contactsPath = join(dataDir, 'contacts.json');
    this.aliasesPath = join(dataDir, 'aliases.json');
  }

  async load(): Promise<void> {
    const warnings: string[] = [];
    this.accountId = this.currentAccount();
    const aliases = await readJsonSafe(this.aliasesPath, {} as AliasMap, validAliases);
    this.aliases = new Map(Object.entries(aliases.value));
    if (aliases.warning) warnings.push(aliases.warning);

    const contacts = await readJsonSafe<ContactCacheFile | null>(this.contactsPath, null,
      (value): value is ContactCacheFile | null => value === null || validContactCache(value));
    if (contacts.value && contacts.value.accountId === this.accountId) {
      for (const contact of contacts.value.contacts) this.stored.set(contact.chatId, contact);
    } else if (contacts.warning) {
      // Before v0.4.0 contacts.json contained aliases. Migrate it without dropping current aliases.json values.
      const legacy = await readJsonSafe<AliasMap | null>(this.contactsPath, null,
        (value): value is AliasMap | null => value === null || validAliases(value));
      if (legacy.value && !legacy.warning) {
        this.aliases = new Map([...Object.entries(legacy.value), ...this.aliases]);
        await atomicWriteJson(this.aliasesPath, this.getAliases());
      } else {
        warnings.push(contacts.warning);
      }
    }

    if (!aliases.warning && this.aliases.size === 0) await atomicWriteJson(this.aliasesPath, {});
    await this.persistContacts();
    this.warning = warnings.length ? warnings.join(';') : undefined;
  }

  async search(query = '', force = false, next?: string): Promise<{ list: Contact[]; next?: string; cached: boolean }> {
    if (query.length > 100 || (next && next.length > 500)) throw new Error('INVALID_INPUT');
    await this.syncAccount();
    const key = `${query}\n${next ?? ''}`;
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < this.ttlMs) return { list: cached.list, next: cached.next, cached: true };
    const generation = this.generation;
    const result = await this.client.getContacts(query, 20, next);
    if (generation !== this.generation || this.currentAccount() !== this.accountId) throw new Error('SESSION_CHANGED');
    this.cache.set(key, { at: Date.now(), ...result });
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value as string);
    for (const contact of result.list) this.stored.set(contact.chatId, contact);
    while (this.stored.size > 10_000) this.stored.delete(this.stored.keys().next().value!);
    await this.persistContacts();
    if (generation !== this.generation || this.currentAccount() !== this.accountId) throw new Error('SESSION_CHANGED');
    return { ...result, cached: false };
  }

  async syncAccount(): Promise<void> {
    if (this.accountId === this.currentAccount()) return;
    this.accountId = this.currentAccount();
    await this.clearCache();
  }

  async clearCache(): Promise<void> {
    ++this.generation;
    this.cache.clear();
    this.stored.clear();
    await this.persistContacts();
  }

  allCached(): Contact[] { return this.accountId === this.currentAccount() ? [...this.stored.values()] : []; }
  count(): number { return this.accountId === this.currentAccount() ? this.stored.size : 0; }
  getAliases(): AliasMap { return structuredClone(Object.fromEntries(this.aliases)); }
  listAliases(): Array<{ alias: string; name: string; type: 'user' | 'group' | 'unknown' }> {
    return [...this.aliases].map(([alias, value]) => ({
      alias,
      name: value.name,
      type: this.accountId === this.currentAccount() ? this.stored.get(value.chatId)?.kind ?? 'unknown' : 'unknown'
    }));
  }
  resolve(alias: string): ContactAlias | undefined { return this.aliases.get(alias); }

  async setAlias(alias: string, chatId: string): Promise<void> {
    if (!/^[a-z0-9_-]{1,32}$/.test(alias)) throw new Error('INVALID_ALIAS');
    await this.syncAccount();
    const contact = this.stored.get(chatId);
    if (!contact) throw new Error('CONTACT_NOT_IN_CACHE');
    this.aliases.set(alias, { chatId, name: contact.name });
    await atomicWriteJson(this.aliasesPath, this.getAliases());
  }

  async deleteAlias(alias: string): Promise<void> {
    this.aliases.delete(alias);
    await atomicWriteJson(this.aliasesPath, this.getAliases());
  }

  private async persistContacts(): Promise<void> {
    await atomicWriteJson(this.contactsPath, { version: 2, accountId: this.accountId,
      updatedAt: new Date().toISOString(), contacts: this.allCached() } satisfies ContactCacheFile);
  }
}
