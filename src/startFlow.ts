import type { BotSession, LeadSource } from './types.js';

export interface StartAttribution { source: LeadSource; campaignId?: string }

export function parseStartAttribution(text: string | undefined): StartAttribution {
  const param = text?.split(/\s+/)[1];
  if (param === 'ads' || param?.startsWith('ads_') || param?.startsWith('telegram_ads')) return { source: 'telegram_ads', campaignId: param === 'ads' ? 'legacy' : param };
  if (param === 'channel') return { source: 'channel' };
  if (param === 'organic') return { source: 'organic' };
  if (param === 'registration') return { source: 'registration' };
  if (param === 'ai_chat') return { source: 'ai_chat' };
  if (param === 'call_request') return { source: 'call_request' };
  return { source: 'unknown' };
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
