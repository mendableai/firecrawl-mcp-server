import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('README documents hosted API-key setup without putting credentials in the URL', () => {
  assert.doesNotMatch(
    readme,
    /https:\/\/mcp\.firecrawl\.dev\/\{FIRECRAWL_API_KEY\}\/v2\/mcp/i
  );
  assert.match(readme, /Authorization: Bearer <FIRECRAWL_API_KEY>/);
  assert.match(readme, /Never put an API key in the server URL\./);
});
