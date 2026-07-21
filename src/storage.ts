import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';
import type { FollowUpState, Lead, LeadStatus, LeadWebhookEvent } from './types.js';

interface StoredLeadEffect { kind: 'upsert' | 'update'; result: LeadUpsertResult | Lead | undefined }
interface LeadDatabase { leads: Lead[]; effects: Record<string, StoredLeadEffect>; }
export interface FailedWebhookPayload { event: LeadWebhookEvent; lead: Lead; failedAt: string; attempts: number; lastError?: string; idempotencyKey?: string; outcomeUncertain?: boolean; retryToken?: string; retryClaimedAt?: string; }
interface FailedWebhookDatabase { payloads: FailedWebhookPayload[]; }
interface FollowUpDatabase { followups: FollowUpState[]; effectKeys: string[]; }

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
  async add(payload: Omit<FailedWebhookPayload, 'failedAt' | 'attempts'>): Promise<void> { await withFileLock(this.filePath, async () => { const db = await this.read(); if (payload.idempotencyKey && db.payloads.some((item) => item.idempotencyKey === payload.idempotencyKey)) return; db.payloads.push({ ...payload, failedAt: new Date().toISOString(), attempts: 1 }); await atomicWriteJson(this.filePath, db); }); }
  async all(): Promise<FailedWebhookPayload[]> { return (await this.read()).payloads; }
  async replace(payloads: FailedWebhookPayload[]): Promise<void> { await withFileLock(this.filePath, async () => atomicWriteJson(this.filePath, { payloads })); }
  async claimRetryable(now = new Date()): Promise<FailedWebhookPayload[]> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const claimed: FailedWebhookPayload[] = [];
      for (const item of db.payloads) {
        if (item.outcomeUncertain) continue;
        if (item.retryToken) {
          const claimedAt = item.retryClaimedAt ? new Date(item.retryClaimedAt).getTime() : 0;
          if (claimedAt <= now.getTime() - 10 * 60_000) {
            item.outcomeUncertain = true;
            item.lastError = 'Webhook retry ownership expired after an interrupted attempt; external outcome requires evidence review.';
            item.retryToken = undefined;
            item.retryClaimedAt = undefined;
          }
          continue;
        }
        item.retryToken = randomUUID();
        item.retryClaimedAt = now.toISOString();
        claimed.push({ ...item });
      }
      await atomicWriteJson(this.filePath, db);
      return claimed;
    });
  }
  async finishRetry(claimed: FailedWebhookPayload, outcome: { sent: true } | { sent: false; error: string; outcomeUncertain: boolean }, now = new Date()): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.read();
      const index = db.payloads.findIndex((item) => item.retryToken === claimed.retryToken && item.retryToken !== undefined);
      if (index < 0) throw new Error('Webhook retry ownership lost.');
      if (outcome.sent) db.payloads.splice(index, 1);
      else db.payloads[index] = { ...db.payloads[index], attempts: db.payloads[index].attempts + 1, failedAt: now.toISOString(), lastError: outcome.error, outcomeUncertain: outcome.outcomeUncertain, retryToken: undefined, retryClaimedAt: undefined };
      await atomicWriteJson(this.filePath, db);
    });
  }
  private async read(): Promise<FailedWebhookDatabase> { const parsed = await readJson<FailedWebhookDatabase>(this.filePath, { payloads: [] }); return { payloads: Array.isArray(parsed.payloads) ? parsed.payloads : [] }; }
}

export class JsonFollowUpStore {
  constructor(private readonly filePath: string) {}
  async ensure(state: FollowUpState, idempotencyKey?: string): Promise<void> { await withFileLock(this.filePath, async () => { const db = await this.read(); if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return; if (!db.followups.some((f) => f.telegramId === state.telegramId)) db.followups.push(state); if (idempotencyKey) rememberKey(db.effectKeys, idempotencyKey); await atomicWriteJson(this.filePath, db); }); }
  async upsert(state: FollowUpState, idempotencyKey?: string): Promise<void> { await withFileLock(this.filePath, async () => { const db = await this.read(); if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return; const i = db.followups.findIndex((f) => f.telegramId === state.telegramId); if (i === -1) db.followups.push(state); else db.followups[i] = { ...db.followups[i], ...state }; if (idempotencyKey) rememberKey(db.effectKeys, idempotencyKey); await atomicWriteJson(this.filePath, db); }); }
  async all(): Promise<FollowUpState[]> { return (await this.read()).followups; }
  private async read(): Promise<FollowUpDatabase> { const parsed = await readJson<Partial<FollowUpDatabase>>(this.filePath, { followups: [], effectKeys: [] }); return { followups: Array.isArray(parsed.followups) ? parsed.followups : [], effectKeys: Array.isArray(parsed.effectKeys) ? parsed.effectKeys : [] }; }
}

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
