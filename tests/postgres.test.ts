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
  await pg.close();
});
