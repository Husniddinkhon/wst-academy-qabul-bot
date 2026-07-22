import type { Lead } from './types.js';
import { maskPhone } from './applicantValidation.js';
import { leadReference } from './leadSla.js';

export function formatLead(lead: Lead): string {
  return [
    `🆕 Yangi lead: ${lead.fullName}`,
    `🕒 Sana: ${new Date(lead.createdAt).toLocaleString('uz-UZ')}`,
    `🆔 Telegram ID: ${lead.telegramId}`,
    lead.username ? `👤 Username: @${lead.username}` : undefined,
    `📞 Telefon: ${lead.phone}`,
    `🎂 Yosh: ${lead.age}`,
    `📍 Hudud: ${lead.city}`,
    `📌 Status: ${lead.status}`,
    `🔎 Source: ${lead.source}`,
    `🛠 Tajriba: ${lead.experience}`,
    `⏰ Qulay vaqt: ${lead.preferredTime}`,
    lead.notes ? `📝 Izoh: ${lead.notes}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatLeadList(leads: Lead[], emptyText: string): string {
  if (leads.length === 0) return emptyText;

  return leads
    .map((lead, index) => `${index + 1}. ${lead.fullName} — ${lead.phone} — ${new Date(lead.createdAt).toLocaleString('uz-UZ')}`)
    .join('\n');
}

export function formatMaskedLead(lead: Lead): string {
  return [
    `Applicant: ${leadReference(lead)}`,
    `Created: ${new Date(lead.createdAt).toLocaleString('uz-UZ')}`,
    `Phone: ${maskPhone(lead.phone)}`,
    `Region: ${lead.city}`,
    `Status: ${lead.status}`,
    `Source: ${lead.source}`,
    `Student: ${lead.studentStatus}`,
  ].join('\n');
}

export function formatMaskedLeadList(leads: Lead[], emptyText: string): string {
  if (leads.length === 0) return emptyText;
  return leads
    .map((lead, index) => `${index + 1}. ${leadReference(lead)} — ${maskPhone(lead.phone)} — ${lead.status} — ${new Date(lead.createdAt).toLocaleString('uz-UZ')}`)
    .join('\n');
}
