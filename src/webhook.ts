import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DEFAULT_WEBHOOK_RETRY_POLICY, type JsonWebhookFailureStore, type WebhookFailureCategory, type WebhookRetryPolicy } from './storage.js';
import type { Lead, LeadWebhookEvent } from './types.js';
import { IndeterminateTelegramEffectError, runCurrentUpdateEffect } from './telegramUpdates.js';

export interface LeadWebhookSigningConfig {
  serviceId: string;
  secret: string;
}

let signingConfig: LeadWebhookSigningConfig | undefined;
let retryPolicy: WebhookRetryPolicy = { ...DEFAULT_WEBHOOK_RETRY_POLICY };
export const LEAD_WEBHOOK_TIMEOUT_MS = 8_000;

export function configureLeadWebhookSigning(config: LeadWebhookSigningConfig | undefined): void {
  signingConfig = config ? { serviceId: config.serviceId, secret: config.secret } : undefined;
}

export function configureLeadWebhookRetryPolicy(policy: WebhookRetryPolicy): void { retryPolicy = { ...policy }; }
export function getLeadWebhookRetryPolicy(): WebhookRetryPolicy { return { ...retryPolicy }; }

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

export function createAcademyHeaders(body: string, config: LeadWebhookSigningConfig, nowSeconds = Math.floor(Date.now() / 1000), nonce = randomBytes(24).toString('hex'), idempotencyKey?: string): Record<string, string> {
  const timestamp = String(nowSeconds);
  const canonical = `${timestamp}\n${nonce}\n${body}`;
  const signature = createHmac('sha256', config.secret).update(canonical, 'utf8').digest('hex');
  const stableKey = idempotencyKey ?? `lead-${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  return {
    'content-type': 'application/json',
    'X-Service-Id': config.serviceId,
    'X-Service-Timestamp': timestamp,
    'X-Service-Nonce': nonce,
    'X-Service-Signature': signature,
    'Idempotency-Key': stableKey,
  };
}

export async function sendLeadWebhook(webhookUrl: string | undefined, event: LeadWebhookEvent, lead: Lead, timeoutMs = LEAD_WEBHOOK_TIMEOUT_MS, idempotencyKey?: string): Promise<void> {
  if (!webhookUrl) return;
  const body = JSON.stringify(signingConfig ? toAcademyWebhookPayload(event, lead) : toWebhookPayload(event, lead));
  const stableKey = idempotencyKey ?? bodyIdempotencyKey(body);
  const headers = signingConfig ? createAcademyHeaders(body, signingConfig, Math.floor(Date.now() / 1000), randomBytes(24).toString('hex'), stableKey) : { 'content-type': 'application/json', 'Idempotency-Key': stableKey };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const deliver = async () => {
    const response = await fetch(webhookUrl, { method: 'POST', headers, body, signal: controller.signal });
    if (!response.ok) throw new Error(`Lead webhook failed with status ${response.status}`);
  };
  try {
    await runCurrentUpdateEffect(`webhook:${stableKey}`, deliver, { outcomeIsUncertain: isWebhookOutcomeUncertain });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Lead webhook timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverLeadWebhook(webhookUrl: string | undefined, failureStore: JsonWebhookFailureStore, event: LeadWebhookEvent, lead: Lead, timeoutMs = LEAD_WEBHOOK_TIMEOUT_MS, idempotencyKey?: string): Promise<void> {
  if (!webhookUrl) return;
  const stableKey = idempotencyKey ?? defaultWebhookIdempotencyKey(event, lead);
  try {
    await sendLeadWebhook(webhookUrl, event, lead, timeoutMs, stableKey);
  } catch (error) {
    console.error('Lead webhook delivery failed:', safeError(error));
    const category = classifyWebhookFailure(error);
    await failureStore.add({ event, lead, lastError: safeError(error), idempotencyKey: stableKey, outcomeUncertain: category === 'uncertain', failureCategory: category }, retryPolicy);
  }
}

export async function retryFailedWebhooks(webhookUrl: string | undefined, failureStore: JsonWebhookFailureStore, now = new Date()): Promise<{ attempted: number; sent: number; remaining: number }> {
  const failed = await failureStore.all();
  if (!webhookUrl || failed.length === 0) return { attempted: 0, sent: 0, remaining: failed.length };
  const startedAt = Date.now();
  const claimed: Awaited<ReturnType<JsonWebhookFailureStore['claimRetryable']>> = [];
  let sent = 0;
  for (let index = 0; index < Math.min(failed.length, 100); index += 1) {
    const claimNow = new Date(now.getTime() + Math.max(0, Date.now() - startedAt));
    const [item] = await failureStore.claimRetryable(claimNow, retryPolicy, 1);
    if (!item) break;
    claimed.push(item);
    try {
      await sendLeadWebhook(webhookUrl, item.event, item.lead, LEAD_WEBHOOK_TIMEOUT_MS, item.idempotencyKey);
      await failureStore.finishRetry(item, { sent: true }, new Date(), retryPolicy);
      sent += 1;
    } catch (error) {
      const category = classifyWebhookFailure(error);
      await failureStore.finishRetry(item, { sent: false, error: safeError(error), outcomeUncertain: category === 'uncertain', category }, new Date(), retryPolicy);
    }
  }
  const remainingItems = await failureStore.all();
  const states = { retryWait: 0, claimed: 0, uncertain: 0, deadLetter: 0 };
  for (const item of remainingItems) {
    if (item.state === 'RetryWait') states.retryWait += 1;
    else if (item.state === 'Claimed') states.claimed += 1;
    else if (item.state === 'Uncertain') states.uncertain += 1;
    else if (item.state === 'DeadLetter') states.deadLetter += 1;
  }
  console.info(JSON.stringify({ event: 'webhook_retry_run', attempted: claimed.length, sent, remaining: remainingItems.length, states }));
  return { attempted: claimed.length, sent, remaining: remainingItems.length };
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function classifyWebhookFailure(error: unknown): WebhookFailureCategory {
  if (error instanceof IndeterminateTelegramEffectError) return 'uncertain';
  const statusMatch = safeError(error).match(/failed with status (\d+)/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return 'transient';
  if (status !== undefined && status >= 400 && status < 500) return 'permanent';
  return 'uncertain';
}
function isWebhookOutcomeUncertain(error: unknown): boolean { return classifyWebhookFailure(error) === 'uncertain'; }
function defaultWebhookIdempotencyKey(event: LeadWebhookEvent, lead: Lead): string { return bodyIdempotencyKey(JSON.stringify(signingConfig ? toAcademyWebhookPayload(event, lead) : toWebhookPayload(event, lead))); }
function bodyIdempotencyKey(body: string): string { return `lead-${createHash('sha256').update(body, 'utf8').digest('hex')}`; }
