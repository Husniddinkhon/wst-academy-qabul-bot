import { createHash } from 'node:crypto';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';
import type { JsonChannelPostStore } from './channelPosts.js';
import type { ChannelSender } from './channelPublisher.js';

const ALERT_LEASE_MS = 2 * 60_000;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const CHANNEL_FAILURE_ACTION_WINDOW_MS = 24 * 60 * 60_000;

interface RecipientState {
  attempts: number;
  deliveredAt?: string;
  nextAttemptAt?: string;
  leaseUntil?: string;
}

interface AlertRecord {
  createdAt: string;
  recipients: Record<string, RecipientState>;
}

interface AlertDatabase {
  records: Record<string, AlertRecord>;
  groups: Record<string, { lastDeliveredAt: string }>;
}

export interface OperationalAlertRequest {
  key: string;
  message: string;
  adminIds: number[];
  sender: (adminId: number, message: string) => Promise<void>;
  store: JsonOperationalAlertStore;
  now?: Date;
  cooldownGroup?: string;
  cooldownMs?: number;
}

export interface OperationalAlertResult {
  attempted: number;
  sent: number;
  failed: number;
  suppressed: boolean;
}

export interface OperationalAlertStats {
  records: number;
  recipientsDelivered: number;
  recipientsPending: number;
  recipientsReady: number;
}

export class JsonOperationalAlertStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async claim(
    key: string,
    recipientKeys: string[],
    now: Date,
    cooldownGroup?: string,
    cooldownMs = 0,
  ): Promise<{ claimed: string[]; suppressed: boolean }> {
    return this.mutate((db) => {
      pruneDeliveredHistory(db, now);
      const existingRecord = db.records[key];
      const group = cooldownGroup ? db.groups[cooldownGroup] : undefined;
      if (!existingRecord && group && now.getTime() - new Date(group.lastDeliveredAt).getTime() < cooldownMs) {
        return { claimed: [], suppressed: true };
      }
      const record = existingRecord ?? { createdAt: now.toISOString(), recipients: {} };
      db.records[key] = record;
      const claimed: string[] = [];
      for (const recipientKey of recipientKeys) {
        const recipient = record.recipients[recipientKey] ?? { attempts: 0 };
        record.recipients[recipientKey] = recipient;
        if (recipient.deliveredAt) continue;
        if (recipient.leaseUntil && new Date(recipient.leaseUntil) > now) continue;
        if (recipient.nextAttemptAt && new Date(recipient.nextAttemptAt) > now) continue;
        recipient.attempts += 1;
        recipient.leaseUntil = new Date(now.getTime() + ALERT_LEASE_MS).toISOString();
        claimed.push(recipientKey);
      }
      return { claimed, suppressed: false };
    });
  }

  async finish(
    key: string,
    recipientKey: string,
    delivered: boolean,
    now: Date,
    cooldownGroup?: string,
  ): Promise<void> {
    await this.mutate((db) => {
      const recipient = db.records[key]?.recipients[recipientKey];
      if (!recipient) return;
      delete recipient.leaseUntil;
      if (delivered) {
        recipient.deliveredAt = now.toISOString();
        delete recipient.nextAttemptAt;
        if (cooldownGroup) db.groups[cooldownGroup] = { lastDeliveredAt: now.toISOString() };
      } else {
        const retryMs = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.max(0, recipient.attempts - 1)));
        recipient.nextAttemptAt = new Date(now.getTime() + retryMs).toISOString();
      }
    });
  }

  async snapshot(): Promise<AlertDatabase> {
    return this.read();
  }

  async stats(now = new Date()): Promise<OperationalAlertStats> {
    const db = await this.read();
    const recipients = Object.values(db.records).flatMap((record) => Object.values(record.recipients));
    const pending = recipients.filter((recipient) => !recipient.deliveredAt);
    return {
      records: Object.keys(db.records).length,
      recipientsDelivered: recipients.length - pending.length,
      recipientsPending: pending.length,
      recipientsReady: pending.filter((recipient) => {
        const leaseReady = !recipient.leaseUntil || new Date(recipient.leaseUntil) <= now;
        const retryReady = !recipient.nextAttemptAt || new Date(recipient.nextAttemptAt) <= now;
        return leaseReady && retryReady;
      }).length,
    };
  }

  private async mutate<T>(operation: (db: AlertDatabase) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const run = async () => {
      try {
        await withFileLock(this.filePath, async () => {
          const db = await this.read();
          const before = JSON.stringify(db);
          const value = operation(db);
          if (JSON.stringify(db) !== before) await this.write(db);
          resolveResult(value);
        });
      } catch (error) { rejectResult(error); }
    };
    this.mutationQueue = this.mutationQueue.then(run, run);
    await this.mutationQueue;
    return result;
  }

  private async read(): Promise<AlertDatabase> {
    const parsed = await readJson<Partial<AlertDatabase>>(this.filePath, {});
    return { records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {}, groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {} };
  }

  private async write(db: AlertDatabase): Promise<void> { await atomicWriteJson(this.filePath, db); }

}

export async function deliverOperationalAlert(request: OperationalAlertRequest): Promise<OperationalAlertResult> {
  const now = request.now ?? new Date();
  const recipients = [...new Set(request.adminIds)].map((adminId) => ({ adminId, key: recipientKey(adminId) }));
  if (recipients.length === 0) return { attempted: 0, sent: 0, failed: 0, suppressed: false };
  const claim = await request.store.claim(request.key, recipients.map((item) => item.key), now, request.cooldownGroup, request.cooldownMs);
  if (claim.suppressed) return { attempted: 0, sent: 0, failed: 0, suppressed: true };
  const claimed = new Set(claim.claimed);
  const results = await Promise.all(recipients.filter((item) => claimed.has(item.key)).map(async (recipient) => {
    try {
      await request.sender(recipient.adminId, request.message);
      await request.store.finish(request.key, recipient.key, true, now, request.cooldownGroup);
      return true;
    } catch {
      await request.store.finish(request.key, recipient.key, false, now, request.cooldownGroup);
      return false;
    }
  }));
  const sent = results.filter(Boolean).length;
  return { attempted: results.length, sent, failed: results.length - sent, suppressed: false };
}

export async function alertActionableChannelFailures(
  channelPosts: Pick<JsonChannelPostStore, 'all'>,
  sender: ChannelSender,
  adminIds: number[],
  alertStore: JsonOperationalAlertStore,
  now = new Date(),
): Promise<OperationalAlertResult> {
  const posts = await channelPosts.all();
  const actionable = posts.filter((post) => {
    const actionableAt = post.status === 'Uncertain' ? post.uncertainAt : post.status === 'Failed' ? post.failedAt : undefined;
    if (!actionableAt) return false;
    const age = now.getTime() - new Date(actionableAt).getTime();
    return Number.isFinite(age) && age >= 0 && age <= CHANNEL_FAILURE_ACTION_WINDOW_MS;
  });
  let total: OperationalAlertResult = { attempted: 0, sent: 0, failed: 0, suppressed: false };
  for (const post of actionable) {
    const actionableAt = post.status === 'Uncertain' ? post.uncertainAt! : post.failedAt!;
    const result = await deliverOperationalAlert({
      key: `channel:${post.id}:${actionableAt}:${post.attempts}:${post.status}`,
      message: [
        '🚨 WST Academy kanal posti yuborilmadi',
        `Post ID: ${post.id}`,
        post.contentKey ? `Content key: ${post.contentKey}` : undefined,
        `Attempt: ${post.attempts}`,
        `Holat: ${post.status}/manual review.`,
        'Tekshirish: /channel_posts. Kanalni ko‘rmasdan avtomatik retry qilmang.',
      ].filter(Boolean).join('\n'),
      adminIds,
      sender: async (adminId, message) => { await sender.sendMessage(String(adminId), message); },
      store: alertStore,
      now,
    });
    total = {
      attempted: total.attempted + result.attempted,
      sent: total.sent + result.sent,
      failed: total.failed + result.failed,
      suppressed: total.suppressed || result.suppressed,
    };
  }
  return total;
}

function recipientKey(adminId: number): string {
  return createHash('sha256').update(String(adminId)).digest('hex').slice(0, 20);
}

function pruneDeliveredHistory(db: AlertDatabase, now: Date): void {
  for (const [key, record] of Object.entries(db.records)) {
    const expired = now.getTime() - new Date(record.createdAt).getTime() > RETENTION_MS;
    const fullyDelivered = Object.values(record.recipients).every((recipient) => Boolean(recipient.deliveredAt));
    if (expired && fullyDelivered) delete db.records[key];
  }
  for (const [key, group] of Object.entries(db.groups)) {
    if (now.getTime() - new Date(group.lastDeliveredAt).getTime() > RETENTION_MS) delete db.groups[key];
  }
}
