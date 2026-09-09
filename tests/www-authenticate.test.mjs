import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeWWWAuthenticateValue } from '../dist/www-authenticate.js';

test('WWW-Authenticate values escape double quotes', () => {
  assert.equal(escapeWWWAuthenticateValue('say "hi"'), 'say \\"hi\\"');
});

test('WWW-Authenticate values escape backslashes', () => {
  assert.equal(escapeWWWAuthenticateValue('c:\\tmp'), 'c:\\\\tmp');
});

test('WWW-Authenticate values preserve ordinary text', () => {
  assert.equal(
    escapeWWWAuthenticateValue('Invalid OAuth access token'),
    'Invalid OAuth access token'
  );
});
