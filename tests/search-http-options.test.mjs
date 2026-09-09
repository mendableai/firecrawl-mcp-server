import assert from 'node:assert/strict';
import test from 'node:test';

import { postSearch } from '../src/search-http-options.ts';

function recordingTransport() {
  const calls = [];
  return {
    calls,
    http: {
      async post(...args) {
        calls.push(args);
        return { data: { success: true } };
      },
    },
  };
}

test('search transport forwards the body and outlives the API timeout', async () => {
  const { calls, http } = recordingTransport();
  const body = { query: 'example domain', timeout: 300_000 };

  const response = await postSearch(http, body);

  assert.deepEqual(response, { data: { success: true } });
  assert.deepEqual(calls, [
    ['/v2/search', body, { timeoutMs: 305_000 }],
  ]);
});

test('search transport keeps the SDK default when no API timeout is requested', async () => {
  const { calls, http } = recordingTransport();
  const body = { query: 'example domain' };

  await postSearch(http, body);

  assert.deepEqual(calls, [['/v2/search', body, {}]]);
});
