import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdmin } from '../src/admin.js';
import type { BotContext } from '../src/types.js';

function context(id?: number): BotContext {
  return { from: id ? { id } : undefined } as BotContext;
}

test('channel administration authorizes configured admins only', () => {
  assert.equal(isAdmin(context(1001), [1001, 1002]), true);
  assert.equal(isAdmin(context(9999), [1001, 1002]), false);
  assert.equal(isAdmin(context(), [1001, 1002]), false);
  assert.equal(isAdmin(context(1001), []), false);
});
