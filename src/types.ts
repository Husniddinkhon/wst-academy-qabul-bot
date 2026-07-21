import type { Context, Scenes } from 'telegraf';

export type LeadStatus = 'New' | 'Warm' | 'Hot' | 'RegistrationCompleted' | 'CallRequested' | 'OperatorContacted' | 'Paid' | 'Rejected';
export type LeadSource = 'telegram_ads' | 'organic' | 'channel' | 'call_request' | 'registration' | 'ai_chat' | 'unknown';
export type LeadWebhookEvent = 'lead_created' | 'lead_updated' | 'hot_lead' | 'call_request';
export type StudentStatus = 'NotEnrolled' | 'Enrolled' | 'Active' | 'Completed' | 'Dropped';
export type AiLeadScore = 'HOT' | 'WARM' | 'COLD';

export interface LeadMessage {
  text: string;
  createdAt: string;
}

export interface Lead {
  id: string;
  createdAt: string;
  updatedAt: string;
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  phone: string;
  city: string;
  age: string;
  workStatus: string;
  experience: string;
  goal: string;
  paymentOption: string;
  status: LeadStatus;
  source: LeadSource;
  intent: string;
  lastMessage: string;
  messages: LeadMessage[];
  operatorNote: string;
  nextFollowUp: string;
  paymentStatus: string;
  preferredTime: string;
  notes?: string;
  campaignId?: string;
  studentStatus?: StudentStatus;
  agentActionCount?: number;
  lastAgentAction?: string;
  lastAgentAt?: string;
  aiLeadScore?: AiLeadScore;
  aiLeadReason?: string;
}

export interface LeadDraft {
  fullName?: string;
  phone?: string;
  age?: string;
  city?: string;
  experience?: string;
  preferredTime?: string;
  notes?: string;
}

export interface BotSession extends Scenes.WizardSessionData {
  leadDraft?: LeadDraft;
  waitingForCallPhone?: {
    message: string;
  };
  source?: LeadSource;
  campaignId?: string;
  lessonIndex?: number;
  quizIndex?: number;
  quizScore?: number;
  calculator?: {
    step: 'cameras' | 'bitrate' | 'days';
    cameras?: number;
    bitrate?: number;
  };
}

export interface FollowUpState {
  telegramId: number;
  startedAt: string;
  count: number;
  lastSentAt?: string;
  registrationCompleted?: boolean;
  followUpId?: string;
  task?: 'registration_incomplete' | 'warm_no_phone';
  dueAt?: string;
  timeZone?: 'Asia/Tashkent';
  deliveryState?: 'Pending' | 'Claimed' | 'Sending' | 'RetryWait' | 'Sent' | 'Uncertain' | 'Failed' | 'Cancelled';
  claimToken?: string;
  claimWorkerId?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  attempts?: number;
  nextRetryAt?: string;
  lastError?: string;
  terminalAt?: string;
  audit?: FollowUpAuditEvent[];
}

export interface FollowUpAuditEvent {
  at: string;
  event: string;
  workerId?: string;
  followUpId?: string;
  reason?: string;
}

export type BotContext = Context & Scenes.WizardContext<BotSession> & { session: BotSession };
