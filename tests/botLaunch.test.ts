import assert from 'node:assert/strict';
import test from 'node:test';

import { getBotLaunchOptions } from '../src/botLaunch.js';

test('production restarts preserve pending customer updates', () => {
  const production = getBotLaunchOptions({ isProduction: true });
  const development = getBotLaunchOptions({ isProduction: false });
  assert.deepEqual(production, { dropPendingUpdates: false });
  assert.deepEqual(development, { dropPendingUpdates: false });
  assert.equal(Object.prototype.hasOwnProperty.call({ isProduction: true }, 'dropPendingUpdates'), false);
});
