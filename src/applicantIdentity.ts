import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';
import { maskPhone, normalizeApplicantText, normalizeUzbekPhone } from './applicantValidation.js';
import type { Lead } from './types.js';

export const APPLICANT_IDENTITY_SCHEMA_VERSION = 1;
export const APPLICATION_CONSENT_VERSION = '2026-07-22.application.v1';
export const OUTBOUND_CONSENT_VERSION = '2026-07-22.outbound.v1';
export const FOLLOW_UP_CONSENT_VERSION = '2026-07-22.followup.v1';
export const APPLICATION_CONSENT_TEXT = 'Ariza uchun ism, yosh, hudud va tasdiqlangan telefon raqamingizni saqlashimizga rozimisiz? Ma\u2019lumotlar faqat arizani ko\u2018rib chiqish uchun ishlatiladi.';
export const OUTBOUND_CONSENT_TEXT = 'Arizangiz bo\u2018yicha bot yoki operator siz bilan bog\u2018lanishiga rozimisiz?';
export const FOLLOW_UP_CONSENT_TEXT = 'Arizani davom ettirish uchun eslatma xabarlarini olishga rozimisiz?';

export type ApplicantLifecycleState = 'NEW' | 'CONSENT_REQUIRED' | 'CONSENTED' | 'IDENTITY_PENDING' | 'VERIFIED' | 'APPLICATION_DRAFT' | 'SUBMITTED' | 'WITHDRAWN' | 'BLOCKED' | 'MERGE_REVIEW';
export type ApplicantIdentityStatus = 'ACTIVE' | 'CONFLICT' | 'BLOCKED' | 'WITHDRAWN';
export type ApplicantVerificationStatus = 'TELEGRAM_VERIFIED' | 'CONTACT_VERIFIED' | 'HUMAN_REVIEW_REQUIRED';
export type ConsentPurpose = 'application_processing' | 'outbound_applicant_message' | 'follow_up' | 'public_applicant_data' | 'marketing';
export type ConsentSource = 'telegram_wizard' | 'telegram_callback' | 'telegram_command';

export interface ConsentRecord {
  purpose: ConsentPurpose;
  status: 'GRANTED' | 'DECLINED' | 'REVOKED';
  version: string;
  text: string;
  timestamp: string;
  source: ConsentSource;
  revokedAt?: string;
}

export interface ApplicantAuditEvent {
  applicantId: string;
  eventType: string;
  consentVersion?: string;
  verificationResult?: string;
  actor: 'telegram_self' | 'system' | 'human_reviewer';
  timestamp: string;
  correlationId: string;
}

export interface ApplicantIdentity {
  applicantId: string;
  telegramUserId: number;
  telegramChatId: number;
  username?: string;
  normalizedPhone?: string;
  identityStatus: ApplicantIdentityStatus;
  verificationStatus: ApplicantVerificationStatus;
  lifecycleState: ApplicantLifecycleState;
  consents: Partial<Record<ConsentPurpose, ConsentRecord>>;
  createdAt: string;
  updatedAt: string;
  revocationTimestamp?: string;
  auditReferences: string[];
  submissionKey?: string;
}

interface ApplicantIdentityDatabase { schemaVersion: 1; applicants: ApplicantIdentity[]; audit: ApplicantAuditEvent[]; effectKeys: string[] }
interface LegacyApplicantIdentityDatabase { schemaVersion?: 0 | 1; applicants?: ApplicantIdentity[]; audit?: ApplicantAuditEvent[]; effectKeys?: string[] }
export interface TelegramIdentityInput { telegramUserId: number; telegramChatId: number; username?: string; chatType?: string }
export interface ConsentNotice { purpose: ConsentPurpose; version: string; text: string }
export type IdentityResult = { ok: true; applicant: ApplicantIdentity; created?: boolean; replayed?: boolean } | { ok: false; reason: 'invalid_actor' | 'conflict' | 'blocked' | 'not_found' | 'invalid_transition' | 'consent_required' | 'identity_unverified' | 'duplicate_submission'; applicant?: ApplicantIdentity };

const TRANSITIONS: Record<ApplicantLifecycleState, readonly ApplicantLifecycleState[]> = {
  NEW: ['CONSENT_REQUIRED', 'BLOCKED', 'MERGE_REVIEW'],
  CONSENT_REQUIRED: ['CONSENTED', 'WITHDRAWN', 'BLOCKED', 'MERGE_REVIEW'],
  CONSENTED: ['IDENTITY_PENDING', 'VERIFIED', 'WITHDRAWN', 'BLOCKED', 'MERGE_REVIEW'],
  IDENTITY_PENDING: ['VERIFIED', 'WITHDRAWN', 'BLOCKED', 'MERGE_REVIEW'],
  VERIFIED: ['APPLICATION_DRAFT', 'WITHDRAWN', 'BLOCKED', 'MERGE_REVIEW'],
  APPLICATION_DRAFT: ['SUBMITTED', 'WITHDRAWN', 'BLOCKED', 'MERGE_REVIEW'],
  SUBMITTED: ['WITHDRAWN', 'BLOCKED', 'MERGE_REVIEW'],
  WITHDRAWN: ['CONSENT_REQUIRED', 'BLOCKED', 'MERGE_REVIEW'],
  BLOCKED: [],
  MERGE_REVIEW: ['BLOCKED'],
};

export const CONSENT_NOTICES: Record<'application' | 'outbound' | 'followUp', ConsentNotice> = {
  application: { purpose: 'application_processing', version: APPLICATION_CONSENT_VERSION, text: APPLICATION_CONSENT_TEXT },
  outbound: { purpose: 'outbound_applicant_message', version: OUTBOUND_CONSENT_VERSION, text: OUTBOUND_CONSENT_TEXT },
  followUp: { purpose: 'follow_up', version: FOLLOW_UP_CONSENT_VERSION, text: FOLLOW_UP_CONSENT_TEXT },
};

export function deriveAuthoritativeTelegramIdentity(context: { from?: { id?: unknown; username?: unknown }; chat?: { id?: unknown; type?: unknown }; message?: Record<string, unknown> }): TelegramIdentityInput | undefined {
  const userId = context.from?.id;
  const chatId = context.chat?.id;
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId)) return undefined;
  return { telegramUserId: userId as number, telegramChatId: chatId as number, username: typeof context.from?.username === 'string' ? context.from.username : undefined, chatType: typeof context.chat?.type === 'string' ? context.chat.type : undefined };
}

export class JsonApplicantIdentityStore {
  constructor(private readonly filePath: string) {}

  async identify(input: TelegramIdentityInput, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    if (!validTelegramActor(input)) return { ok: false, reason: 'invalid_actor' };
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const existing = db.applicants.find((item) => item.telegramUserId === input.telegramUserId);
      if (existing) {
        if (existing.telegramChatId !== input.telegramChatId) return this.conflict(db, existing, correlationId, now, idempotencyKey);
        if (existing.identityStatus === 'BLOCKED' || existing.lifecycleState === 'BLOCKED') return { ok: false, reason: 'blocked', applicant: existing } as const;
        if (existing.identityStatus === 'CONFLICT' || existing.lifecycleState === 'MERGE_REVIEW') return { ok: false, reason: 'conflict', applicant: existing } as const;
        if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return { ok: true, applicant: existing, replayed: true } as const;
        const username = sanitizeUsername(input.username);
        if (username !== existing.username) {
          existing.username = username;
          existing.updatedAt = now.toISOString();
          appendAudit(db, existing, 'username_metadata_updated', 'telegram_self', correlationId, now);
          rememberKey(db.effectKeys, idempotencyKey);
          await this.write(db);
        }
        return { ok: true, applicant: existing, created: false } as const;
      }
      if (db.applicants.some((item) => item.telegramChatId === input.telegramChatId)) return { ok: false, reason: 'conflict' } as const;
      const at = now.toISOString();
      const applicant: ApplicantIdentity = {
        applicantId: randomUUID(), telegramUserId: input.telegramUserId, telegramChatId: input.telegramChatId,
        username: sanitizeUsername(input.username), identityStatus: 'ACTIVE', verificationStatus: 'TELEGRAM_VERIFIED',
        lifecycleState: 'CONSENT_REQUIRED', consents: {}, createdAt: at, updatedAt: at, auditReferences: [],
      };
      db.applicants.push(applicant);
      appendAudit(db, applicant, 'identity_created', 'telegram_self', correlationId, now, undefined, 'telegram_verified');
      rememberKey(db.effectKeys, idempotencyKey);
      await this.write(db);
      return { ok: true, applicant, created: true } as const;
    });
  }

  async recordConsent(applicantId: string, notice: ConsentNotice, accepted: boolean, explicitAction: boolean, source: ConsentSource, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    if (!explicitAction || !isRegisteredConsentNotice(notice)) return { ok: false, reason: 'consent_required' };
    return this.mutateApplicant(applicantId, correlationId, now, idempotencyKey, (db, applicant) => {
      if (applicant.lifecycleState === 'BLOCKED') return { ok: false, reason: 'blocked', applicant } as const;
      if (applicant.identityStatus === 'CONFLICT' || applicant.lifecycleState === 'MERGE_REVIEW') return { ok: false, reason: 'conflict', applicant } as const;
      if (accepted && notice.purpose === 'application_processing' && applicant.lifecycleState === 'SUBMITTED') return { ok: false, reason: 'duplicate_submission', applicant } as const;
      if (accepted && notice.purpose === 'application_processing' && applicant.identityStatus === 'WITHDRAWN') applicant.identityStatus = 'ACTIVE';
      applicant.consents[notice.purpose] = { purpose: notice.purpose, status: accepted ? 'GRANTED' : 'DECLINED', version: notice.version, text: notice.text, timestamp: now.toISOString(), source };
      if (notice.purpose === 'application_processing') {
        if (accepted) {
          if (applicant.lifecycleState === 'WITHDRAWN') { transition(applicant, 'CONSENT_REQUIRED'); transition(applicant, 'CONSENTED'); }
          else if (applicant.lifecycleState === 'CONSENT_REQUIRED') transition(applicant, 'CONSENTED');
        } else {
          for (const consent of Object.values(applicant.consents)) {
            if (consent?.status === 'GRANTED') { consent.status = 'REVOKED'; consent.revokedAt = now.toISOString(); }
          }
          transition(applicant, 'WITHDRAWN');
          applicant.identityStatus = 'WITHDRAWN';
          applicant.revocationTimestamp = now.toISOString();
          applicant.normalizedPhone = undefined;
          applicant.username = undefined;
        }
      }
      applicant.updatedAt = now.toISOString();
      appendAudit(db, applicant, accepted ? 'consent_granted' : 'consent_declined', 'telegram_self', correlationId, now, notice.version);
      return { ok: true, applicant } as const;
    });
  }

  async attachTelegramContact(applicantId: string, phone: string, evidence: { senderUserId: number; contactUserId?: number; forwarded: boolean }, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    const normalized = normalizeUzbekPhone(phone);
    if (!normalized.ok) return { ok: false, reason: 'identity_unverified' };
    return this.mutateApplicant(applicantId, correlationId, now, idempotencyKey, (db, applicant) => {
      if (evidence.forwarded || evidence.contactUserId !== evidence.senderUserId || evidence.senderUserId !== applicant.telegramUserId) {
        appendAudit(db, applicant, 'contact_ownership_rejected', 'telegram_self', correlationId, now, undefined, 'mismatch');
        return { ok: false, reason: 'identity_unverified', applicant } as const;
      }
      const owner = db.applicants.find((item) => item.applicantId !== applicantId && item.normalizedPhone === normalized.value);
      if (owner) {
        markConflict(db, owner, correlationId, now);
        markConflict(db, applicant, correlationId, now);
        return { ok: false, reason: 'conflict', applicant } as const;
      }
      applicant.normalizedPhone = normalized.value;
      applicant.verificationStatus = 'CONTACT_VERIFIED';
      if (['CONSENTED', 'IDENTITY_PENDING'].includes(applicant.lifecycleState)) transition(applicant, 'VERIFIED');
      applicant.updatedAt = now.toISOString();
      appendAudit(db, applicant, 'contact_ownership_verified', 'telegram_self', correlationId, now, undefined, 'matched');
      return { ok: true, applicant } as const;
    });
  }

  async beginApplication(applicantId: string, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    return this.mutateApplicant(applicantId, correlationId, now, idempotencyKey, (db, applicant) => {
      if (!hasConsent(applicant, CONSENT_NOTICES.application)) return { ok: false, reason: 'consent_required', applicant } as const;
      if (applicant.verificationStatus !== 'CONTACT_VERIFIED') {
        if (applicant.lifecycleState === 'CONSENTED') transition(applicant, 'IDENTITY_PENDING');
        return { ok: false, reason: 'identity_unverified', applicant } as const;
      }
      if (applicant.lifecycleState === 'VERIFIED') transition(applicant, 'APPLICATION_DRAFT');
      if (applicant.lifecycleState !== 'APPLICATION_DRAFT') return { ok: false, reason: 'invalid_transition', applicant } as const;
      applicant.updatedAt = now.toISOString();
      appendAudit(db, applicant, 'application_draft_started', 'telegram_self', correlationId, now);
      return { ok: true, applicant } as const;
    });
  }

  async submitApplication(applicantId: string, submissionKey: string, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    return this.mutateApplicant(applicantId, correlationId, now, idempotencyKey, (db, applicant) => {
      if (!hasConsent(applicant, CONSENT_NOTICES.application)) return { ok: false, reason: 'consent_required', applicant } as const;
      if (applicant.verificationStatus !== 'CONTACT_VERIFIED') return { ok: false, reason: 'identity_unverified', applicant } as const;
      if (applicant.submissionKey === submissionKey && applicant.lifecycleState === 'SUBMITTED') return { ok: true, applicant, replayed: true } as const;
      if (applicant.lifecycleState === 'SUBMITTED') return { ok: false, reason: 'duplicate_submission', applicant } as const;
      if (applicant.lifecycleState !== 'APPLICATION_DRAFT') return { ok: false, reason: 'invalid_transition', applicant } as const;
      transition(applicant, 'SUBMITTED');
      applicant.submissionKey = submissionKey;
      applicant.updatedAt = now.toISOString();
      appendAudit(db, applicant, 'application_submitted', 'telegram_self', correlationId, now);
      return { ok: true, applicant } as const;
    });
  }

  async withdraw(applicantId: string, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    return this.mutateApplicant(applicantId, correlationId, now, idempotencyKey, (db, applicant) => {
      for (const consent of Object.values(applicant.consents)) if (consent?.status === 'GRANTED') { consent.status = 'REVOKED'; consent.revokedAt = now.toISOString(); }
      if (applicant.lifecycleState !== 'BLOCKED' && applicant.lifecycleState !== 'MERGE_REVIEW') transition(applicant, 'WITHDRAWN');
      if (applicant.lifecycleState === 'WITHDRAWN') applicant.identityStatus = 'WITHDRAWN';
      applicant.revocationTimestamp = now.toISOString();
      applicant.normalizedPhone = undefined;
      applicant.username = undefined;
      applicant.updatedAt = now.toISOString();
      appendAudit(db, applicant, 'consent_withdrawn', 'telegram_self', correlationId, now);
      return { ok: true, applicant } as const;
    });
  }

  async blockApplicant(applicantId: string, actorId: number, reason: string, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || reason.trim().length < 8) return { ok: false, reason: 'invalid_actor' };
    return this.mutateApplicant(applicantId, correlationId, now, idempotencyKey, (db, applicant) => {
      if (applicant.lifecycleState !== 'BLOCKED') transition(applicant, 'BLOCKED');
      applicant.identityStatus = 'BLOCKED';
      applicant.updatedAt = now.toISOString();
      appendAudit(db, applicant, 'applicant_blocked', 'human_reviewer', correlationId, now, undefined, 'blocked');
      return { ok: true, applicant } as const;
    });
  }

  async requestMergeReview(applicantId: string, conflictingApplicantId: string, actorId: number, reason: string, correlationId: string, now = new Date(), idempotencyKey?: string): Promise<IdentityResult> {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || reason.trim().length < 8 || applicantId === conflictingApplicantId) return { ok: false, reason: 'invalid_actor' };
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const applicant = db.applicants.find((item) => item.applicantId === applicantId);
      const conflict = db.applicants.find((item) => item.applicantId === conflictingApplicantId);
      if (!applicant || !conflict) return { ok: false, reason: 'not_found' } as const;
      if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return { ok: true, applicant, replayed: true } as const;
      markConflict(db, applicant, correlationId, now, 'human_reviewer');
      markConflict(db, conflict, correlationId, now, 'human_reviewer');
      rememberKey(db.effectKeys, idempotencyKey);
      await this.write(db);
      return { ok: true, applicant } as const;
    });
  }

  async getByTelegramUserId(telegramUserId: number): Promise<ApplicantIdentity | undefined> { return (await this.read()).applicants.find((item) => item.telegramUserId === telegramUserId); }
  async get(applicantId: string): Promise<ApplicantIdentity | undefined> { return (await this.read()).applicants.find((item) => item.applicantId === applicantId); }
  async all(): Promise<ApplicantIdentity[]> { return (await this.read()).applicants; }
  async audit(): Promise<ApplicantAuditEvent[]> { return (await this.read()).audit; }
  async hasConsent(telegramUserId: number, notice: ConsentNotice): Promise<boolean> { const applicant = await this.getByTelegramUserId(telegramUserId); return Boolean(applicant && applicant.identityStatus === 'ACTIVE' && hasConsent(applicant, notice)); }
  async maySendFollowUp(telegramUserId: number): Promise<boolean> { const applicant = await this.getByTelegramUserId(telegramUserId); return Boolean(applicant && applicant.identityStatus === 'ACTIVE' && hasConsent(applicant, CONSENT_NOTICES.outbound) && hasConsent(applicant, CONSENT_NOTICES.followUp)); }
  async mayProcessApplication(telegramUserId: number): Promise<boolean> { return this.hasConsent(telegramUserId, CONSENT_NOTICES.application); }

  private async conflict(db: ApplicantIdentityDatabase, applicant: ApplicantIdentity, correlationId: string, now: Date, idempotencyKey?: string): Promise<IdentityResult> {
    if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return { ok: false, reason: 'conflict', applicant };
    markConflict(db, applicant, correlationId, now);
    rememberKey(db.effectKeys, idempotencyKey);
    await this.write(db);
    return { ok: false, reason: 'conflict', applicant };
  }

  private async mutateApplicant(applicantId: string, correlationId: string, now: Date, idempotencyKey: string | undefined, operation: (db: ApplicantIdentityDatabase, applicant: ApplicantIdentity) => IdentityResult): Promise<IdentityResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const applicant = db.applicants.find((item) => item.applicantId === applicantId);
      if (!applicant) return { ok: false, reason: 'not_found' } as const;
      if (idempotencyKey && db.effectKeys.includes(idempotencyKey)) return { ok: true, applicant, replayed: true } as const;
      const result = operation(db, applicant);
      if (result.ok || result.applicant) {
        if (result.ok) rememberKey(db.effectKeys, idempotencyKey);
        await this.write(db);
      }
      return result;
    });
  }

  private async read(): Promise<ApplicantIdentityDatabase> { return migrateApplicantIdentityDatabase(await readJson<LegacyApplicantIdentityDatabase>(this.filePath, { applicants: [] })); }
  private async write(db: ApplicantIdentityDatabase): Promise<void> { await atomicWriteJson(this.filePath, db); }
}

export function migrateApplicantIdentityDatabase(raw: LegacyApplicantIdentityDatabase): ApplicantIdentityDatabase {
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 0 && raw.schemaVersion !== 1) throw new Error('Unsupported applicant identity schema version.');
  const applicants = Array.isArray(raw.applicants) ? raw.applicants.map(normalizeApplicant) : [];
  const audit = Array.isArray(raw.audit) ? raw.audit.map(sanitizeAuditEvent) : [];
  failClosedLegacyConflicts(applicants);
  return { schemaVersion: APPLICANT_IDENTITY_SCHEMA_VERSION, applicants, audit, effectKeys: Array.isArray(raw.effectKeys) ? raw.effectKeys.slice(-10_000) : [] };
}

export function rollbackApplicantIdentityDatabase(db: ApplicantIdentityDatabase): Omit<LegacyApplicantIdentityDatabase, 'schemaVersion'> {
  return { applicants: db.applicants, audit: db.audit, effectKeys: db.effectKeys };
}

export function maskedApplicantIdentity(applicant: ApplicantIdentity): { applicantId: string; telegram: string; phone: string; state: ApplicantLifecycleState; verification: ApplicantVerificationStatus } {
  return { applicantId: applicant.applicantId, telegram: `tg-***${String(applicant.telegramUserId).slice(-3)}`, phone: maskPhone(applicant.normalizedPhone), state: applicant.lifecycleState, verification: applicant.verificationStatus };
}

export function withdrawnLeadAnonymizationPatch(): Partial<Lead> {
  return { username: undefined, firstName: undefined, lastName: undefined, fullName: 'Withdrawn applicant', phone: '', city: '', age: '', workStatus: '', experience: '', goal: '', paymentOption: '', intent: '', lastMessage: 'consent withdrawn', messages: [], operatorNote: '', nextFollowUp: '', preferredTime: '', notes: undefined };
}

export function isSafeApplicantAuditEvent(value: ApplicantAuditEvent): boolean {
  return Object.keys(value).every((key) => ['applicantId', 'eventType', 'consentVersion', 'verificationResult', 'actor', 'timestamp', 'correlationId'].includes(key))
    && !/[+]?998\d{9}|message|payload|token|phone|free.?text/i.test(JSON.stringify(value));
}

function validTelegramActor(input: TelegramIdentityInput): boolean {
  return Number.isSafeInteger(input.telegramUserId) && input.telegramUserId > 0 && Number.isSafeInteger(input.telegramChatId) && input.telegramChatId > 0 && input.telegramUserId === input.telegramChatId && (!input.chatType || input.chatType === 'private');
}
function sanitizeUsername(value: string | undefined): string | undefined { if (!value) return undefined; const normalized = normalizeApplicantText(value); return /^[A-Za-z0-9_]{5,32}$/.test(normalized) ? normalized : undefined; }
function isRegisteredConsentNotice(notice: ConsentNotice): boolean { return Object.values(CONSENT_NOTICES).some((registered) => registered.purpose === notice.purpose && registered.version === notice.version && registered.text === notice.text); }
function hasConsent(applicant: ApplicantIdentity, notice: ConsentNotice): boolean { const record = applicant.consents[notice.purpose]; return Boolean(isRegisteredConsentNotice(notice) && record && record.status === 'GRANTED' && record.version === notice.version && record.text === notice.text && !record.revokedAt); }
function transition(applicant: ApplicantIdentity, next: ApplicantLifecycleState): void { if (applicant.lifecycleState === next) return; if (!TRANSITIONS[applicant.lifecycleState].includes(next)) throw new Error(`Invalid applicant lifecycle transition ${applicant.lifecycleState} -> ${next}.`); applicant.lifecycleState = next; }
function markConflict(db: ApplicantIdentityDatabase, applicant: ApplicantIdentity, correlationId: string, now: Date, actor: ApplicantAuditEvent['actor'] = 'system'): void { applicant.identityStatus = 'CONFLICT'; applicant.verificationStatus = 'HUMAN_REVIEW_REQUIRED'; applicant.lifecycleState = 'MERGE_REVIEW'; applicant.updatedAt = now.toISOString(); appendAudit(db, applicant, 'identity_conflict_detected', actor, correlationId, now, undefined, 'human_review_required'); }
function appendAudit(db: ApplicantIdentityDatabase, applicant: ApplicantIdentity, eventType: string, actor: ApplicantAuditEvent['actor'], correlationId: string, now: Date, consentVersion?: string, verificationResult?: string): void { const event = sanitizeAuditEvent({ applicantId: applicant.applicantId, eventType, consentVersion, verificationResult, actor, timestamp: now.toISOString(), correlationId: safeCorrelationId(correlationId) }); db.audit.push(event); if (db.audit.length > 20_000) db.audit.splice(0, db.audit.length - 20_000); applicant.auditReferences = [...applicant.auditReferences, auditReference(event)].slice(-200); }
function sanitizeAuditEvent(value: ApplicantAuditEvent): ApplicantAuditEvent { return { applicantId: String(value.applicantId), eventType: safeEvent(value.eventType), consentVersion: value.consentVersion ? safeVersion(value.consentVersion) : undefined, verificationResult: value.verificationResult ? safeEvent(value.verificationResult) : undefined, actor: ['telegram_self', 'system', 'human_reviewer'].includes(value.actor) ? value.actor : 'system', timestamp: new Date(value.timestamp).toISOString(), correlationId: safeCorrelationId(value.correlationId) }; }
function safeEvent(value: string): string { const result = value.replace(/[^a-z0-9_-]/gi, '').slice(0, 80); return result || 'invalid'; }
function safeVersion(value: string): string { return value.replace(/[^a-z0-9._-]/gi, '').slice(0, 80); }
function safeCorrelationId(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24); }
function auditReference(event: ApplicantAuditEvent): string { return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex').slice(0, 24); }
function normalizeApplicant(value: ApplicantIdentity): ApplicantIdentity { const phone = value.normalizedPhone ? normalizeUzbekPhone(value.normalizedPhone) : undefined; return { ...value, username: sanitizeUsername(value.username), normalizedPhone: phone?.ok ? phone.value : undefined, identityStatus: value.identityStatus ?? 'ACTIVE', verificationStatus: value.verificationStatus ?? 'TELEGRAM_VERIFIED', lifecycleState: value.lifecycleState ?? 'CONSENT_REQUIRED', consents: value.consents ?? {}, auditReferences: Array.isArray(value.auditReferences) ? value.auditReferences.slice(-200) : [], createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt ?? value.createdAt).toISOString() }; }
function failClosedLegacyConflicts(applicants: ApplicantIdentity[]): void {
  const seen = new Map<string, ApplicantIdentity>();
  const conflicts = new Set<ApplicantIdentity>();
  for (const applicant of applicants) {
    const keys = [`applicant:${applicant.applicantId}`, `user:${applicant.telegramUserId}`, `chat:${applicant.telegramChatId}`];
    if (applicant.normalizedPhone) keys.push(`phone:${applicant.normalizedPhone}`);
    if (!validTelegramActor({ telegramUserId: applicant.telegramUserId, telegramChatId: applicant.telegramChatId, chatType: 'private' })) conflicts.add(applicant);
    for (const key of keys) {
      const previous = seen.get(key);
      if (previous) {
        conflicts.add(previous);
        conflicts.add(applicant);
      } else {
        seen.set(key, applicant);
      }
    }
  }
  for (const applicant of conflicts) {
    applicant.identityStatus = 'CONFLICT';
    applicant.verificationStatus = 'HUMAN_REVIEW_REQUIRED';
    applicant.lifecycleState = 'MERGE_REVIEW';
  }
}
function rememberKey(keys: string[], key: string | undefined): void { if (!key || keys.includes(key)) return; keys.push(key); if (keys.length > 10_000) keys.splice(0, keys.length - 10_000); }
