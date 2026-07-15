import type { BotSession, LeadSource } from './types.js';

export interface StartAttribution { source: LeadSource; campaignId?: string }

const START_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function parseStartAttribution(text: string | undefined): StartAttribution {
  const param = text?.trim().split(/\s+/)[1];
  if (!param || !START_PAYLOAD_PATTERN.test(param)) return { source: 'unknown' };
  if (param === 'ads' || param?.startsWith('ads_') || param?.startsWith('telegram_ads')) return { source: 'telegram_ads', campaignId: param === 'ads' ? 'legacy' : param };
  if (param === 'channel' || param.startsWith('channel_')) return { source: 'channel', campaignId: param === 'channel' ? undefined : param };
  if (param === 'organic') return { source: 'organic' };
  if (param === 'registration') return { source: 'registration' };
  if (param === 'ai_chat') return { source: 'ai_chat' };
  if (param === 'call_request') return { source: 'call_request' };
  return { source: 'unknown' };
}

export function explicitLeadSource(source: LeadSource | undefined, fallback: LeadSource): LeadSource {
  return source && source !== 'unknown' ? source : fallback;
}

export function resetSessionForStart(session: BotSession, attribution: StartAttribution): void {
  session.source = attribution.source;
  session.campaignId = attribution.campaignId;
  session.leadDraft = undefined;
  session.waitingForCallPhone = undefined;
  session.lessonIndex = undefined;
  session.quizIndex = undefined;
  session.quizScore = undefined;
  session.calculator = undefined;
}
