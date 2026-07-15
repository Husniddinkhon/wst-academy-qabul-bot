import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FailedWebhookPayload, JsonWebhookFailureStore } from './storage.js';
import type { Lead, LeadWebhookEvent } from './types.js';

export interface LeadWebhookSigningConfig {
  serviceId: string;
  secret: string;
}

let signingConfig: LeadWebhookSigningConfig | undefined;
export const LEAD_WEBHOOK_TIMEOUT_MS = 8_000;

export function configureLeadWebhookSigning(config: LeadWebhookSigningConfig | undefined): void {
  signingConfig = config ? { serviceId: config.serviceId, secret: config.secret } : undefined;
}

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
    ai_score: lead.aiLeadScore ?? '',
    ai_reason: lead.aiLeadReason ?? '',
  };
}

export interface AcademyLeadWebhookPayload {
  telegram_id: number;
  telegram_username?: string;
  full_name?: string;
  phone?: string;
  source: string;
  campaign?: string;
  course_interest?: string;
  notes?: string;
  payment_status?: string;
}

export function toAcademyWebhookPayload(event: LeadWebhookEvent, lead: Lead): AcademyLeadWebhookPayload {
  const details = {
    event,
    lead_status: lead.status,
    city: lead.city || undefined,
    age: lead.age || undefined,
    work_status: lead.workStatus || undefined,
    experience: lead.experience || undefined,
    payment_option: lead.paymentOption || undefined,
    intent: lead.intent || undefined,
    last_message: lead.lastMessage || undefined,
    operator_note: lead.operatorNote || undefined,
    next_follow_up: lead.nextFollowUp || undefined,
    ai_score: lead.aiLeadScore || undefined,
    ai_reason: lead.aiLeadReason || undefined,
    updated_at: lead.updatedAt,
  };
  return withoutUndefined({
    telegram_id: lead.telegramId,
    telegram_username: lead.username,
    full_name: lead.fullName || undefined,
    phone: lead.phone || undefined,
    source: lead.source,
    campaign: lead.campaignId,
    course_interest: lead.goal || undefined,
    notes: JSON.stringify(details),
    payment_status: lead.paymentStatus || undefined,
  });
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function createAcademyHeaders(body: string, config: LeadWebhookSigningConfig, nowSeconds = Math.floor(Date.now() / 1000), nonce = randomBytes(24).toString('hex')): Record<string, string> {
  const timestamp = String(nowSeconds);
  const canonical = `${timestamp}\n${nonce}\n${body}`;
  const signature = createHmac('sha256', config.secret).update(canonical, 'utf8').digest('hex');
  const idempotencyKey = `lead-${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  return {
    'content-type': 'application/json',
    'X-Service-Id': config.serviceId,
    'X-Service-Timestamp': timestamp,
    'X-Service-Nonce': nonce,
    'X-Service-Signature': signature,
    'Idempotency-Key': idempotencyKey,
  };
}

export async function sendLeadWebhook(webhookUrl: string | undefined, event: LeadWebhookEvent, lead: Lead, timeoutMs = LEAD_WEBHOOK_TIMEOUT_MS): Promise<void> {
  if (!webhookUrl) return;
  const body = JSON.stringify(signingConfig ? toAcademyWebhookPayload(event, lead) : toWebhookPayload(event, lead));
  const headers = signingConfig ? createAcademyHeaders(body, signingConfig) : { 'content-type': 'application/json' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webhookUrl, { method: 'POST', headers, body, signal: controller.signal });
    if (!response.ok) throw new Error(`Lead webhook failed with status ${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Lead webhook timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverLeadWebhook(webhookUrl: string | undefined, failureStore: JsonWebhookFailureStore, event: LeadWebhookEvent, lead: Lead, timeoutMs = LEAD_WEBHOOK_TIMEOUT_MS): Promise<void> {
  if (!webhookUrl) return;
  try {
    await sendLeadWebhook(webhookUrl, event, lead, timeoutMs);
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
