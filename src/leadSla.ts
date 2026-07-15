import { createHash } from 'node:crypto';
import type { Telegraf } from 'telegraf';
import type { JsonLeadStore } from './storage.js';
import type { BotContext, Lead, LeadStatus } from './types.js';
import { deliverOperationalAlert, type JsonOperationalAlertStore, type OperationalAlertResult } from './operationalAlerts.js';

const WAITING_STATUSES = new Set<LeadStatus>(['New', 'Warm', 'Hot', 'RegistrationCompleted', 'CallRequested']);
const SLA_STAGES = [
  { id: '15m', minimumAgeMs: 15 * 60_000, label: '15 daqiqadan oshdi' },
  { id: '60m', minimumAgeMs: 60 * 60_000, label: '60 daqiqadan oshdi' },
  { id: '24h', minimumAgeMs: 24 * 60 * 60_000, label: '24 soatdan oshdi' },
] as const;

export const DEFAULT_LEAD_SLA_POLL_MS = 60_000;

export interface LeadSlaRunResult extends OperationalAlertResult {
  waiting: number;
  due: number;
}

export function leadReference(lead: Pick<Lead, 'id' | 'telegramId'>): string {
  return createHash('sha256').update(`${lead.id}:${lead.telegramId}`).digest('hex').slice(0, 20).toUpperCase();
}

export function findLeadByReference(leads: Lead[], reference: string): Lead | undefined {
  const normalized = reference.trim().toUpperCase();
  if (!/^[A-F0-9]{20}$/.test(normalized)) return undefined;
  return leads.find((lead) => leadReference(lead) === normalized);
}

export async function processLeadSlaEscalations(
  leadStore: Pick<JsonLeadStore, 'all'>,
  alertStore: JsonOperationalAlertStore,
  bot: Pick<Telegraf<BotContext>['telegram'], 'sendMessage'>,
  adminIds: number[],
  now = new Date(),
): Promise<LeadSlaRunResult> {
  const leads = await leadStore.all();
  const waiting = leads.filter((lead) => WAITING_STATUSES.has(lead.status));
  let result: LeadSlaRunResult = { waiting: waiting.length, due: 0, attempted: 0, sent: 0, failed: 0, suppressed: false };

  for (const lead of waiting) {
    const createdAt = new Date(lead.createdAt).getTime();
    const ageMs = now.getTime() - createdAt;
    if (!Number.isFinite(createdAt) || ageMs < 0) continue;
    const stage = [...SLA_STAGES].reverse().find((candidate) => ageMs >= candidate.minimumAgeMs);
    if (!stage) continue;
    result.due += 1;
    const reference = leadReference(lead);
    const delivery = await deliverOperationalAlert({
      key: `lead-sla:${reference}:${stage.id}`,
      message: [
        '🚨 WST Academy lead SLA eskalatsiyasi',
        `Lead ref: ${reference}`,
        `Kutish: ${stage.label}`,
        `Holat: ${lead.status}`,
        'Operator aloqasi hali tasdiqlanmagan.',
        'Tekshirish: /last_leads',
        'Aloqadan keyin statusni OperatorContacted qiling.',
      ].join('\n'),
      adminIds,
      sender: async (adminId, message) => { await bot.sendMessage(adminId, message); },
      store: alertStore,
      now,
    });
    result = {
      ...result,
      attempted: result.attempted + delivery.attempted,
      sent: result.sent + delivery.sent,
      failed: result.failed + delivery.failed,
      suppressed: result.suppressed || delivery.suppressed,
    };
  }
  return result;
}

export function startLeadSlaEscalation(
  leadStore: Pick<JsonLeadStore, 'all'>,
  alertStore: JsonOperationalAlertStore,
  bot: Pick<Telegraf<BotContext>['telegram'], 'sendMessage'>,
  adminIds: number[],
  pollMs = DEFAULT_LEAD_SLA_POLL_MS,
): NodeJS.Timeout {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await processLeadSlaEscalations(leadStore, alertStore, bot, adminIds);
      if (result.failed > 0) console.error(`Lead SLA alert delivery failed for ${result.failed}/${result.attempted} recipient attempts.`);
    } catch (error) {
      console.error('Lead SLA escalation failed:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(() => { void run(); }, pollMs);
}
