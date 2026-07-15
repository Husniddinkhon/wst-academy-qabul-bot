import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonOperationalAlertStore } from '../src/operationalAlerts.js';
import { findLeadByReference, leadReference, processLeadSlaEscalations } from '../src/leadSla.js';
import type { Lead } from '../src/types.js';

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-one', createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z', telegramId: 123,
    fullName: 'Sensitive name', phone: '+998000000000', city: '', age: '', workStatus: '', experience: '', goal: '', paymentOption: '',
    status: 'New', source: 'organic', intent: '', lastMessage: 'sensitive content', messages: [], operatorNote: '', nextFollowUp: '', paymentStatus: '', preferredTime: '',
    ...overrides,
  };
}

test('lead SLA sends only the highest reached stage per recipient without PII', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lead-sla-'));
  try {
    const alertStore = new JsonOperationalAlertStore(path.join(dir, 'alerts.json'));
    const calls: Array<[number, string]> = [];
    const sendMessage = async (adminId: number, message: string) => { calls.push([adminId, message]); };
    const current = lead();
    const leadStore = { all: async () => [current] };
    const now = new Date('2026-07-16T09:00:00.000Z');
    const first = await processLeadSlaEscalations(leadStore, alertStore, { sendMessage }, [11, 22], now);
    const restartedStore = new JsonOperationalAlertStore(path.join(dir, 'alerts.json'));
    const second = await processLeadSlaEscalations(leadStore, restartedStore, { sendMessage }, [11, 22], now);

    assert.deepEqual(first, { waiting: 1, due: 1, attempted: 2, sent: 2, failed: 0, suppressed: false });
    assert.deepEqual(second, { waiting: 1, due: 1, attempted: 0, sent: 0, failed: 0, suppressed: false });
    assert.equal(calls.length, 2);
    const message = calls[0]![1];
    assert.match(message, /24 soatdan oshdi/);
    assert.match(message, new RegExp(leadReference(current)));
    assert.doesNotMatch(message, new RegExp(current.fullName));
    assert.doesNotMatch(message, new RegExp(current.phone.replace('+', '\\+')));
    assert.doesNotMatch(message, new RegExp(current.lastMessage));
    const state = await readFile(path.join(dir, 'alerts.json'), 'utf8');
    assert.doesNotMatch(state, new RegExp(String(current.telegramId)));
    assert.doesNotMatch(state, new RegExp(current.phone.replace('+', '\\+')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lead SLA advances stages and never alerts terminal statuses', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lead-sla-'));
  try {
    const alertStore = new JsonOperationalAlertStore(path.join(dir, 'alerts.json'));
    const calls: string[] = [];
    const sendMessage = async (_adminId: number, message: string) => { calls.push(message); };
    const active = lead();
    const leadStore = { all: async () => [active] };
    await processLeadSlaEscalations(leadStore, alertStore, { sendMessage }, [11], new Date('2026-07-15T08:16:00.000Z'));
    await processLeadSlaEscalations(leadStore, alertStore, { sendMessage }, [11], new Date('2026-07-15T09:01:00.000Z'));
    active.status = 'OperatorContacted';
    const terminal = await processLeadSlaEscalations(leadStore, alertStore, { sendMessage }, [11], new Date('2026-07-16T09:00:00.000Z'));
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /15 daqiqadan oshdi/);
    assert.match(calls[1]!, /60 daqiqadan oshdi/);
    assert.deepEqual(terminal, { waiting: 0, due: 0, attempted: 0, sent: 0, failed: 0, suppressed: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lead SLA retries only failed recipients and resolves opaque references', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lead-sla-'));
  try {
    const alertStore = new JsonOperationalAlertStore(path.join(dir, 'alerts.json'));
    const calls: number[] = [];
    let fail = true;
    const sendMessage = async (adminId: number) => { calls.push(adminId); if (adminId === 22 && fail) throw new Error('network'); };
    const current = lead();
    const leadStore = { all: async () => [current] };
    const first = await processLeadSlaEscalations(leadStore, alertStore, { sendMessage }, [11, 22], new Date('2026-07-15T08:16:00.000Z'));
    fail = false;
    const retry = await processLeadSlaEscalations(leadStore, alertStore, { sendMessage }, [11, 22], new Date('2026-07-15T08:17:01.000Z'));
    assert.deepEqual(first, { waiting: 1, due: 1, attempted: 2, sent: 1, failed: 1, suppressed: false });
    assert.deepEqual(retry, { waiting: 1, due: 1, attempted: 1, sent: 1, failed: 0, suppressed: false });
    assert.deepEqual(calls, [11, 22, 22]);
    assert.equal(findLeadByReference([current], leadReference(current)), current);
    assert.equal(findLeadByReference([current], 'bad'), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
