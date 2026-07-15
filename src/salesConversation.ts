import { randomUUID } from 'node:crypto';
import type { JsonLeadStore, JsonWebhookFailureStore, LeadUpsertResult } from './storage.js';
import type { AiLeadScore, Lead, LeadSource, LeadStatus } from './types.js';
import { deliverLeadWebhook } from './webhook.js';

export interface SalesConversationInput {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  message: string;
  score: AiLeadScore;
  reason: string;
  intent: string;
  source?: LeadSource;
  campaignId?: string;
  phone?: string;
  now?: string;
}

export interface SalesConversationDependencies {
  store: Pick<JsonLeadStore, 'getByTelegramId' | 'upsert'>;
  failureStore: JsonWebhookFailureStore;
  leadWebhookUrl?: string;
  notifyHotLead: (lead: Lead) => Promise<void>;
  deliverWebhook?: typeof deliverLeadWebhook;
}

export interface SalesConversationResult {
  saved?: LeadUpsertResult;
  errors: Array<'storage' | 'webhook' | 'admin'>;
}

const SCORE_STATUS: Record<AiLeadScore, LeadStatus> = { COLD: 'New', WARM: 'Warm', HOT: 'Hot' };
const COURSE_TOPIC_PATTERN = /(kurs|course|курс|kamera|camera|камер|videokuzatuv|видеонаблю|dars|дарс|nvr|dvr|cctv|ustoz|ўқитувчи|o['‘’`]?qituvchi)/i;

export function isPermittedSalesConversation(message: string, score: AiLeadScore): boolean {
  return score !== 'COLD' || COURSE_TOPIC_PATTERN.test(message);
}

export async function persistSalesConversation(input: SalesConversationInput, dependencies: SalesConversationDependencies): Promise<SalesConversationResult> {
  let existing: Lead | undefined;
  try {
    existing = await dependencies.store.getByTelegramId(input.telegramId);
  } catch (error) {
    console.error('AI sales lead lookup failed:', safeError(error));
    return { errors: ['storage'] };
  }

  const now = input.now ?? new Date().toISOString();
  const displayName = [input.firstName, input.lastName].filter(Boolean).join(' ') || input.username || 'Telegram user';
  const lead: Lead = {
    ...(existing ?? {} as Lead),
    id: existing?.id ?? randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    telegramId: input.telegramId,
    username: input.username ?? existing?.username,
    firstName: input.firstName ?? existing?.firstName,
    lastName: input.lastName ?? existing?.lastName,
    fullName: existing?.fullName || displayName,
    phone: input.phone || existing?.phone || '',
    age: existing?.age || '',
    city: existing?.city || '',
    workStatus: existing?.workStatus || '',
    experience: existing?.experience || '',
    preferredTime: existing?.preferredTime || '',
    notes: existing?.notes,
    goal: existing?.goal || 'WST Academy course',
    paymentOption: existing?.paymentOption || '',
    status: SCORE_STATUS[input.score],
    source: input.source && input.source !== 'unknown' ? input.source : existing?.source || 'ai_chat',
    campaignId: input.campaignId || existing?.campaignId,
    intent: input.intent,
    lastMessage: input.message,
    messages: existing?.messages ?? [{ text: input.message, createdAt: now }],
    operatorNote: existing?.operatorNote || '',
    nextFollowUp: existing?.nextFollowUp || '',
    paymentStatus: existing?.paymentStatus || '',
    aiLeadScore: input.score,
    aiLeadReason: input.reason,
  };

  let saved: LeadUpsertResult;
  try {
    saved = await dependencies.store.upsert(lead);
  } catch (error) {
    console.error('AI sales lead persistence failed:', safeError(error));
    return { errors: ['storage'] };
  }

  const errors: SalesConversationResult['errors'] = [];
  try {
    await (dependencies.deliverWebhook ?? deliverLeadWebhook)(dependencies.leadWebhookUrl, dependencies.failureStore, saved.created ? 'lead_created' : 'lead_updated', saved.lead);
  } catch (error) {
    console.error('AI sales lead webhook failed:', safeError(error));
    errors.push('webhook');
  }

  if (saved.hotEscalated) {
    try {
      await dependencies.notifyHotLead(saved.lead);
    } catch (error) {
      console.error('AI sales lead admin notification failed:', safeError(error));
      errors.push('admin');
    }
  }
  return { saved, errors };
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
