import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';
import type { FollowUpState, Lead, LeadStatus, LeadWebhookEvent } from './types.js';

interface StoredLeadEffect { kind: 'upsert' | 'update'; result: LeadUpsertResult | Lead | undefined }
interface LeadDatabase { leads: Lead[]; effects: Record<string, StoredLeadEffect>; }
export type WebhookFailureState = 'RetryWait' | 'Claimed' | 'Uncertain' | 'DeadLetter';
export type WebhookFailureCategory = 'transient' | 'permanent' | 'uncertain';
export interface WebhookAuditEvent { at: string; event: string; actorId?: number; reason?: string }
export interface FailedWebhookPayload {
  id?: string;
  event: LeadWebhookEvent;
  lead: Lead;
  failedAt: string;
  firstFailedAt?: string;
  retainedUntil?: string;
  attempts: number;
  state?: WebhookFailureState;
  failureCategory?: WebhookFailureCategory;
  nextRetryAt?: string;
  deadLetteredAt?: string;
  manualReplayCount?: number;
  audit?: WebhookAuditEvent[];
  lastError?: string;
  idempotencyKey?: string;
  outcomeUncertain?: boolean;
  retryToken?: string;
  retryClaimedAt?: string;
  retryLeaseUntil?: string;
}
export interface WebhookRetryPolicy { maxAttempts: number; retentionMs: number; retryBaseMs: number; retryMaxMs: number; claimLeaseMs: number; maxManualReplays: number }
export const DEFAULT_WEBHOOK_RETRY_POLICY: WebhookRetryPolicy = { maxAttempts: 5, retentionMs: 7 * 24 * 60 * 60_000, retryBaseMs: 60_000, retryMaxMs: 60 * 60_000, claimLeaseMs: 10 * 60_000, maxManualReplays: 1 };
interface FailedWebhookDatabase { payloads: FailedWebhookPayload[]; }
interface FollowUpDatabase { followups: FollowUpState[]; effectKeys: string[]; }
export interface FollowUpDeliveryRequest { telegramId: number; followUpId: string; task: NonNullable<FollowUpState['task']>; dueAt: string; timeZone: 'Asia/Tashkent' }
export interface FollowUpDeliveryClaim { telegramId: number; followUpId: string; claimToken: string; task: NonNullable<FollowUpState['task']>; attempt: number }
export interface FollowUpClaimOptions { workerId: string; leaseMs: number; maxAttempts: number; now?: Date }
export type FollowUpClaimResult = { ok: true; claim: FollowUpDeliveryClaim; state: FollowUpState } | { ok: false; reason: 'not_found' | 'not_due' | 'owned' | 'terminal' | 'cancelled'; state?: FollowUpState };
export type FollowUpDeliveryOutcome =
  | { sent: true }
  | { sent: false; category: 'transient' | 'permanent' | 'uncertain'; error: string; nextRetryAt?: Date; maxAttempts: number };

export const STATUS_PRIORITY: Record<LeadStatus, number> = { New: 1, Warm: 2, Hot: 3, RegistrationCompleted: 4, CallRequested: 5, OperatorContacted: 6, Paid: 7, Rejected: 0 };
const AI_SCORE_PRIORITY = { COLD: 1, WARM: 2, HOT: 3 } as const;
export interface LeadUpsertResult { lead: Lead; created: boolean; hotEscalated: boolean }
export interface FunnelEventMetrics { available: boolean; leadCreationsTracked: number; hotEscalations: number; registrations: number }

export class JsonLeadStore {
  constructor(private readonly filePath: string) {}

  async upsert(lead: Lead, idempotencyKey?: string): Promise<LeadUpsertResult> {
    return withFileLock(this.filePath, async () => {
    const db = await this.readDatabase();
    const prior = idempotencyKey ? db.effects[idempotencyKey] : undefined;
    if (prior?.kind === 'upsert') return prior.result as LeadUpsertResult;
    const index = db.leads.findIndex((item) => item.telegramId === lead.telegramId);
    if (index === -1) {
      db.leads.push(lead);
      if (idempotencyKey) rememberLeadEffect(db, idempotencyKey, { kind: 'upsert', result: { lead, created: true, hotEscalated: lead.aiLeadScore === 'HOT' } });
      await this.writeDatabase(db);
      return { lead, created: true, hotEscalated: lead.aiLeadScore === 'HOT' };
    }

    const existing = normalizeLead(db.leads[index]);
    const merged = mergeLeadRecords(existing, lead);
    db.leads[index] = merged;
    const result = { lead: merged, created: false, hotEscalated: lead.aiLeadScore === 'HOT' && existing.aiLeadScore !== 'HOT' };
    if (idempotencyKey) rememberLeadEffect(db, idempotencyKey, { kind: 'upsert', result });
    await this.writeDatabase(db);
    return result;
    });
  }

  async add(lead: Lead): Promise<void> { await this.upsert(lead); }
  async getByTelegramId(telegramId: number): Promise<Lead | undefined> { return (await this.all()).find((lead) => lead.telegramId === telegramId); }

  async updateByTelegramId(telegramId: number, patch: Partial<Lead>, idempotencyKey?: string): Promise<Lead | undefined> {
    return withFileLock(this.filePath, async () => {
    const db = await this.readDatabase();
    const prior = idempotencyKey ? db.effects[idempotencyKey] : undefined;
    if (prior?.kind === 'update') return prior.result as Lead | undefined;
    const index = db.leads.findIndex((lead) => lead.telegramId === telegramId);
    if (index === -1) {
      if (idempotencyKey) { rememberLeadEffect(db, idempotencyKey, { kind: 'update', result: undefined }); await this.writeDatabase(db); }
      return undefined;
    }
    const existing = normalizeLead(db.leads[index]);
    const updated = { ...existing, ...patch, telegramId, updatedAt: new Date().toISOString() };
    db.leads[index] = updated;
    if (idempotencyKey) rememberLeadEffect(db, idempotencyKey, { kind: 'update', result: updated });
    await this.writeDatabase(db);
    return updated;
    });
  }

  async all(): Promise<Lead[]> { const db = await this.readDatabase(); return db.leads.map(normalizeLead).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async today(now = new Date()): Promise<Lead[]> {
    const start = new Date(now); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 1);
    return (await this.all()).filter((lead) => { const createdAt = new Date(lead.createdAt); return createdAt >= start && createdAt < end; });
  }
  async last(limit = 10): Promise<Lead[]> { return (await this.all()).slice(0, limit); }
  async stats(): Promise<{ total: number; today: number; last7Days: number; hot: number; callRequests: number; completed: number; noPhone: number }> {
    const leads = await this.all(); const now = new Date(); const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7); const today = await this.today(now);
    return { total: leads.length, today: today.length, last7Days: leads.filter((lead) => new Date(lead.createdAt) >= sevenDaysAgo).length, hot: leads.filter((l) => l.status === 'Hot').length, callRequests: leads.filter((l) => l.status === 'CallRequested').length, completed: leads.filter((l) => l.status === 'RegistrationCompleted').length, noPhone: leads.filter((l) => !l.phone).length };
  }
  async toCsv(leads?: Lead[]): Promise<string> {
    const exportLeads = leads ?? (await this.all());
    const headers: (keyof Lead)[] = ['id','createdAt','updatedAt','telegramId','username','firstName','lastName','fullName','phone','city','age','workStatus','experience','goal','paymentOption','status','source','campaignId','studentStatus','agentActionCount','lastAgentAction','lastAgentAt','aiLeadScore','aiLeadReason','intent','lastMessage','operatorNote','nextFollowUp','paymentStatus','preferredTime','notes'];
    return [headers.join(','), ...exportLeads.map((lead) => headers.map((h) => csvEscape(String(lead[h] ?? ''))).join(','))].join('\n');
  }
  async getFunnelEventMetrics(_from: Date, _toExclusive: Date): Promise<FunnelEventMetrics> { return { available: false, leadCreationsTracked: 0, hotEscalations: 0, registrations: 0 }; }
  private async readDatabase(): Promise<LeadDatabase> { const parsed = await readJson<Partial<LeadDatabase>>(this.filePath, { leads: [], effects: {} }); return { leads: Array.isArray(parsed.leads) ? parsed.leads : [], effects: parsed.effects && typeof parsed.effects === 'object' ? parsed.effects : {} }; }
  private async writeDatabase(db: LeadDatabase): Promise<void> { await atomicWriteJson(this.filePath, db); }
}

export class JsonWebhookFailureStore {
  constructor(private readonly filePath: string) {}
  async add(payload: Omit<FailedWebhookPayload, 'failedAt' | 'attempts'>, policy = DEFAULT_WEBHOOK_RETRY_POLICY, now = new Date()): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      if (payload.idempotencyKey && db.payloads.some((item) => item.idempotencyKey === payload.idempotencyKey)) return;
      const category = payload.failureCategory ?? (payload.outcomeUncertain ? 'uncertain' : 'transient');
      const state: WebhookFailureState = category === 'uncertain' ? 'Uncertain' : category === 'permanent' ? 'DeadLetter' : 'RetryWait';
      const at = now.toISOString();
      db.payloads.push(normalizeWebhookFailure({
        ...payload,
        id: payload.id ?? randomUUID().slice(0, 12),
        failedAt: at,
        firstFailedAt: at,
        retainedUntil: new Date(now.getTime() + policy.retentionMs).toISOString(),
        attempts: 1,
        state,
        failureCategory: category,
        outcomeUncertain: category === 'uncertain',
        nextRetryAt: state === 'RetryWait' ? new Date(now.getTime() + boundedWebhookBackoff(1, policy)).toISOString() : undefined,
        deadLetteredAt: state === 'DeadLetter' ? at : undefined,
        manualReplayCount: 0,
        audit: [{ at, event: state === 'DeadLetter' ? 'webhook_permanent_failure' : state === 'Uncertain' ? 'webhook_outcome_uncertain' : 'webhook_retry_scheduled' }],
      }));
      await atomicWriteJson(this.filePath, db);
    });
  }
  async all(): Promise<FailedWebhookPayload[]> { return (await this.read()).payloads.map(normalizeWebhookFailure); }
  async replace(payloads: FailedWebhookPayload[]): Promise<void> { await withFileLock(this.filePath, async () => atomicWriteJson(this.filePath, { payloads: payloads.map(normalizeWebhookFailure) })); }
  async claimRetryable(now = new Date(), policy = DEFAULT_WEBHOOK_RETRY_POLICY): Promise<FailedWebhookPayload[]> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const claimed: FailedWebhookPayload[] = [];
      let changed = false;
      let expired = 0;
      db.payloads = db.payloads.filter((raw) => {
        const item = normalizeWebhookFailure(raw);
        if (item.retainedUntil && new Date(item.retainedUntil) <= now) { expired += 1; changed = true; return false; }
        return true;
      });
      for (let index = 0; index < db.payloads.length; index += 1) {
        let item = normalizeWebhookFailure(db.payloads[index]);
        db.payloads[index] = item;
        if (item.state === 'Uncertain' || item.state === 'DeadLetter' || item.outcomeUncertain) continue;
        if (item.attempts >= policy.maxAttempts) {
          item = appendWebhookAudit({ ...item, state: 'DeadLetter', deadLetteredAt: now.toISOString(), retryToken: undefined, retryClaimedAt: undefined, retryLeaseUntil: undefined, lastError: item.lastError ?? 'Webhook retry ceiling exhausted.' }, 'webhook_retry_exhausted', now);
          db.payloads[index] = item;
          changed = true;
          continue;
        }
        if (item.retryToken) {
          const leaseUntil = item.retryLeaseUntil ? new Date(item.retryLeaseUntil).getTime() : (item.retryClaimedAt ? new Date(item.retryClaimedAt).getTime() + policy.claimLeaseMs : 0);
          if (leaseUntil <= now.getTime()) {
            item = appendWebhookAudit({ ...item, state: 'Uncertain', failureCategory: 'uncertain', outcomeUncertain: true, lastError: 'Webhook retry ownership expired after an interrupted attempt; external outcome requires evidence review.', retryToken: undefined, retryClaimedAt: undefined, retryLeaseUntil: undefined, nextRetryAt: undefined }, 'webhook_stale_claim_uncertain', now);
            db.payloads[index] = item;
            changed = true;
          }
          continue;
        }
        if (item.nextRetryAt && new Date(item.nextRetryAt) > now) continue;
        item = appendWebhookAudit({ ...item, state: 'Claimed', retryToken: randomUUID(), retryClaimedAt: now.toISOString(), retryLeaseUntil: new Date(now.getTime() + policy.claimLeaseMs).toISOString() }, 'webhook_retry_claimed', now);
        db.payloads[index] = item;
        claimed.push({ ...item });
        changed = true;
      }
      if (changed) await atomicWriteJson(this.filePath, db);
      if (expired) console.info(JSON.stringify({ event: 'webhook_retention_expired', count: expired }));
      return claimed;
    });
  }
  async finishRetry(claimed: FailedWebhookPayload, outcome: { sent: true } | { sent: false; error: string; outcomeUncertain: boolean; category?: WebhookFailureCategory }, now = new Date(), policy = DEFAULT_WEBHOOK_RETRY_POLICY): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.payloads.findIndex((item) => item.retryToken === claimed.retryToken && item.retryToken !== undefined);
      if (index < 0) throw new Error('Webhook retry ownership lost.');
      if (outcome.sent) db.payloads.splice(index, 1);
      else {
        const current = normalizeWebhookFailure(db.payloads[index]);
        const attempts = current.attempts + 1;
        const category = outcome.category ?? (outcome.outcomeUncertain ? 'uncertain' : 'transient');
        const terminal = category === 'permanent' || attempts >= policy.maxAttempts;
        const state: WebhookFailureState = category === 'uncertain' ? 'Uncertain' : terminal ? 'DeadLetter' : 'RetryWait';
        db.payloads[index] = appendWebhookAudit({
          ...current, attempts, failedAt: now.toISOString(), lastError: outcome.error, failureCategory: category,
          outcomeUncertain: category === 'uncertain', state, retryToken: undefined, retryClaimedAt: undefined, retryLeaseUntil: undefined,
          nextRetryAt: state === 'RetryWait' ? new Date(now.getTime() + boundedWebhookBackoff(attempts, policy)).toISOString() : undefined,
          deadLetteredAt: state === 'DeadLetter' ? now.toISOString() : current.deadLetteredAt,
        }, state === 'DeadLetter' ? (category === 'permanent' ? 'webhook_permanent_failure' : 'webhook_retry_exhausted') : state === 'Uncertain' ? 'webhook_outcome_uncertain' : 'webhook_retry_scheduled', now);
      }
      await atomicWriteJson(this.filePath, db);
    });
  }
  async manualReplay(id: string, actorId: number, reason: string, now = new Date(), policy = DEFAULT_WEBHOOK_RETRY_POLICY): Promise<{ ok: true; payload: FailedWebhookPayload } | { ok: false; reason: 'not_found' | 'not_allowed' | 'expired' }> {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || reason.trim().length < 8) return { ok: false, reason: 'not_allowed' };
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.payloads.findIndex((item) => normalizeWebhookFailure(item).id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizeWebhookFailure(db.payloads[index]);
      if (current.retainedUntil && new Date(current.retainedUntil) <= now) return { ok: false, reason: 'expired' } as const;
      if (!['DeadLetter', 'Uncertain'].includes(current.state ?? '') || (current.manualReplayCount ?? 0) >= policy.maxManualReplays) return { ok: false, reason: 'not_allowed' } as const;
      const updated = appendWebhookAudit({ ...current, state: 'RetryWait', failureCategory: 'transient', outcomeUncertain: false, attempts: 0, manualReplayCount: (current.manualReplayCount ?? 0) + 1, nextRetryAt: now.toISOString(), deadLetteredAt: undefined, retryToken: undefined, retryClaimedAt: undefined, retryLeaseUntil: undefined }, 'webhook_manual_replay_authorized', now, actorId, reason.trim());
      db.payloads[index] = updated;
      await atomicWriteJson(this.filePath, db);
      return { ok: true, payload: updated } as const;
    });
  }
  private async read(): Promise<FailedWebhookDatabase> { const parsed = await readJson<FailedWebhookDatabase>(this.filePath, { payloads: [] }); return { payloads: Array.isArray(parsed.payloads) ? parsed.payloads.map(normalizeWebhookFailure) : [] }; }
}

function normalizeWebhookFailure(payload: FailedWebhookPayload): FailedWebhookPayload {
  const firstFailedAt = payload.firstFailedAt ?? payload.failedAt;
  const category = payload.failureCategory ?? (payload.outcomeUncertain ? 'uncertain' : 'transient');
  return {
    ...payload,
    id: payload.id ?? legacyWebhookId(payload, firstFailedAt),
    firstFailedAt,
    retainedUntil: payload.retainedUntil ?? new Date(new Date(firstFailedAt).getTime() + DEFAULT_WEBHOOK_RETRY_POLICY.retentionMs).toISOString(),
    state: payload.state ?? (category === 'uncertain' ? 'Uncertain' : 'RetryWait'),
    failureCategory: category,
    outcomeUncertain: category === 'uncertain',
    manualReplayCount: payload.manualReplayCount ?? 0,
    audit: Array.isArray(payload.audit) ? payload.audit : [],
  };
}
function boundedWebhookBackoff(attempts: number, policy: WebhookRetryPolicy): number { return Math.min(policy.retryMaxMs, policy.retryBaseMs * (2 ** Math.max(0, attempts - 1))); }
function appendWebhookAudit(payload: FailedWebhookPayload, event: string, now = new Date(), actorId?: number, reason?: string): FailedWebhookPayload { return { ...payload, audit: [...(payload.audit ?? []), { at: now.toISOString(), event, actorId, reason }].slice(-100) }; }
function legacyWebhookId(payload: FailedWebhookPayload, firstFailedAt: string): string { return createHash('sha256').update(payload.idempotencyKey ?? `${payload.event}:${payload.lead.id}:${firstFailedAt}`).digest('hex').slice(0, 12); }

export class JsonFollowUpStore {
  constructor(private readonly filePath: string) {}
  async ensure(state: FollowUpState, idempotencyKey?: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return;
      if (!db.followups.some((item) => item.telegramId === state.telegramId)) db.followups.push(normalizeFollowUpState(state));
      if (idempotencyKey) rememberKey(db.effectKeys, idempotencyKey);
      await atomicWriteJson(this.filePath, db);
    });
  }
  async upsert(state: FollowUpState, idempotencyKey?: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return;
      const index = db.followups.findIndex((item) => item.telegramId === state.telegramId);
      const current = index < 0 ? undefined : normalizeFollowUpState(db.followups[index]);
      let merged = normalizeFollowUpState({ ...(current ?? {}), ...state } as FollowUpState);
      if (state.registrationCompleted && current && ['Pending', 'Claimed', 'RetryWait'].includes(current.deliveryState ?? 'Pending')) {
        merged = appendFollowUpAudit({ ...clearFollowUpClaim(merged), deliveryState: 'Cancelled', terminalAt: new Date().toISOString(), lastError: 'Registration completed before follow-up delivery.' }, 'delivery_cancelled_registration_complete');
      }
      if (index < 0) db.followups.push(merged); else db.followups[index] = merged;
      if (idempotencyKey) rememberKey(db.effectKeys, idempotencyKey);
      await atomicWriteJson(this.filePath, db);
    });
  }
  async all(): Promise<FollowUpState[]> { return (await this.read()).followups.map(normalizeFollowUpState); }

  async claimDelivery(request: FollowUpDeliveryRequest, options: FollowUpClaimOptions): Promise<FollowUpClaimResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.followups.findIndex((item) => item.telegramId === request.telegramId);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const result = claimFollowUpState(normalizeFollowUpState(db.followups[index]), request, options, options.now ?? new Date());
      if (result.ok) { db.followups[index] = result.state; await atomicWriteJson(this.filePath, db); }
      else if (result.state && JSON.stringify(result.state) !== JSON.stringify(db.followups[index])) { db.followups[index] = result.state; await atomicWriteJson(this.filePath, db); }
      return result;
    });
  }

  async markDeliverySending(claim: FollowUpDeliveryClaim, now = new Date()): Promise<FollowUpState | undefined> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.followups.findIndex((item) => item.telegramId === claim.telegramId);
      if (index < 0) return undefined;
      const current = normalizeFollowUpState(db.followups[index]);
      if (current.followUpId !== claim.followUpId || current.claimToken !== claim.claimToken || current.deliveryState !== 'Claimed') return undefined;
      const updated = appendFollowUpAudit({ ...current, deliveryState: 'Sending' }, 'delivery_send_started', now, current.claimWorkerId);
      db.followups[index] = updated;
      await atomicWriteJson(this.filePath, db);
      return updated;
    });
  }

  async finishDelivery(claim: FollowUpDeliveryClaim, outcome: FollowUpDeliveryOutcome, now = new Date()): Promise<FollowUpState | undefined> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.followups.findIndex((item) => item.telegramId === claim.telegramId);
      if (index < 0) return undefined;
      const current = normalizeFollowUpState(db.followups[index]);
      if (current.followUpId !== claim.followUpId || current.claimToken !== claim.claimToken || current.deliveryState !== 'Sending') return undefined;
      const updated = finishFollowUpState(current, outcome, now);
      db.followups[index] = updated;
      await atomicWriteJson(this.filePath, db);
      return updated;
    });
  }

  async cancelDelivery(telegramId: number, reason: string, now = new Date()): Promise<FollowUpState | undefined> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.followups.findIndex((item) => item.telegramId === telegramId);
      if (index < 0) return undefined;
      const current = normalizeFollowUpState(db.followups[index]);
      if (!['Pending', 'Claimed', 'RetryWait'].includes(current.deliveryState ?? 'Pending')) return current;
      const updated = appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'Cancelled', terminalAt: now.toISOString(), lastError: reason }, 'delivery_cancelled', now, undefined, reason);
      db.followups[index] = updated;
      await atomicWriteJson(this.filePath, db);
      return updated;
    });
  }

  async abandonDeliveryForShutdown(claim: FollowUpDeliveryClaim, now = new Date()): Promise<FollowUpState | undefined> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.followups.findIndex((item) => item.telegramId === claim.telegramId);
      if (index < 0) return undefined;
      const current = normalizeFollowUpState(db.followups[index]);
      if (current.followUpId !== claim.followUpId || current.claimToken !== claim.claimToken || !['Claimed', 'Sending'].includes(current.deliveryState ?? '')) return undefined;
      const updated = current.deliveryState === 'Sending'
        ? appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'Uncertain', terminalAt: now.toISOString(), lastError: 'Shutdown drain expired after follow-up send started; outcome requires evidence review.' }, 'shutdown_delivery_uncertain', now, current.claimWorkerId)
        : appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'RetryWait', nextRetryAt: now.toISOString(), lastError: 'Shutdown drain expired before follow-up send started.' }, 'shutdown_delivery_released_safe', now, current.claimWorkerId);
      db.followups[index] = updated;
      await atomicWriteJson(this.filePath, db);
      return updated;
    });
  }

  async recoverExpiredDeliveryClaims(now = new Date()): Promise<FollowUpState[]> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const recovered: FollowUpState[] = [];
      db.followups = db.followups.map((raw) => {
        const current = normalizeFollowUpState(raw);
        if (!['Claimed', 'Sending'].includes(current.deliveryState ?? '') || !current.leaseExpiresAt || new Date(current.leaseExpiresAt) > now) return current;
        const updated = current.deliveryState === 'Sending'
          ? appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'Uncertain', terminalAt: now.toISOString(), lastError: 'Follow-up claim expired after Telegram send started; outcome requires evidence review.' }, 'stale_delivery_uncertain', now, current.claimWorkerId)
          : appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'RetryWait', nextRetryAt: now.toISOString(), lastError: 'Follow-up claim expired before Telegram send started.' }, 'stale_delivery_recovered_safe', now, current.claimWorkerId);
        recovered.push(updated);
        return updated;
      });
      if (recovered.length) await atomicWriteJson(this.filePath, db);
      return recovered;
    });
  }

  private async read(): Promise<FollowUpDatabase> {
    const parsed = await readJson<Partial<FollowUpDatabase>>(this.filePath, { followups: [], effectKeys: [] });
    return { followups: Array.isArray(parsed.followups) ? parsed.followups.map(normalizeFollowUpState) : [], effectKeys: Array.isArray(parsed.effectKeys) ? parsed.effectKeys : [] };
  }
}

export function claimFollowUpState(current: FollowUpState, request: FollowUpDeliveryRequest, options: FollowUpClaimOptions, now: Date): FollowUpClaimResult {
  const state = normalizeFollowUpState(current);
  if (state.registrationCompleted || state.count >= 2 || ['Cancelled', 'Failed', 'Uncertain'].includes(state.deliveryState ?? '')) return { ok: false, reason: state.registrationCompleted || state.deliveryState === 'Cancelled' ? 'cancelled' : 'terminal', state };
  if (new Date(request.dueAt) > now) return { ok: false, reason: 'not_due', state };
  if (state.followUpId && state.followUpId !== request.followUpId && state.deliveryState && state.deliveryState !== 'Sent') return { ok: false, reason: 'terminal', state };
  if (state.followUpId === request.followUpId && state.deliveryState === 'Sent') return { ok: false, reason: 'terminal', state };
  if (state.claimToken && state.leaseExpiresAt && new Date(state.leaseExpiresAt) > now) return { ok: false, reason: 'owned', state };
  if (state.claimToken && state.deliveryState === 'Sending') {
    const uncertain = appendFollowUpAudit({ ...clearFollowUpClaim(state), deliveryState: 'Uncertain', terminalAt: now.toISOString(), lastError: 'Interrupted follow-up send has an unknown Telegram outcome.' }, 'interrupted_delivery_uncertain', now, state.claimWorkerId);
    return { ok: false, reason: 'terminal', state: uncertain };
  }
  if (state.nextRetryAt && new Date(state.nextRetryAt) > now) return { ok: false, reason: 'not_due', state };
  const attempts = state.followUpId === request.followUpId ? (state.attempts ?? 0) + 1 : 1;
  if (attempts > options.maxAttempts) {
    const failed = appendFollowUpAudit({ ...clearFollowUpClaim(state), followUpId: request.followUpId, task: request.task, dueAt: request.dueAt, timeZone: request.timeZone, deliveryState: 'Failed', terminalAt: now.toISOString(), lastError: 'Follow-up retry ceiling exhausted.', attempts: attempts - 1 }, 'delivery_retry_exhausted', now, options.workerId);
    return { ok: false, reason: 'terminal', state: failed };
  }
  const claimToken = randomUUID();
  const claimed = appendFollowUpAudit({ ...state, followUpId: request.followUpId, task: request.task, dueAt: request.dueAt, timeZone: request.timeZone, deliveryState: 'Claimed', claimToken, claimWorkerId: options.workerId, claimedAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + options.leaseMs).toISOString(), attempts, nextRetryAt: undefined, lastError: undefined, terminalAt: undefined }, 'delivery_claimed', now, options.workerId);
  return { ok: true, claim: { telegramId: request.telegramId, followUpId: request.followUpId, claimToken, task: request.task, attempt: attempts }, state: claimed };
}

export function finishFollowUpState(current: FollowUpState, outcome: FollowUpDeliveryOutcome, now: Date): FollowUpState {
  if (outcome.sent) return appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'Sent', count: current.count + 1, lastSentAt: now.toISOString(), terminalAt: now.toISOString(), lastError: undefined, nextRetryAt: undefined }, 'delivery_sent', now, current.claimWorkerId);
  if (outcome.category === 'uncertain') return appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'Uncertain', terminalAt: now.toISOString(), lastError: outcome.error, nextRetryAt: undefined }, 'delivery_outcome_uncertain', now, current.claimWorkerId);
  if (outcome.category === 'permanent' || (current.attempts ?? 0) >= outcome.maxAttempts) return appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'Failed', terminalAt: now.toISOString(), lastError: outcome.error, nextRetryAt: undefined }, outcome.category === 'permanent' ? 'delivery_permanent_failure' : 'delivery_retry_exhausted', now, current.claimWorkerId);
  return appendFollowUpAudit({ ...clearFollowUpClaim(current), deliveryState: 'RetryWait', nextRetryAt: (outcome.nextRetryAt ?? now).toISOString(), lastError: outcome.error }, 'delivery_retry_scheduled', now, current.claimWorkerId);
}

export function normalizeFollowUpState(state: FollowUpState): FollowUpState {
  return { ...state, count: Number.isInteger(state.count) ? state.count : 0, attempts: Number.isInteger(state.attempts) ? state.attempts : 0, audit: Array.isArray(state.audit) ? state.audit : [] };
}

function clearFollowUpClaim(state: FollowUpState): FollowUpState { return { ...state, claimToken: undefined, claimWorkerId: undefined, claimedAt: undefined, leaseExpiresAt: undefined }; }
function appendFollowUpAudit(state: FollowUpState, event: string, now = new Date(), workerId?: string, reason?: string): FollowUpState { return { ...state, audit: [...(state.audit ?? []), { at: now.toISOString(), event, workerId, followUpId: state.followUpId, reason }].slice(-100) }; }

function rememberLeadEffect(db: LeadDatabase, key: string, effect: StoredLeadEffect): void { db.effects[key] = effect; const keys = Object.keys(db.effects); for (const old of keys.slice(0, Math.max(0, keys.length - 10_000))) delete db.effects[old]; }
function rememberKey(keys: string[], key: string): void { keys.push(key); if (keys.length > 10_000) keys.splice(0, keys.length - 10_000); }

function normalizeLead(lead: Lead): Lead { return { ...lead, updatedAt: lead.updatedAt ?? lead.createdAt, city: lead.city ?? (lead as unknown as { district?: string }).district ?? '', workStatus: lead.workStatus ?? '', goal: lead.goal ?? '', paymentOption: lead.paymentOption ?? '', status: normalizeStatus(lead.status), source: lead.source ?? 'unknown', campaignId: lead.campaignId ?? '', studentStatus: lead.studentStatus ?? 'NotEnrolled', agentActionCount: lead.agentActionCount ?? 0, lastAgentAction: lead.lastAgentAction ?? '', lastAgentAt: lead.lastAgentAt ?? '', intent: lead.intent ?? '', lastMessage: lead.lastMessage ?? lead.notes ?? '', messages: lead.messages ?? [], operatorNote: lead.operatorNote ?? '', nextFollowUp: lead.nextFollowUp ?? '', paymentStatus: lead.paymentStatus ?? '' }; }
export function mergeLeadRecords(existingLead: Lead, incomingLead: Lead): Lead {
  const existing = normalizeLead(existingLead);
  const nextStatus = STATUS_PRIORITY[incomingLead.status] > STATUS_PRIORITY[existing.status] ? incomingLead.status : existing.status;
  const existingScore = existing.aiLeadScore;
  const incomingScore = incomingLead.aiLeadScore;
  const keepIncomingScore = Boolean(incomingScore && (!existingScore || AI_SCORE_PRIORITY[incomingScore] >= AI_SCORE_PRIORITY[existingScore]));
  return normalizeLead({
    ...existing,
    ...incomingLead,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: incomingLead.updatedAt,
    phone: incomingLead.phone.trim() || existing.phone,
    goal: incomingLead.goal.trim() || existing.goal,
    source: incomingLead.source && incomingLead.source !== 'unknown' ? incomingLead.source : existing.source,
    campaignId: incomingLead.campaignId?.trim() || existing.campaignId,
    status: nextStatus,
    aiLeadScore: keepIncomingScore ? incomingScore : existingScore,
    aiLeadReason: keepIncomingScore ? incomingLead.aiLeadReason : existing.aiLeadReason,
    messages: [...(existing.messages ?? []), ...(incomingLead.lastMessage ? [{ text: incomingLead.lastMessage, createdAt: incomingLead.updatedAt }] : [])],
    operatorNote: incomingLead.operatorNote || existing.operatorNote,
    nextFollowUp: incomingLead.nextFollowUp || existing.nextFollowUp,
    paymentStatus: incomingLead.paymentStatus || existing.paymentStatus,
  });
}
function normalizeStatus(status: string): LeadStatus { if (status === 'new' || status === 'notified') return 'New'; return (status as LeadStatus) ?? 'New'; }
function csvEscape(value: string): string { if (!/[",\n\r]/.test(value)) return value; return `"${value.replaceAll('"', '""')}"`; }
