import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonAuthorizationStore } from '../src/authorization.js';

test('channel publication authorization comes from durable RBAC, not a flat ID list', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wst-channel-rbac-'));
  const authorization = new JsonAuthorizationStore(path.join(directory, 'authorization.json'), 'test-callback-secret-32-characters-minimum');
  await authorization.bootstrapOwners([1001]);
  const owner = { telegramUserId: 1001, telegramChatId: 1001, chatType: 'private' };
  const stranger = { telegramUserId: 9999, telegramChatId: 9999, chatType: 'private' };

  assert.equal((await authorization.authorize(owner, 'publication.create', { kind: 'publication', channel: '-100-test' }, 'owner')).ok, true);
  assert.deepEqual(await authorization.authorize(stranger, 'publication.create', { kind: 'publication', channel: '-100-test' }, 'stranger'), { ok: false, reason: 'inactive' });
});
