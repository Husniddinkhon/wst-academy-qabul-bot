import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FollowUpState, Lead, LeadStatus, LeadWebhookEvent } from './types.js';

interface LeadDatabase { leads: Lead[]; }
export interface FailedWebhookPayload { event: LeadWebhookEvent; lead: Lead; failedAt: string; attempts: number; lastError?: string; }
interface FailedWebhookDatabase { payloads: FailedWebhookPayload[]; }
interface FollowUpDatabase { followups: FollowUpState[]; }

export const STATUS_PRIORITY: Record<LeadStatus, number> = { New: 1, Warm: 2, Hot: 3, RegistrationCompleted: 4, CallRequested: 5, OperatorContacted: 6, Paid: 7, Rejected: 0 };
const AI_SCORE_PRIORITY = { COLD: 1, WARM: 2, HOT: 3 } as const;
export interface LeadUpsertResult { lead: Lead; created: boolean; hotEscalated: boolean }

export class JsonLeadStore {
  constructor(private readonly filePath: string) {}

  async upsert(lead: Lead): Promise<LeadUpsertResult> {
    const db = await this.readDatabase();
    const index = db.leads.findIndex((item) => item.telegramId === lead.telegramId);
    if (index === -1) {
      db.leads.push(lead);
      await this.writeDatabase(db);
      return { lead, created: true, hotEscalated: lead.aiLeadScore === 'HOT' };
    }

    const existing = normalizeLead(db.leads[index]);
    const merged = mergeLeadRecords(existing, lead);
    db.leads[index] = merged;
    await this.writeDatabase(db);
    return { lead: merged, created: false, hotEscalated: lead.aiLeadScore === 'HOT' && existing.aiLeadScore !== 'HOT' };
  }

  async add(lead: Lead): Promise<void> { await this.upsert(lead); }
  async getByTelegramId(telegramId: number): Promise<Lead | undefined> { return (await this.all()).find((lead) => lead.telegramId === telegramId); }

  async updateByTelegramId(telegramId: number, patch: Partial<Lead>): Promise<Lead | undefined> {
    const db = await this.readDatabase();
    const index = db.leads.findIndex((lead) => lead.telegramId === telegramId);
    if (index === -1) return undefined;
    const existing = normalizeLead(db.leads[index]);
    const updated = { ...existing, ...patch, telegramId, updatedAt: new Date().toISOString() };
    db.leads[index] = updated;
    await this.writeDatabase(db);
    return updated;
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
  private async readDatabase(): Promise<LeadDatabase> { try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as LeadDatabase; return { leads: Array.isArray(parsed.leads) ? parsed.leads : [] }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { leads: [] }; throw e; } }
  private async writeDatabase(db: LeadDatabase): Promise<void> { await atomicWriteJson(this.filePath, db); }
}

export class JsonWebhookFailureStore {
  constructor(private readonly filePath: string) {}
  async add(payload: Omit<FailedWebhookPayload, 'failedAt' | 'attempts'>): Promise<void> { const db = await this.read(); db.payloads.push({ ...payload, failedAt: new Date().toISOString(), attempts: 1 }); await atomicWriteJson(this.filePath, db); }
  async all(): Promise<FailedWebhookPayload[]> { return (await this.read()).payloads; }
  async replace(payloads: FailedWebhookPayload[]): Promise<void> { await atomicWriteJson(this.filePath, { payloads }); }
  private async read(): Promise<FailedWebhookDatabase> { try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as FailedWebhookDatabase; return { payloads: Array.isArray(parsed.payloads) ? parsed.payloads : [] }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { payloads: [] }; throw e; } }
}

export class JsonFollowUpStore {
  constructor(private readonly filePath: string) {}
  async ensure(state: FollowUpState): Promise<void> { const db = await this.read(); if (db.followups.some((f) => f.telegramId === state.telegramId)) return; db.followups.push(state); await atomicWriteJson(this.filePath, db); }
  async upsert(state: FollowUpState): Promise<void> { const db = await this.read(); const i = db.followups.findIndex((f) => f.telegramId === state.telegramId); if (i === -1) db.followups.push(state); else db.followups[i] = { ...db.followups[i], ...state }; await atomicWriteJson(this.filePath, db); }
  async all(): Promise<FollowUpState[]> { return (await this.read()).followups; }
  private async read(): Promise<FollowUpDatabase> { try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as FollowUpDatabase; return { followups: Array.isArray(parsed.followups) ? parsed.followups : [] }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { followups: [] }; throw e; } }
}

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
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> { await mkdir(path.dirname(filePath), { recursive: true }); const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`; await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); await rename(tmp, filePath); }
function csvEscape(value: string): string { if (!/[",\n\r]/.test(value)) return value; return `"${value.replaceAll('"', '""')}"`; }
