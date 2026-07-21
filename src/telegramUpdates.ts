import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareFn, Telegram } from 'telegraf';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';
import type { BotContext, BotSession } from './types.js';

type UpdateState = 'processing' | 'retryable' | 'completed' | 'uncertain';
type EffectState = 'claimed' | 'completed' | 'uncertain';

interface UpdateEffect {
  state: EffectState;
  ownerToken: string;
  claimedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

interface UpdateRecord {
  updateId: number;
  fingerprint: string;
  state: UpdateState;
  ownerToken: string;
  ownerPid: number;
  ownerInstanceId: string;
  claimedAt: string;
  leaseUntil: string;
  attempts: number;
  effects: Record<string, UpdateEffect>;
  update?: unknown;
  nextRetryAt?: string;
  completedAt?: string;
  lastError?: string;
  sessionKey?: string;
}

interface SessionClaim {
  updateId: number;
  ownerToken: string;
  ownerPid: number;
  ownerInstanceId: string;
  state: 'processing' | 'reserved';
}

interface UpdateDatabase {
  updates: UpdateRecord[];
  sessions: Record<string, BotSession>;
  sessionUpdatedAt: Record<string, string>;
  sessionClaims: Record<string, SessionClaim>;
}

export interface TelegramUpdateJournalOptions {
  leaseMs?: number;
  maxCompletedUpdates?: number;
  now?: () => Date;
  tokenFactory?: () => string;
  processAlive?: (pid: number) => boolean;
  instanceId?: string;
  terminalRetentionMs?: number;
}

type ClaimResult =
  | { status: 'claimed'; token: string }
  | { status: 'duplicate' | 'busy' | 'uncertain' };

type EffectClaim =
  | { status: 'execute' }
  | { status: 'completed'; result: unknown }
  | { status: 'uncertain'; error?: string };

interface UpdateScope {
  updateId: number;
  token: string;
  journal: TelegramUpdateJournal;
  telegramOccurrences: Map<string, number>;
  sessionMutations: Map<string, BotSession | null>;
  routeKey: string;
}

const updateScope = new AsyncLocalStorage<UpdateScope>();
const telegramCallLabelScope = new AsyncLocalStorage<string>();
const PROCESS_INSTANCE_ID = randomUUID();
const installedTelegrams = new WeakSet<object>();
const MAX_RETRY_ATTEMPTS = 10;
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class IndeterminateTelegramEffectError extends Error {
  constructor(readonly updateId: number, readonly effectKey: string, reason?: string) {
    super(`Telegram effect outcome is uncertain for update ${updateId}: ${effectKey}${reason ? ` (${reason})` : ''}`);
    this.name = 'IndeterminateTelegramEffectError';
  }
}

export class TelegramUpdateJournal {
  private readonly leaseMs: number;
  private readonly maxCompletedUpdates: number;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly processAlive: (pid: number) => boolean;
  private readonly instanceId: string;
  private readonly terminalRetentionMs: number;

  constructor(private readonly filePath: string, options: TelegramUpdateJournalOptions = {}) {
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.maxCompletedUpdates = options.maxCompletedUpdates ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.processAlive = options.processAlive ?? isProcessAlive;
    this.instanceId = options.instanceId ?? PROCESS_INSTANCE_ID;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 7 * 24 * 60 * 60_000;
  }

  async claim(updateId: number, fingerprint: string, update?: unknown, sessionKey?: string): Promise<ClaimResult> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('Telegram update_id must be a non-negative safe integer.');
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      pruneTerminal(db, this.maxCompletedUpdates, this.terminalRetentionMs, this.now());
      pruneSessions(db, this.now(), SESSION_RETENTION_MS);
      const existing = db.updates.find((record) => record.updateId === updateId);
      if (existing && existing.fingerprint !== fingerprint) throw new Error(`Telegram update_id ${updateId} fingerprint mismatch.`);
      if (existing?.state === 'completed') return { status: 'duplicate' };
      if (existing?.state === 'uncertain') return { status: 'uncertain' };
      const now = this.now();
      if (existing?.state === 'retryable' && existing.nextRetryAt && new Date(existing.nextRetryAt) > now) return { status: 'busy' };
      if (existing?.state === 'processing' && this.ownerIsAlive(existing)) return { status: 'busy' };

      const sessionOwner = sessionKey ? db.sessionClaims[sessionKey] : undefined;
      if (sessionOwner && sessionOwner.updateId !== updateId) {
        queueBehindSession(db, updateId, fingerprint, update, sessionKey!, now, this.instanceId, this.tokenFactory());
        await atomicWriteJson(this.filePath, db);
        return { status: 'busy' };
      }
      if (sessionKey && sessionOwner) delete db.sessionClaims[sessionKey];

      const token = this.tokenFactory();
      if (existing) {
        existing.ownerToken = token;
        existing.ownerPid = process.pid;
        existing.ownerInstanceId = this.instanceId;
        existing.claimedAt = now.toISOString();
        existing.leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString();
        existing.attempts += 1;
        existing.lastError = undefined;
        existing.nextRetryAt = undefined;
        existing.state = 'processing';
        existing.sessionKey = sessionKey;
        if (update !== undefined) existing.update = toJsonValue(update);
      } else {
        db.updates.push({
          updateId,
          fingerprint,
          state: 'processing',
          ownerToken: token,
          ownerPid: process.pid,
          ownerInstanceId: this.instanceId,
          claimedAt: now.toISOString(),
          leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
          attempts: 1,
          effects: {},
          update: update === undefined ? undefined : toJsonValue(update),
          sessionKey,
        });
      }
      if (sessionKey) db.sessionClaims[sessionKey] = { updateId, ownerToken: token, ownerPid: process.pid, ownerInstanceId: this.instanceId, state: 'processing' };
      pruneTerminal(db, this.maxCompletedUpdates, this.terminalRetentionMs, now);
      await atomicWriteJson(this.filePath, db);
      return { status: 'claimed', token };
    });
  }

  async complete(updateId: number, token: string, sessionMutations: Map<string, BotSession | null> = new Map()): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      for (const [key, value] of sessionMutations) {
        if (value === null) { delete db.sessions[key]; delete db.sessionUpdatedAt[key]; }
        else { db.sessions[key] = value; db.sessionUpdatedAt[key] = this.now().toISOString(); }
      }
      const uncertainEffect = Object.values(record.effects).find((effect) => effect.state === 'uncertain');
      record.state = uncertainEffect ? 'uncertain' : 'completed';
      record.completedAt = this.now().toISOString();
      record.leaseUntil = record.completedAt;
      record.update = undefined;
      if (uncertainEffect?.error) record.lastError = uncertainEffect.error;
      releaseSessionClaim(db, record, token);
      pruneTerminal(db, this.maxCompletedUpdates, this.terminalRetentionMs, this.now());
      await atomicWriteJson(this.filePath, db);
    });
  }

  async markUncertain(updateId: number, token: string, error: string): Promise<void> {
    await this.finish(updateId, token, 'uncertain', error);
  }

  async releaseForRetry(updateId: number, token: string, error: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      record.lastError = error;
      if (record.attempts >= MAX_RETRY_ATTEMPTS) {
        record.state = 'uncertain';
        record.completedAt = this.now().toISOString();
        record.leaseUntil = record.completedAt;
        record.update = undefined;
        releaseSessionClaim(db, record, token);
      } else {
        record.state = 'retryable';
        const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, record.attempts - 1));
        record.nextRetryAt = new Date(this.now().getTime() + delayMs).toISOString();
        record.leaseUntil = this.now().toISOString();
      }
      pruneTerminal(db, this.maxCompletedUpdates, this.terminalRetentionMs, this.now());
      await atomicWriteJson(this.filePath, db);
    });
  }

  async recoverableUpdates(): Promise<unknown[]> {
    const db = await this.read();
    const now = this.now();
    return db.updates
      .filter((record) => record.update !== undefined && (
        (record.state === 'retryable' && (!record.nextRetryAt || new Date(record.nextRetryAt) <= now))
        || (record.state === 'processing' && !this.ownerIsAlive(record))
      ))
      .map((record) => record.update);
  }

  async getSession(key: string): Promise<BotSession | undefined> {
    const db = await this.read();
    const updatedAt = db.sessionUpdatedAt[key];
    if (updatedAt && new Date(updatedAt).getTime() < this.now().getTime() - SESSION_RETENTION_MS) return undefined;
    return db.sessions[key];
  }
  async setSession(key: string, value: BotSession | null): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      pruneSessions(db, this.now(), SESSION_RETENTION_MS);
      if (value === null) { delete db.sessions[key]; delete db.sessionUpdatedAt[key]; }
      else { db.sessions[key] = value; db.sessionUpdatedAt[key] = this.now().toISOString(); }
      await atomicWriteJson(this.filePath, db);
    });
  }

  async claimEffect(updateId: number, token: string, effectKey: string): Promise<EffectClaim> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      const existing = record.effects[effectKey];
      if (existing?.state === 'completed') return { status: 'completed', result: existing.result };
      if (existing?.state === 'uncertain') return { status: 'uncertain', error: existing.error };
      if (existing) {
        existing.state = 'uncertain';
        existing.error = 'A previous process stopped after claiming this Telegram effect; automatic resend is blocked.';
        record.lastError = existing.error;
        await atomicWriteJson(this.filePath, db);
        return { status: 'uncertain', error: existing.error };
      }
      record.effects[effectKey] = {
        state: 'claimed',
        ownerToken: token,
        claimedAt: this.now().toISOString(),
      };
      await atomicWriteJson(this.filePath, db);
      return { status: 'execute' };
    });
  }

  async completeEffect(updateId: number, token: string, effectKey: string, result: unknown): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      const effect = record.effects[effectKey];
      if (!effect || effect.ownerToken !== token || effect.state !== 'claimed') throw new Error(`Telegram effect ownership lost: ${effectKey}`);
      effect.state = 'completed';
      effect.completedAt = this.now().toISOString();
      effect.result = toJsonValue(result);
      await atomicWriteJson(this.filePath, db);
    });
  }

  async markEffectUncertain(updateId: number, token: string, effectKey: string, error: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      const effect = record.effects[effectKey];
      if (effect?.ownerToken === token && effect.state === 'claimed') {
        effect.state = 'uncertain';
        effect.error = error;
        record.lastError = error;
        await atomicWriteJson(this.filePath, db);
      }
    });
  }

  async releaseEffectForRetry(updateId: number, token: string, effectKey: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      const effect = record.effects[effectKey];
      if (!effect || effect.ownerToken !== token || effect.state !== 'claimed') throw new Error(`Telegram effect ownership lost: ${effectKey}`);
      delete record.effects[effectKey];
      await atomicWriteJson(this.filePath, db);
    });
  }

  async snapshot(): Promise<UpdateDatabase> { return this.read(); }

  private async finish(updateId: number, token: string, state: 'completed' | 'uncertain', error?: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const record = ownedRecord(db, updateId, token);
      record.state = state;
      record.completedAt = this.now().toISOString();
      record.leaseUntil = record.completedAt;
      record.lastError = error;
      record.update = undefined;
      releaseSessionClaim(db, record, token);
      pruneTerminal(db, this.maxCompletedUpdates, this.terminalRetentionMs, this.now());
      await atomicWriteJson(this.filePath, db);
    });
  }

  private async read(): Promise<UpdateDatabase> {
    const parsed = await readJson<Partial<UpdateDatabase>>(this.filePath, { updates: [], sessions: {}, sessionUpdatedAt: {}, sessionClaims: {} });
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const sessionUpdatedAt = parsed.sessionUpdatedAt && typeof parsed.sessionUpdatedAt === 'object' ? parsed.sessionUpdatedAt : {};
    const fallbackTimestamp = this.now().toISOString();
    for (const key of Object.keys(sessions)) if (!sessionUpdatedAt[key]) sessionUpdatedAt[key] = fallbackTimestamp;
    const sessionClaims = parsed.sessionClaims && typeof parsed.sessionClaims === 'object' ? parsed.sessionClaims : {};
    return { updates: Array.isArray(parsed.updates) ? parsed.updates : [], sessions, sessionUpdatedAt, sessionClaims };
  }

  private ownerIsAlive(record: Pick<UpdateRecord, 'ownerInstanceId' | 'ownerPid'>): boolean {
    if (record.ownerInstanceId === this.instanceId) return true;
    if (record.ownerPid === process.pid) return false;
    return this.processAlive(record.ownerPid);
  }
}

export class JsonTelegramSessionStore {
  constructor(private readonly journal: TelegramUpdateJournal) {}

  async get(key: string): Promise<BotSession | undefined> {
    const scope = updateScope.getStore();
    if (scope?.journal === this.journal && scope.sessionMutations.has(key)) return scope.sessionMutations.get(key) ?? undefined;
    return this.journal.getSession(key);
  }

  async set(key: string, value: BotSession): Promise<void> {
    const scope = updateScope.getStore();
    if (scope?.journal === this.journal) { scope.sessionMutations.set(key, value); return; }
    await this.journal.setSession(key, value);
  }

  async delete(key: string): Promise<void> {
    const scope = updateScope.getStore();
    if (scope?.journal === this.journal) { scope.sessionMutations.set(key, null); return; }
    await this.journal.setSession(key, null);
  }
}

export function createTelegramUpdateMiddleware(journal: TelegramUpdateJournal): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const claim = await journal.claim(updateId, fingerprintUpdate(ctx.update), ctx.update, telegramSessionKey(ctx));
    if (claim.status !== 'claimed') return;
    installIdempotentTelegramApi(ctx.telegram as unknown as Telegram);
    const scope: UpdateScope = { updateId, token: claim.token, journal, telegramOccurrences: new Map(), sessionMutations: new Map(), routeKey: telegramUpdateRoute(ctx.update) };
    try {
      await updateScope.run(scope, next);
      await journal.complete(updateId, claim.token, scope.sessionMutations);
    } catch (error) {
      const message = safeError(error);
      if (error instanceof IndeterminateTelegramEffectError) await journal.markUncertain(updateId, claim.token, message);
      else await journal.releaseForRetry(updateId, claim.token, message);
      throw error;
    }
  };
}

export function currentUpdateIdempotencyKey(label: string): string | undefined {
  const scope = updateScope.getStore();
  return scope ? `telegram-update:${scope.updateId}:${label}` : undefined;
}

export function withTelegramCallLabel<T>(label: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(label)) throw new Error('Telegram call label must be a stable non-empty identifier.');
  return telegramCallLabelScope.run(label, operation);
}

export async function runCurrentUpdateEffect<T>(label: string, operation: () => Promise<T>, options: { outcomeIsUncertain?: (error: unknown) => boolean } = {}): Promise<T> {
  const scope = updateScope.getStore();
  if (!scope) return operation();
  const effectKey = `side-effect:${label}`;
  const claim = await scope.journal.claimEffect(scope.updateId, scope.token, effectKey);
  if (claim.status === 'completed') return claim.result as T;
  if (claim.status === 'uncertain') throw new IndeterminateTelegramEffectError(scope.updateId, effectKey, claim.error);
  try {
    const result = await operation();
    await scope.journal.completeEffect(scope.updateId, scope.token, effectKey, result);
    return result;
  } catch (error) {
    const reason = safeError(error);
    if (options.outcomeIsUncertain && !options.outcomeIsUncertain(error)) {
      await scope.journal.releaseEffectForRetry(scope.updateId, scope.token, effectKey);
      throw error;
    }
    await scope.journal.markEffectUncertain(scope.updateId, scope.token, effectKey, reason);
    throw new IndeterminateTelegramEffectError(scope.updateId, effectKey, reason);
  }
}

export function installIdempotentTelegramApi(telegram: Telegram): void {
  if (installedTelegrams.has(telegram as object)) return;
  installedTelegrams.add(telegram as object);
  const original = telegram.callApi.bind(telegram);
  telegram.callApi = (async (method: Parameters<Telegram['callApi']>[0], payload: Parameters<Telegram['callApi']>[1], options?: Parameters<Telegram['callApi']>[2]) => {
    const scope = updateScope.getStore();
    if (!scope) return original(method, payload, options as never);
    const logicalLabel = telegramCallLabelScope.getStore() ?? `route:${scope.routeKey}:${String(method)}`;
    const baseKey = `${String(method)}:${hashLabel(logicalLabel)}:${telegramTargetHash(payload)}`;
    const occurrence = scope.telegramOccurrences.get(baseKey) ?? 0;
    scope.telegramOccurrences.set(baseKey, occurrence + 1);
    const effectKey = `telegram:${baseKey}:${occurrence}`;
    const claim = await scope.journal.claimEffect(scope.updateId, scope.token, effectKey);
    if (claim.status === 'completed') return claim.result as never;
    if (claim.status === 'uncertain') throw new IndeterminateTelegramEffectError(scope.updateId, effectKey);
    try {
      const result = await original(method, payload, options as never);
      await scope.journal.completeEffect(scope.updateId, scope.token, effectKey, telegramJournalResult(result));
      return result;
    } catch (error) {
      const reason = safeError(error);
      await scope.journal.markEffectUncertain(scope.updateId, scope.token, effectKey, reason);
      throw new IndeterminateTelegramEffectError(scope.updateId, effectKey, reason);
    }
  }) as Telegram['callApi'];
}

export function startTelegramUpdateRecovery(bot: { handleUpdate(update: never): Promise<unknown> }, journal: TelegramUpdateJournal, intervalMs = 1_000): NodeJS.Timeout {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const update of await journal.recoverableUpdates()) await bot.handleUpdate(update as never);
    } catch (error) {
      console.error('Telegram update recovery failed:', safeError(error));
    } finally { running = false; }
  };
  void run();
  return setInterval(run, intervalMs);
}

export function fingerprintUpdate(update: unknown): string {
  return createHash('sha256').update(stableJson(update)).digest('hex');
}

export function telegramUpdateTimestamp(update: unknown, fallback = new Date()): string {
  const value = update as { message?: { date?: unknown }; edited_message?: { date?: unknown }; channel_post?: { date?: unknown }; callback_query?: { message?: { date?: unknown } } };
  const seconds = value.message?.date ?? value.edited_message?.date ?? value.channel_post?.date ?? value.callback_query?.message?.date;
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 ? new Date(seconds * 1000).toISOString() : fallback.toISOString();
}

function ownedRecord(db: UpdateDatabase, updateId: number, token: string): UpdateRecord {
  const record = db.updates.find((item) => item.updateId === updateId);
  if (!record || record.ownerToken !== token || record.state !== 'processing') throw new Error(`Telegram update ownership lost: ${updateId}`);
  return record;
}

function queueBehindSession(db: UpdateDatabase, updateId: number, fingerprint: string, update: unknown, sessionKey: string, now: Date, instanceId: string, token: string): void {
  const existing = db.updates.find((record) => record.updateId === updateId);
  const nextRetryAt = new Date(now.getTime() + 1_000).toISOString();
  if (existing) {
    existing.state = 'retryable';
    existing.nextRetryAt = nextRetryAt;
    existing.update = update === undefined ? existing.update : toJsonValue(update);
    existing.sessionKey = sessionKey;
    existing.ownerToken = token;
    existing.ownerPid = process.pid;
    existing.ownerInstanceId = instanceId;
    return;
  }
  db.updates.push({
    updateId,
    fingerprint,
    state: 'retryable',
    ownerToken: token,
    ownerPid: process.pid,
    ownerInstanceId: instanceId,
    claimedAt: now.toISOString(),
    leaseUntil: now.toISOString(),
    attempts: 0,
    effects: {},
    update: update === undefined ? undefined : toJsonValue(update),
    nextRetryAt,
    sessionKey,
  });
}

function releaseSessionClaim(db: UpdateDatabase, record: UpdateRecord, token: string): void {
  if (!record.sessionKey) return;
  const claim = db.sessionClaims[record.sessionKey];
  if (claim?.updateId !== record.updateId || claim.ownerToken !== token) return;
  delete db.sessionClaims[record.sessionKey];
  const queued = db.updates.find((item) => item.updateId !== record.updateId && item.sessionKey === record.sessionKey && item.state === 'retryable' && item.update !== undefined);
  if (queued) db.sessionClaims[record.sessionKey] = { updateId: queued.updateId, ownerToken: queued.ownerToken, ownerPid: queued.ownerPid, ownerInstanceId: queued.ownerInstanceId, state: 'reserved' };
}

function telegramSessionKey(ctx: BotContext): string | undefined {
  const context = ctx as unknown as { from?: { id?: unknown }; chat?: { id?: unknown } };
  return typeof context.from?.id === 'number' && typeof context.chat?.id === 'number' ? `${context.from.id}:${context.chat.id}` : sessionKeyFromUpdate(ctx.update);
}

function sessionKeyFromUpdate(update: unknown): string | undefined {
  const value = update as Record<string, unknown>;
  const body = (value.message ?? value.edited_message ?? value.channel_post ?? value.edited_channel_post) as { from?: { id?: unknown }; chat?: { id?: unknown } } | undefined;
  const callback = value.callback_query as { from?: { id?: unknown }; message?: { chat?: { id?: unknown } } } | undefined;
  const fromId = body?.from?.id ?? callback?.from?.id;
  const chatId = body?.chat?.id ?? callback?.message?.chat?.id;
  return typeof fromId === 'number' && typeof chatId === 'number' ? `${fromId}:${chatId}` : undefined;
}

function pruneTerminal(db: UpdateDatabase, maxTerminal: number, retentionMs: number, now: Date): void {
  const cutoff = now.getTime() - retentionMs;
  const terminal = db.updates
    .filter((record) => record.state === 'completed' || record.state === 'uncertain')
    .filter((record) => !record.completedAt || new Date(record.completedAt).getTime() >= cutoff)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const keep = new Set(terminal.slice(0, maxTerminal).map((record) => record.updateId));
  db.updates = db.updates.filter((record) => (record.state !== 'completed' && record.state !== 'uncertain') || keep.has(record.updateId));
}

function pruneSessions(db: UpdateDatabase, now: Date, retentionMs: number): void {
  const cutoff = now.getTime() - retentionMs;
  for (const [key, updatedAt] of Object.entries(db.sessionUpdatedAt)) {
    if (new Date(updatedAt).getTime() < cutoff) { delete db.sessions[key]; delete db.sessionUpdatedAt[key]; }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function telegramJournalResult(result: unknown): unknown {
  if (typeof result === 'boolean' || typeof result === 'number' || result === null) return result;
  if (result && typeof result === 'object') {
    const messageId = (result as { message_id?: unknown }).message_id;
    if (Number.isSafeInteger(messageId)) return { message_id: messageId };
  }
  return null;
}

function telegramTargetHash(payload: unknown): string {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const target = {
    chat_id: value.chat_id,
    user_id: value.user_id,
    message_id: value.message_id,
    callback_query_id: value.callback_query_id,
    inline_query_id: value.inline_query_id,
  };
  const hasTarget = Object.values(target).some((item) => item !== undefined);
  return createHash('sha256').update(stableJson(hasTarget ? target : payload)).digest('hex');
}

function telegramUpdateRoute(update: unknown): string {
  const value = update as Record<string, unknown>;
  const callbackData = (value.callback_query as { data?: unknown } | undefined)?.data;
  if (typeof callbackData === 'string') return hashLabel(`callback:${callbackData}`);
  const message = value.message as { text?: unknown; contact?: unknown; photo?: unknown } | undefined;
  if (typeof message?.text === 'string' && message.text.startsWith('/')) return hashLabel(`command:${message.text.slice(1).split(/[\s@]/, 1)[0].toLowerCase()}`);
  if (message?.contact) return hashLabel('message:contact');
  if (message?.photo) return hashLabel('message:photo');
  if (message) return hashLabel('message:text');
  return hashLabel(`update:${Object.keys(value).filter((key) => key !== 'update_id').sort()[0] ?? 'unknown'}`);
}

function hashLabel(label: string): string { return createHash('sha256').update(label).digest('hex'); }

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
