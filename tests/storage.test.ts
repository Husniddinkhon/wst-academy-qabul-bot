import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonLeadStore, mergeLeadRecords } from '../src/storage.js';
import type { Lead } from '../src/types.js';

const existing: Lead = {
  id: 'lead-1', createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z',
  telegramId: 123, fullName: 'Student', phone: '+998901234567', city: '', age: '', workStatus: '', experience: '',
  goal: 'CCTV course', paymentOption: '', status: 'Hot', source: 'telegram_ads', campaignId: 'ads_july',
  intent: 'price', lastMessage: 'Narxi qancha?', messages: [], operatorNote: '', nextFollowUp: '', paymentStatus: '', preferredTime: '',
};

test('unknown or empty follow-up data cannot erase paid attribution and contact fields', () => {
  const merged = mergeLeadRecords(existing, {
    ...existing,
    id: 'replacement',
    updatedAt: '2026-07-02T10:00:00.000Z',
    phone: '',
    goal: '',
    source: 'unknown',
    campaignId: '',
    status: 'Warm',
    lastMessage: 'Yana savolim bor',
  });

  assert.equal(merged.id, existing.id);
  assert.equal(merged.phone, existing.phone);
  assert.equal(merged.goal, existing.goal);
  assert.equal(merged.source, existing.source);
  assert.equal(merged.campaignId, existing.campaignId);
  assert.equal(merged.status, 'Hot');
  assert.equal(merged.messages.at(-1)?.text, 'Yana savolim bor');

  const blankSource = mergeLeadRecords(existing, { ...existing, source: '' as Lead['source'] });
  assert.equal(blankSource.source, existing.source);
});

test('specific new attribution replaces an older attribution', () => {
  const merged = mergeLeadRecords(existing, {
    ...existing,
    updatedAt: '2026-07-03T10:00:00.000Z',
    source: 'channel',
    campaignId: 'unv-uho-p1',
    goal: 'UNV camera',
    phone: '+998971112233',
  });
  assert.equal(merged.source, 'channel');
  assert.equal(merged.campaignId, 'unv-uho-p1');
  assert.equal(merged.goal, 'UNV camera');
  assert.equal(merged.phone, '+998971112233');
});

test('approved applicant export omits Telegram identity and private free-text fields', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'approved-export-'));
  try {
    const store = new JsonLeadStore(path.join(directory, 'leads.json'));
    await store.add({ ...existing, applicantId: 'applicant-1', username: 'private_user', telegramId: 991234567, lastMessage: 'private applicant answer', operatorNote: 'private operator note', notes: 'private registration note' });
    const csv = await store.toApprovedApplicantCsv();
    assert.match(csv, /^applicantId,id,createdAt,/);
    assert.doesNotMatch(csv, /telegramId|username|lastMessage|operatorNote|notes|private_user|private applicant answer|private operator note|private registration note|991234567/);
    assert.match(csv, /applicant-1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
