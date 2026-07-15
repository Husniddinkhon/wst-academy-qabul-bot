import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLeadRecords } from '../src/storage.js';
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
