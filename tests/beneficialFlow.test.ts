import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { CALCULATOR_BUTTON, LESSONS, LESSON_BUTTON, QUIZ, QUIZ_BUTTON, storageTerabytes, validateCalculatorValue } from '../src/learning.js';
import { explicitLeadSource, parseStartAttribution, resetSessionForStart } from '../src/startFlow.js';
import { getTruthfulFallbackAnswer } from '../src/aiAgent.js';
import { mainMenu, markRegistrationFollowUpOptIn, startInlineMenu } from '../src/registration.js';
import type { BotSession } from '../src/types.js';
import type { JsonFollowUpStore } from '../src/storage.js';
import type { JsonApplicantIdentityStore } from '../src/applicantIdentity.js';

test('ad start attribution contains no PII and does not create storage side effects', () => {
  const attribution = parseStartAttribution('/start ads_campaign_a');
  assert.deepEqual(attribution, { source: 'telegram_ads', campaignId: 'ads_campaign_a' });
  assert.deepEqual(Object.keys(attribution).sort(), ['campaignId', 'source']);
});

test('bounded channel deep links preserve unique campaign attribution', () => {
  assert.deepEqual(parseStartAttribution('/start channel_academy_tech_20260716_ip_subnet'), {
    source: 'channel', campaignId: 'channel_academy_tech_20260716_ip_subnet',
  });
  assert.deepEqual(parseStartAttribution(`/start channel_${'x'.repeat(64)}`), { source: 'unknown' });
  assert.deepEqual(parseStartAttribution('/start channel_bad.payload'), { source: 'unknown' });
  assert.equal(explicitLeadSource('channel', 'call_request'), 'channel');
  assert.equal(explicitLeadSource('unknown', 'call_request'), 'call_request');
});

test('start reset escapes stale wizard and learning state', () => {
  const session = { leadDraft: { phone: 'secret' }, waitingForCallPhone: { message: 'call' }, lessonIndex: 2, quizIndex: 4, quizScore: 3, calculator: { step: 'days', cameras: 4, bitrate: 2 } } as BotSession;
  resetSessionForStart(session, { source: 'organic' });
  assert.equal(session.leadDraft, undefined);
  assert.equal(session.waitingForCallPhone, undefined);
  assert.equal(session.lessonIndex, undefined);
  assert.equal(session.quizIndex, undefined);
  assert.equal(session.calculator, undefined);
});

test('follow-up begins only after both outbound and follow-up consent', async () => {
  const calls: unknown[] = [];
  const store = { async upsert(value: unknown) { calls.push(value); } } as JsonFollowUpStore;
  const denied = { async maySendFollowUp() { return false; } } as JsonApplicantIdentityStore;
  assert.equal(await markRegistrationFollowUpOptIn(store, denied, 123, '2026-01-01T00:00:00.000Z'), false);
  const allowed = { async maySendFollowUp() { return true; } } as JsonApplicantIdentityStore;
  assert.equal(await markRegistrationFollowUpOptIn(store, allowed, 123, '2026-01-01T00:00:00.000Z'), true);
  assert.deepEqual(calls, [{ telegramId: 123, startedAt: '2026-01-01T00:00:00.000Z', count: 0 }]);
});

test('free menu and content are substantial and deterministic', () => {
  const serialized = JSON.stringify(mainMenu());
  for (const label of [LESSON_BUTTON, QUIZ_BUTTON, CALCULATOR_BUTTON]) assert.match(serialized, new RegExp(label));
  const inlineSerialized = JSON.stringify(startInlineMenu());
  for (const action of ['academy_lesson', 'academy_quiz', 'academy_calculator', 'academy_program', 'academy_price', 'academy_schedule', 'academy_register']) assert.match(inlineSerialized, new RegExp(action));
  assert.equal(LESSONS.length, 3);
  assert.equal(QUIZ.length, 5);
  assert.ok(LESSONS.every((lesson) => lesson.body.length > 100));
  assert.ok(QUIZ.every((question) => question.options.length === 3 && question.explanation.length > 20));
});

test('storage formula and bounds are correct', () => {
  assert.equal(storageTerabytes(1, 1, 1), 0.0108);
  assert.equal(storageTerabytes(4, 4, 30), 5.184);
  for (const [field, value] of [['cameras', 0], ['cameras', 129], ['bitrate', 0.1], ['bitrate', 33], ['days', 0], ['days', 366]] as const) assert.throws(() => validateCalculatorValue(field, value), RangeError);
});

test('offline fallback is truthful and makes no contact promise', () => {
  const latin = getTruthfulFallbackAnswer('savol');
  assert.match(latin, /AI javobi hozir mavjud emas/);
  assert.doesNotMatch(latin, /siz bilan bog‘lanadi|qabul qilindi/i);
});

test('public command wiring and ad start contain no automatic lead call', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const registration = await readFile(new URL('../src/registration.ts', import.meta.url), 'utf8');
  for (const command of ['help', 'lesson', 'quiz', 'calculator', 'cancel']) assert.match(source, new RegExp(`bot\\.command\\('${command}'`));
  for (const action of ['academy_lesson', 'academy_quiz', 'academy_calculator', 'academy_program', 'academy_price', 'academy_schedule', 'academy_register']) assert.match(source, new RegExp(`bot\\.action\\('${action}'`));
  assert.doesNotMatch(source, /saveTelegramAdsLead/);
  const startBlock = source.slice(source.indexOf('bot.start'), source.indexOf("bot.command('help'", source.indexOf('bot.start')));
  assert.doesNotMatch(startBlock, /store\.|followUpStore|notifyAdmins|deliverLeadWebhook/);
  assert.match(registration, /\^\\\/start/);
  assert.match(registration, /resetSessionForStart/);
});

test('operator button starts explicit phone consent flow', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const hearsStart = source.indexOf("bot.hears('Operator bilan bog‘lanish'");
  const hearsBlock = source.slice(hearsStart, source.indexOf('\n', hearsStart));
  assert.match(hearsBlock, /startCallRequestConsent/);
  assert.doesNotMatch(hearsBlock, /saveCallRequestLead/);
  const helperStart = source.indexOf('async function startCallRequestConsent');
  const helper = source.slice(helperStart, source.indexOf('async function saveCallRequestLead', helperStart));
  assert.match(helper, /waitingForCallPhone/);
  assert.match(helper, /CONSENT_NOTICES\.application/);
  assert.doesNotMatch(helper, /saveCallRequestLead/);
});
