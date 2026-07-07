import type { Context, Scenes } from 'telegraf';

export type LeadStatus = 'new' | 'notified';

export interface Lead {
  id: string;
  createdAt: string;
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  phone: string;
  age: string;
  district: string;
  experience: string;
  preferredTime: string;
  notes?: string;
  source: string;
  status: LeadStatus;
}

export interface LeadDraft {
  fullName?: string;
  phone?: string;
  age?: string;
  district?: string;
  experience?: string;
  preferredTime?: string;
  notes?: string;
}

export interface BotSession extends Scenes.WizardSessionData {
  leadDraft?: LeadDraft;
}

export type BotContext = Context & Scenes.WizardContext<BotSession>;
