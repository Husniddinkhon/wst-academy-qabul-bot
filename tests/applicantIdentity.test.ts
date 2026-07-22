import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Telegraf } from 'telegraf';
import {
  APPLICATION_CONSENT_TEXT, APPLICATION_CONSENT_VERSION, CONSENT_NOTICES, deriveAuthoritativeTelegramIdentity,
  isSafeApplicantAuditEvent, JsonApplicantIdentityStore, maskedApplicantIdentity, migrateApplicantIdentityDatabase,
  rollbackApplicantIdentityDatabase, withdrawnLeadAnonymizationPatch,
} from '../src/applicantIdentity.js';
import { processFollowUps } from '../src/followups.js';
import { JsonFollowUpStore, JsonLeadStore } from '../src/storage.js';
import type { BotContext } from '../src/types.js';

const NOW = new Date('2026-07-22T10:00:00.000Z');
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'applicant-identity-'));
  const file = path.join(directory, 'identities.json');
  return { directory, file, store: new JsonApplicantIdentityStore(file), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function identify(store: JsonApplicantIdentityStore, id = 1001, username = 'student_one') {
  const result = await store.identify({ telegramUserId: id, telegramChatId: id, username, chatType: 'private' }, `update-${id}`, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('identity fixture failed');
  return result.applicant;
}
async function consent(store: JsonApplicantIdentityStore, applicantId: string, notice = CONSENT_NOTICES.application) {
  const result = await store.recordConsent(applicantId, notice, true, true, 'telegram_wizard', `consent-${notice.purpose}`, NOW);
  assert.equal(result.ok, true);
  return result;
}
async function verifyContact(store: JsonApplicantIdentityStore, applicantId: string, userId = 1001, phone = '+998901234567') {
  return store.attachTelegramContact(applicantId, phone, { senderUserId: userId, contactUserId: userId, forwarded: false }, 'contact', NOW);
}

test('submission requires explicit current application consent and verified identity', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft', NOW)).reason, 'consent_required');
    assert.equal((await f.store.recordConsent(applicant.applicantId, CONSENT_NOTICES.application, true, false, 'telegram_wizard', 'implicit', NOW)).ok, false);
    await consent(f.store, applicant.applicantId);
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft', NOW)).reason, 'identity_unverified');
    assert.equal((await verifyContact(f.store, applicant.applicantId)).ok, true);
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft', NOW)).ok, true);
    assert.equal((await f.store.submitApplication(applicant.applicantId, 'submission-1', 'submit', NOW)).ok, true);
  } finally { await f.cleanup(); }
});

test('failed identity mutations never replay as successful idempotent effects', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    const key = 'update-100:identity:begin';
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft-before-consent', NOW, key)).reason, 'consent_required');
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft-before-consent-retry', NOW, key)).reason, 'consent_required');
    await consent(f.store, applicant.applicantId);
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft-before-contact', NOW, key)).reason, 'identity_unverified');
    await verifyContact(f.store, applicant.applicantId);
    assert.equal((await f.store.beginApplication(applicant.applicantId, 'draft-after-contact', NOW, key)).ok, true);
    const replay = await f.store.beginApplication(applicant.applicantId, 'draft-after-contact-retry', NOW, key);
    assert.equal(replay.ok && replay.replayed, true);
  } finally { await f.cleanup(); }
});

test('decline and withdrawal block processing and remove direct contact metadata', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    const declined = await f.store.recordConsent(applicant.applicantId, CONSENT_NOTICES.application, false, true, 'telegram_wizard', 'decline', NOW);
    assert.equal(declined.ok && declined.applicant.lifecycleState, 'WITHDRAWN');
    assert.equal(declined.ok && declined.applicant.username, undefined);
    assert.equal(declined.ok && declined.applicant.identityStatus, 'WITHDRAWN');
    assert.equal(await f.store.mayProcessApplication(1001), false);
    await consent(f.store, applicant.applicantId);
    await verifyContact(f.store, applicant.applicantId);
    const withdrawn = await f.store.withdraw(applicant.applicantId, 'withdraw', NOW);
    assert.equal(withdrawn.ok, true);
    if (withdrawn.ok) {
      assert.equal(withdrawn.applicant.normalizedPhone, undefined);
      assert.equal(withdrawn.applicant.username, undefined);
      assert.equal(withdrawn.applicant.consents.application_processing?.status, 'REVOKED');
    }
    assert.equal(await f.store.mayProcessApplication(1001), false);
    assert.equal(await f.store.maySendFollowUp(1001), false);
    const anonymized = withdrawnLeadAnonymizationPatch();
    assert.equal(anonymized.phone, '');
    assert.equal(anonymized.fullName, 'Withdrawn applicant');
    assert.deepEqual(anonymized.messages, []);
    assert.equal(anonymized.notes, undefined);
  } finally { await f.cleanup(); }
});

test('consent version change invalidates the previous grant', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    await consent(f.store, applicant.applicantId);
    assert.equal(await f.store.hasConsent(1001, CONSENT_NOTICES.application), true);
    assert.equal(await f.store.hasConsent(1001, { ...CONSENT_NOTICES.application, version: `${APPLICATION_CONSENT_VERSION}.next`, text: `${APPLICATION_CONSENT_TEXT} Yangilangan.` }), false);
    assert.equal((await f.store.recordConsent(applicant.applicantId, { ...CONSENT_NOTICES.application, version: 'unregistered' }, true, true, 'telegram_wizard', 'unregistered', NOW)).reason, 'consent_required');
  } finally { await f.cleanup(); }
});

test('Telegram contact ownership must match and forwarded contacts are rejected', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    await consent(f.store, applicant.applicantId);
    assert.equal((await f.store.attachTelegramContact(applicant.applicantId, '+998901234567', { senderUserId: 1001, contactUserId: 2002, forwarded: false }, 'mismatch', NOW)).reason, 'identity_unverified');
    assert.equal((await f.store.attachTelegramContact(applicant.applicantId, '+998901234567', { senderUserId: 1001, contactUserId: 1001, forwarded: true }, 'forwarded', NOW)).reason, 'identity_unverified');
    assert.equal((await f.store.attachTelegramContact(applicant.applicantId, 'invalid', { senderUserId: 1001, contactUserId: 1001, forwarded: false }, 'invalid', NOW)).reason, 'identity_unverified');
    const matched = await verifyContact(f.store, applicant.applicantId);
    assert.equal(matched.ok && matched.applicant.verificationStatus, 'CONTACT_VERIFIED');
  } finally { await f.cleanup(); }
});

test('same Telegram identity is idempotent, username is metadata, and spoofed payload actors are ignored', async () => {
  const f = await fixture();
  try {
    const first = await identify(f.store, 1001, 'student_one');
    const second = await identify(f.store, 1001, 'student_two');
    assert.equal(second.applicantId, first.applicantId);
    assert.equal(second.username, 'student_two');
    assert.equal((await f.store.all()).length, 1);
    const derived = deriveAuthoritativeTelegramIdentity({ from: { id: 1001, username: 'student_two' }, chat: { id: 1001, type: 'private' }, message: { actor_id: 9999, user_id: 9999 } });
    assert.equal(derived?.telegramUserId, 1001);
    assert.equal(deriveAuthoritativeTelegramIdentity({ from: { id: 1001 }, chat: { id: 9999, type: 'private' }, message: { user_id: 1001 } })?.telegramChatId, 9999);
    assert.equal((await f.store.identify({ telegramUserId: 1001, telegramChatId: 9999, chatType: 'private' }, 'chat-change', NOW)).reason, 'invalid_actor');
  } finally { await f.cleanup(); }
});

test('duplicate phone creates MERGE_REVIEW and never automatically merges applicants', async () => {
  const f = await fixture();
  try {
    const left = await identify(f.store, 1001, 'left_user');
    const right = await identify(f.store, 2002, 'right_user');
    await consent(f.store, left.applicantId);
    await consent(f.store, right.applicantId);
    assert.equal((await verifyContact(f.store, left.applicantId, 1001)).ok, true);
    const conflict = await verifyContact(f.store, right.applicantId, 2002);
    assert.equal(conflict.reason, 'conflict');
    assert.equal((await f.store.get(left.applicantId))?.lifecycleState, 'MERGE_REVIEW');
    assert.equal((await f.store.get(right.applicantId))?.lifecycleState, 'MERGE_REVIEW');
    assert.equal((await f.store.all()).length, 2);
  } finally { await f.cleanup(); }
});

test('duplicate submission is idempotent only for the same semantic key', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    await consent(f.store, applicant.applicantId);
    await verifyContact(f.store, applicant.applicantId);
    await f.store.beginApplication(applicant.applicantId, 'draft', NOW);
    assert.equal((await f.store.submitApplication(applicant.applicantId, 'same-key', 'submit', NOW)).ok, true);
    const replay = await f.store.submitApplication(applicant.applicantId, 'same-key', 'submit-replay', NOW);
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal((await f.store.submitApplication(applicant.applicantId, 'different-key', 'duplicate', NOW)).reason, 'duplicate_submission');
  } finally { await f.cleanup(); }
});

test('blocked retry and merge review require audited human control', async () => {
  const f = await fixture();
  try {
    const left = await identify(f.store, 1001, 'left_user');
    const right = await identify(f.store, 2002, 'right_user');
    assert.equal((await f.store.requestMergeReview(left.applicantId, right.applicantId, 0, 'invalid actor', 'merge', NOW)).ok, false);
    assert.equal((await f.store.requestMergeReview(left.applicantId, right.applicantId, 99, 'Reviewed identity conflict evidence.', 'merge', NOW)).ok, true);
    assert.equal((await f.store.blockApplicant(left.applicantId, 99, 'Confirmed abusive retry.', 'block', NOW)).ok, true);
    assert.equal((await f.store.identify({ telegramUserId: 1001, telegramChatId: 1001, chatType: 'private' }, 'blocked-retry', NOW)).reason, 'blocked');
  } finally { await f.cleanup(); }
});

test('audit records are redacted and masked display never exposes full identities', async () => {
  const f = await fixture();
  try {
    const applicant = await identify(f.store);
    await consent(f.store, applicant.applicantId);
    await verifyContact(f.store, applicant.applicantId);
    const audit = await f.store.audit();
    assert.ok(audit.length >= 3);
    assert.ok(audit.every(isSafeApplicantAuditEvent));
    const serialized = JSON.stringify(audit);
    assert.equal(serialized.includes('+998901234567'), false);
    assert.equal(serialized.includes('student_one'), false);
    const masked = maskedApplicantIdentity((await f.store.get(applicant.applicantId))!);
    assert.equal(masked.phone, '+998 ** *** ** 67');
    assert.equal(JSON.stringify(masked).includes('+998901234567'), false);
  } finally { await f.cleanup(); }
});

test('restart persistence and concurrent identity creation preserve one applicant', async () => {
  const f = await fixture();
  try {
    const [left, right] = await Promise.all([
      f.store.identify({ telegramUserId: 1001, telegramChatId: 1001, username: 'student_one', chatType: 'private' }, 'concurrent-a', NOW),
      new JsonApplicantIdentityStore(f.file).identify({ telegramUserId: 1001, telegramChatId: 1001, username: 'student_one', chatType: 'private' }, 'concurrent-b', NOW),
    ]);
    assert.equal(left.ok && right.ok, true);
    assert.equal((await new JsonApplicantIdentityStore(f.file).all()).length, 1);
    assert.equal((await new JsonApplicantIdentityStore(f.file).getByTelegramUserId(1001))?.applicantId, left.ok ? left.applicant.applicantId : undefined);
  } finally { await f.cleanup(); }
});

test('legacy loading migrates in memory and rollback snapshot remains readable', async () => {
  const f = await fixture();
  try {
    const at = NOW.toISOString();
    const legacy = { applicants: [{ applicantId: 'legacy-1', telegramUserId: 1001, telegramChatId: 1001, identityStatus: 'ACTIVE', verificationStatus: 'TELEGRAM_VERIFIED', lifecycleState: 'CONSENT_REQUIRED', consents: {}, createdAt: at, updatedAt: at, auditReferences: [] }], audit: [], effectKeys: [] };
    await writeFile(f.file, JSON.stringify(legacy), 'utf8');
    await f.store.migrateStore(false);
    assert.equal((await f.store.all())[0].applicantId, 'legacy-1');
    await f.store.identify({ telegramUserId: 1001, telegramChatId: 1001, username: 'legacy_user', chatType: 'private' }, 'migrate-write', NOW);
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    const migrated = migrateApplicantIdentityDatabase(saved);
    const rollback = rollbackApplicantIdentityDatabase(migrated);
    assert.equal(migrateApplicantIdentityDatabase(rollback).applicants[0].applicantId, 'legacy-1');
    assert.equal((await readFile(`${f.file}.bak`, 'utf8')).includes('legacy-1'), true);
    assert.throws(() => migrateApplicantIdentityDatabase({ schemaVersion: 2 } as never), /Unsupported/);
    const duplicated = migrateApplicantIdentityDatabase({ applicants: [legacy.applicants[0] as never, { ...legacy.applicants[0], applicantId: 'legacy-2' } as never] });
    assert.ok(duplicated.applicants.every((item) => item.lifecycleState === 'MERGE_REVIEW'));
    const duplicateInternalId = migrateApplicantIdentityDatabase({ applicants: [legacy.applicants[0] as never, { ...legacy.applicants[0], telegramUserId: 2002, telegramChatId: 2002 } as never] });
    assert.ok(duplicateInternalId.applicants.every((item) => item.lifecycleState === 'MERGE_REVIEW'));
  } finally { await f.cleanup(); }
});

test('follow-up sender is never called without both outbound and follow-up consent', async () => {
  const f = await fixture();
  const followups = new JsonFollowUpStore(path.join(f.directory, 'followups.json'));
  const leads = new JsonLeadStore(path.join(f.directory, 'leads.json'));
  try {
    await identify(f.store);
    await followups.upsert({ telegramId: 1001, startedAt: new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(), count: 0 });
    let sends = 0;
    const bot = { telegram: { async sendMessage() { sends += 1; return { message_id: 1 }; } } } as unknown as Telegraf<BotContext>;
    await processFollowUps(bot, leads, followups, { now: NOW, canSendNonEssential: (id) => f.store.maySendFollowUp(id) });
    assert.equal(sends, 0);
    assert.equal((await followups.all())[0].deliveryState, 'Cancelled');
  } finally { await f.cleanup(); }
});
