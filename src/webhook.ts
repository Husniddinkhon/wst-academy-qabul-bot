import type { FailedWebhookPayload, JsonWebhookFailureStore } from './storage.js';
import type { Lead, LeadWebhookEvent } from './types.js';

export function toWebhookPayload(event: LeadWebhookEvent, lead: Lead): Record<string, string> {
  return {
    event,
    created_at: lead.createdAt,
    updated_at: lead.updatedAt,
    telegram_id: String(lead.telegramId),
    username: lead.username ?? '',
    full_name: lead.fullName,
    phone: lead.phone,
    city: lead.city,
    age: lead.age,
    work_status: lead.workStatus,
    experience: lead.experience,
    goal: lead.goal,
    payment_option: lead.paymentOption,
    status: lead.status,
    source: lead.source,
    intent: lead.intent,
    last_message: lead.lastMessage,
    operator_note: lead.operatorNote,
    next_follow_up: lead.nextFollowUp,
    payment_status: lead.paymentStatus,
  };
}

export async function sendLeadWebhook(webhookUrl: string | undefined, event: LeadWebhookEvent, lead: Lead): Promise<void> {
  if (!webhookUrl) return;
  const response = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toWebhookPayload(event, lead)) });
  if (!response.ok) throw new Error(`Lead webhook failed with status ${response.status}`);
}

export async function deliverLeadWebhook(webhookUrl: string | undefined, failureStore: JsonWebhookFailureStore, event: LeadWebhookEvent, lead: Lead): Promise<void> {
  if (!webhookUrl) return;
  try {
    await sendLeadWebhook(webhookUrl, event, lead);
  } catch (error) {
    console.error('Lead webhook delivery failed:', safeError(error));
    await failureStore.add({ event, lead, lastError: safeError(error) });
  }
}

export async function retryFailedWebhooks(webhookUrl: string | undefined, failureStore: JsonWebhookFailureStore): Promise<{ attempted: number; sent: number; remaining: number }> {
  const failed = await failureStore.all();
  if (!webhookUrl || failed.length === 0) return { attempted: failed.length, sent: 0, remaining: failed.length };
  const remaining: FailedWebhookPayload[] = [];
  let sent = 0;
  for (const item of failed) {
    try { await sendLeadWebhook(webhookUrl, item.event, item.lead); sent += 1; }
    catch (error) { remaining.push({ ...item, attempts: item.attempts + 1, failedAt: new Date().toISOString(), lastError: safeError(error) }); }
  }
  await failureStore.replace(remaining);
  return { attempted: failed.length, sent, remaining: remaining.length };
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
