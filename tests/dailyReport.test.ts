import assert from 'node:assert/strict';
import test from 'node:test';
import { getTashkentDateKey, getTashkentDayLeads, getTashkentHour, REPORT_TIME_ZONE } from '../src/dailyReport.js';
import type { Lead } from '../src/types.js';
import type { JsonLeadStore } from '../src/storage.js';

function lead(telegramId: number, createdAt: string): Lead {
  return {
    id: String(telegramId), createdAt, updatedAt: createdAt, telegramId, fullName: 'Test', phone: '', city: '', age: '', workStatus: '', experience: '', goal: '', paymentOption: '', status: 'New', source: 'unknown', intent: '', lastMessage: '', messages: [], operatorNote: '', nextFollowUp: '', paymentStatus: '', preferredTime: '',
  };
}

test('Tashkent schedule crosses the UTC day boundary explicitly', () => {
  assert.equal(REPORT_TIME_ZONE, 'Asia/Tashkent');
  assert.equal(getTashkentDateKey(new Date('2026-07-14T18:59:59.999Z')), '2026-07-14');
  assert.equal(getTashkentHour(new Date('2026-07-14T18:59:59.999Z')), 23);
  assert.equal(getTashkentDateKey(new Date('2026-07-14T19:00:00.000Z')), '2026-07-15');
  assert.equal(getTashkentHour(new Date('2026-07-14T19:00:00.000Z')), 0);
  assert.equal(getTashkentHour(new Date('2026-07-15T16:00:00.000Z')), 21);
});

test('daily report includes only leads from the current Tashkent calendar day', async () => {
  const leads = [
    lead(1, '2026-07-14T18:59:59.999Z'),
    lead(2, '2026-07-14T19:00:00.000Z'),
    lead(3, '2026-07-15T18:59:59.999Z'),
    lead(4, '2026-07-15T19:00:00.000Z'),
    lead(5, 'invalid-date'),
  ];
  const store = { async all() { return leads; } } as JsonLeadStore;

  const result = await getTashkentDayLeads(store, new Date('2026-07-15T10:00:00.000Z'));

  assert.deepEqual(result.map((item) => item.telegramId), [2, 3]);
});
