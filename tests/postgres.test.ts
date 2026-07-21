import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostgresFollowUpStore, PostgresLeadStore, PostgresStorage } from '../src/postgres.js';
import type { Lead } from '../src/types.js';

const url = process.env.TEST_DATABASE_URL;
test('migration is idempotent and concurrent updates preserve events', { skip: !url }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wst-pg-'));
  const now = new Date().toISOString();
  const lead: Lead = { id:'seed',createdAt:now,updatedAt:now,telegramId:990001,fullName:'Test',phone:'',city:'',age:'',workStatus:'',experience:'',goal:'',paymentOption:'',status:'Warm',source:'unknown',intent:'test',lastMessage:'seed',messages:[],operatorNote:'',nextFollowUp:'',paymentStatus:'',preferredTime:'' };
  const leads=path.join(dir,'leads.json'), followups=path.join(dir,'followups.json');
  await writeFile(leads,JSON.stringify({leads:[lead]})); await writeFile(followups,JSON.stringify({followups:[{telegramId:990001,startedAt:now,count:0}]}));
  const pg=new PostgresStorage(url!); await pg.migrate(leads,followups);
  await pg.pool.query('TRUNCATE conversation_events,followups,leads RESTART IDENTITY');
  await pg.migrate(leads,followups); await pg.migrate(leads,followups);
  assert.equal((await pg.pool.query('select count(*)::int n from leads')).rows[0].n,1);
  const store=new PostgresLeadStore(pg);
  await Promise.all(Array.from({length:8},(_,i)=>store.upsert({...lead,updatedAt:new Date(Date.now()+i+1).toISOString(),lastMessage:`m${i}`})));
  assert.equal((await store.getByTelegramId(990001))?.messages.length,8);
  assert.equal((await pg.pool.query("select count(*)::int n from conversation_events where event_type='lead_updated'")).rows[0].n,8);
  const fs=new PostgresFollowUpStore(pg); await Promise.all(Array.from({length:8},()=>fs.ensure({telegramId:990001,startedAt:now,count:0})));
  assert.equal((await fs.all()).filter(x=>x.telegramId===990001).length,1);

  const applicant = { ...lead, id: 'idempotent-applicant', telegramId: 990002, lastMessage: 'first submission' };
  const applicantKey = 'telegram-update:500:applicant:registration-complete';
  const [created, replayed] = await Promise.all([
    store.upsert(applicant, applicantKey),
    new PostgresLeadStore(pg).upsert({ ...applicant, id: 'duplicate', lastMessage: 'duplicate submission' }, applicantKey),
  ]);
  assert.deepEqual(replayed, created);
  assert.equal(created.created, true);
  assert.equal((await pg.pool.query('select count(*)::int n from leads where telegram_id=$1', [990002])).rows[0].n, 1);

  const concurrentNewBase = { ...lead, telegramId: 990003, aiLeadScore: 'HOT' as const, aiLeadReason: 'test', status: 'Hot' as const };
  const [firstNew, secondNew] = await Promise.all([
    store.upsert({ ...concurrentNewBase, id: 'new-a', lastMessage: 'new-a', messages: [{ text: 'new-a', createdAt: now }] }, 'telegram-update:503:applicant:new-a'),
    new PostgresLeadStore(pg).upsert({ ...concurrentNewBase, id: 'new-b', lastMessage: 'new-b', messages: [{ text: 'new-b', createdAt: now }] }, 'telegram-update:504:applicant:new-b'),
  ]);
  assert.equal([firstNew, secondNew].filter(result => result.created).length, 1);
  assert.equal([firstNew, secondNew].filter(result => result.hotEscalated).length, 1);
  assert.equal((await store.getByTelegramId(990003))?.messages.length, 2);

  const adminKey = 'telegram-update:501:admin:set-status';
  const firstAdminResult = await store.updateByTelegramId(990002, { status: 'OperatorContacted' }, adminKey);
  const duplicateAdminResult = await new PostgresLeadStore(pg).updateByTelegramId(990002, { status: 'Rejected', operatorNote: 'must not apply' }, adminKey);
  assert.deepEqual(duplicateAdminResult, firstAdminResult);
  assert.equal((await store.getByTelegramId(990002))?.status, 'OperatorContacted');
  assert.equal((await store.getByTelegramId(990002))?.operatorNote, '');

  const followupKey = 'telegram-update:502:followup:registration-start';
  await fs.upsert({ telegramId: 990002, startedAt: now, count: 1 }, followupKey);
  await new PostgresFollowUpStore(pg).upsert({ telegramId: 990002, startedAt: new Date(Date.now() + 1_000).toISOString(), count: 99 }, followupKey);
  assert.equal((await fs.all()).find(x => x.telegramId === 990002)?.count, 1);

  await Promise.all([
    fs.ensure({ telegramId: 990004, startedAt: now, count: 0 }, 'telegram-update:505:followup:first'),
    new PostgresFollowUpStore(pg).ensure({ telegramId: 990004, startedAt: new Date(Date.now() + 2_000).toISOString(), count: 99 }, 'telegram-update:506:followup:second'),
  ]);
  assert.equal((await fs.all()).filter(x => x.telegramId === 990004).length, 1);
  assert.equal((await pg.pool.query("select count(*)::int n from conversation_events where telegram_id=$1 and event_type='telegram_followup_claim'", [990004])).rows[0].n, 2);

  await fs.upsert({ telegramId: 990005, startedAt: now, count: 0 });
  const deliveryRequest = { telegramId: 990005, followUpId: 'followup:990005:1:registration_incomplete', task: 'registration_incomplete' as const, dueAt: new Date(Date.now() - 1_000).toISOString(), timeZone: 'Asia/Tashkent' as const };
  const [claimA, claimB] = await Promise.all([
    fs.claimDelivery(deliveryRequest, { workerId: 'pg-worker-a', leaseMs: 60_000, maxAttempts: 3 }),
    new PostgresFollowUpStore(pg).claimDelivery(deliveryRequest, { workerId: 'pg-worker-b', leaseMs: 60_000, maxAttempts: 3 }),
  ]);
  assert.equal([claimA, claimB].filter(result => result.ok).length, 1);
  const owner = claimA.ok ? claimA : claimB.ok ? claimB : undefined;
  assert.ok(owner?.ok);
  if (owner?.ok) {
    assert.ok(await fs.markDeliverySending(owner.claim));
    assert.ok(await fs.finishDelivery(owner.claim, { sent: true }));
  }
  assert.equal((await fs.all()).find(item => item.telegramId === 990005)?.count, 1);

  const crashAt = new Date('2026-07-21T10:00:00.000Z');
  await fs.upsert({ telegramId: 990006, startedAt: crashAt.toISOString(), count: 0 });
  const crashed = await fs.claimDelivery({ telegramId: 990006, followUpId: 'followup:990006:1:registration_incomplete', task: 'registration_incomplete', dueAt: crashAt.toISOString(), timeZone: 'Asia/Tashkent' }, { workerId: 'pg-crashed', leaseMs: 1_000, maxAttempts: 3, now: crashAt });
  assert.equal(crashed.ok, true);
  if (crashed.ok) await fs.markDeliverySending(crashed.claim, crashAt);
  const recovered = await fs.recoverExpiredDeliveryClaims(new Date(crashAt.getTime() + 1_001));
  assert.equal(recovered.find(item => item.telegramId === 990006)?.deliveryState, 'Uncertain');
  await pg.close();
});
