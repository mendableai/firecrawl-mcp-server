import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertAgentMetadataPolicy } from '../scripts/agent-metadata-policy.mjs';

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(port, child) {
  const url = `http://127.0.0.1:${port}/health`;
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error('server did not become healthy');
}


function parseSseJson(body) {
  const dataLine = body
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '));
  assert.ok(dataLine, `Missing SSE data line in body: ${body}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

function assertServerGeneratedRequestId(payload, untrustedValues = []) {
  assert.match(
    payload.request_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  for (const value of untrustedValues) {
    assert.notEqual(payload.request_id, value);
  }
  return payload.request_id;
}

const KEYLESS_ACCOUNT_FIX =
  'Fix: Create an API key at https://www.firecrawl.dev/app/api-keys, then:\n- Set the header: Authorization: Bearer YOUR_API_KEY on https://mcp.firecrawl.dev/v2/mcp\nThen start a new session.';
const KEYLESS_QUOTA_MESSAGE = `You've hit Firecrawl's free MCP rate limit. To continue using without limits, create a Firecrawl API key.\n\n${KEYLESS_ACCOUNT_FIX}`;
const KEYLESS_TOOL_MESSAGE = `This tool needs a Firecrawl account.\n\n${KEYLESS_ACCOUNT_FIX}`;
const KEYLESS_ACCESS_MESSAGE = `Anonymous keyless access is unavailable for this request.\n\n${KEYLESS_ACCOUNT_FIX}`;
const INVALID_API_KEY_MESSAGE =
  'The Firecrawl API key is invalid or revoked.\nFix: Replace the key on the existing Firecrawl MCP server, then start a new session. Get an API key at https://www.firecrawl.dev/app/api-keys';
const INVALID_OAUTH_MESSAGE =
  'This Firecrawl account connection is no longer valid.\nFix: Reconnect the existing Firecrawl server in the client, or set that existing server URL to https://mcp.firecrawl.dev/v2/mcp-oauth, then start a new session.';

const CREDENTIAL_VALIDATION_MESSAGE =
  'Firecrawl credential validation is temporarily unavailable';
const CREDENTIAL_VALIDATION_LOG_PREFIX = '[MCP_CREDENTIAL_VALIDATION] ';
const ACCOUNT_RESOURCE = 'https://mcp.firecrawl.dev/v2/mcp-oauth';

async function assertCredentialValidationUnavailable(response, label) {
  assert.equal(response.status, 503, label);
  // A challenge here would send a still-valid session into reauthorization.
  assert.equal(response.headers.has('www-authenticate'), false, label);
  assert.equal(response.headers.get('retry-after'), '5', label);
  const body = await response.text();
  assert.equal(body, CREDENTIAL_VALIDATION_MESSAGE, label);
  // OAuth error codes belong on 400 and 401 responses; clients read them as an
  // authentication verdict, which this is not.
  assert.doesNotMatch(body, /temporarily_unavailable/, label);
}

async function waitForCredentialValidationLog(readStderr) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const line = readStderr()
      .split('\n')
      .find((entry) => entry.startsWith(CREDENTIAL_VALIDATION_LOG_PREFIX));
    if (line) {
      return JSON.parse(line.slice(CREDENTIAL_VALIDATION_LOG_PREFIX.length));
    }
    await delay(25);
  }
  return undefined;
}

function assertKeylessAccountRecovery(
  result,
  { code, message, retryAfterSeconds, untrustedRequestIds = [] }
) {
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, message);
  assert.equal(result.content[0].text, result.structuredContent.message);
  assert.equal(result.structuredContent.code, code);
  assert.equal(result.structuredContent.auth_mode, 'keyless');
  assert.equal(result.structuredContent.message, message);
  assert.equal(
    result.structuredContent.docs_url,
    'https://docs.firecrawl.dev/mcp-server'
  );
  assert.equal(result.structuredContent.available_tools, undefined);
  assert.equal(result.structuredContent.next_actions, undefined);
  assert.doesNotMatch(result.content[0].text, /ask the human/i);
  assert.doesNotMatch(result.content[0].text, /never ask/i);
  assert.doesNotMatch(result.content[0].text, /outside this chat/i);
  assert.doesNotMatch(result.content[0].text, /must complete the connection/i);
  assert.doesNotMatch(result.content[0].text, /try again in about/);
  assert.doesNotMatch(result.content[0].text, /remain available/);
  assert.doesNotMatch(result.content[0].text, /continue with those/);
  assert.doesNotMatch(result.content[0].text, /\bOAuth\b/i);
  assert.doesNotMatch(result.content[0].text, /mcp-oauth/i);
  assert.equal(result.structuredContent.retry_after_seconds, retryAfterSeconds);
  assertServerGeneratedRequestId(
    result.structuredContent,
    untrustedRequestIds
  );
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MCP_DELEGATED_CREDENTIAL_SECRET:
        'test-mcp-delegated-credential-secret-32',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2_000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

async function startFakeFirecrawlApi() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;

    const contentType = req.headers['content-type'] ?? '';
    const parsedBody = body
      ? contentType.includes('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(body))
        : JSON.parse(body)
      : undefined;
    requests.push({
      body: parsedBody,
      headers: req.headers,
      method: req.method,
      url: req.url,
    });

    if (req.method === 'POST' && req.url === '/api/oauth/introspect') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          active: true,
          api_key: 'fc-http-test',
          credential_purpose: 'general',
          scope: 'firecrawl:global',
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          creditsUsed: 1,
          data: {
            web: [
              {
                title: 'Example Domain',
                url: 'https://example.com/',
              },
            ],
          },
          id: '00000000-0000-4000-8000-000000000000',
          success: true,
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/monitor') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: { id: 'mon_001' },
          success: true,
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unhandled ${req.method} ${req.url}` }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');

  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// A fake API that can emulate both server-budgeted and legacy developer
// search responses.
async function startFakeDeveloperApi() {
  const requests = [];
  const passage = 'x'.repeat(5000);
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request before responding.
    }
    requests.push({
      headers: req.headers,
      method: req.method,
      url: req.url,
    });

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v2/search/developer') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...(url.searchParams.get('query') === 'legacy server'
            ? {}
            : { passage_budget_applied: 4096 }),
          results: [
            {
              id: 'doc:fixture',
              passages: [{ text: passage }],
              title: 'Developer fixture',
              url: 'https://example.com/developer',
            },
            {
              id: 'web:https://example.com/answer',
              passages: [
                { text: '' },
                { text: ' ' },
                { text: 'The answer.' },
                {},
              ],
              title: 'Developer answer',
              url: 'https://example.com/answer',
            },
            {
              id: 'web:https://example.com/base/child',
              passages: [{ text: 'The base answer.' }],
              title: 'Developer base answer',
              url: 'https://example.com/base',
            },
          ],
          success: true,
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unhandled ${req.method} ${req.url}` }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');

  return {
    passage,
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// A single fake origin that stands in for BOTH the Firecrawl OAuth issuer
// (token introspection + keyless eligibility) AND the Firecrawl API. Every
// request is recorded so tests can assert what the MCP server forwarded.
async function startFakeFirecrawlBackend(options = {}) {
  const {
    apiKeyFromIntrospection = 'fc-from-introspection',
    introspectionHandler,
    introspectionMetadata = {},
    keylessEligible = false,
    keylessEligibilityResponse,
    searchResponse,
  } = options;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;

    const contentType = req.headers['content-type'] ?? '';
    let parsedBody;
    if (raw && contentType.includes('application/json')) {
      parsedBody = JSON.parse(raw);
    } else if (raw && contentType.includes('application/x-www-form-urlencoded')) {
      parsedBody = Object.fromEntries(new URLSearchParams(raw));
    }
    requests.push({
      body: parsedBody,
      headers: req.headers,
      method: req.method,
      raw,
      url: req.url,
    });

    // OAuth token introspection (issuer origin).
    if (req.method === 'POST' && req.url === '/api/oauth/introspect') {
      const token = parsedBody?.token ?? '';
      const active = /^(?:fco_|fc-)/.test(token) && !token.includes('invalid');
      const custom = introspectionHandler?.(parsedBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          custom ?? (active
            ? {
                active: true,
                api_key: token.startsWith('fc-')
                  ? token
                  : apiKeyFromIntrospection,
                credential_purpose: 'general',
                scope: 'firecrawl:global',
                ...(token.startsWith('fco_')
                  ? { aud: 'https://mcp.firecrawl.dev/v2/mcp' }
                  : {}),
                ...introspectionMetadata,
              }
            : { active: false })
        )
      );
      return;
    }

    // Keyless free-tier eligibility (secret-gated, read-only).
    if (req.method === 'GET' && req.url === '/v2/keyless/eligibility') {
      const response = keylessEligibilityResponse ?? {
        status: 200,
        body: { eligible: keylessEligible },
      };
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
      return;
    }

    // Core is the authority on a forwarded API key, so a key the suite marks
    // invalid is rejected here rather than at introspection. Scoped to fc-
    // credentials: an fco_ token never reaches Core, and matching it here would
    // silently change unrelated tests.
    if (/Bearer fc-\S*invalid/.test(req.headers.authorization ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid token', success: false }));
      return;
    }
    if (/Bearer fc-forbidden/.test(req.headers.authorization ?? '')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden', success: false }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/search') {
      if (searchResponse) {
        res.writeHead(searchResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(searchResponse.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          creditsUsed: 1,
          data: { web: [{ title: 'Example Domain', url: 'https://example.com/' }] },
          id: '00000000-0000-4000-8000-000000000000',
          success: true,
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/parse/upload-url') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            expiresAt: '2030-01-01T00:00:00.000Z',
            headers: { 'x-upload-token': 'test-upload-token' },
            maxSizeBytes: 1024,
            method: 'PUT',
            uploadRef: 'test-upload-ref',
            uploadUrl: 'https://uploads.invalid/test-upload',
          },
          success: true,
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/parse') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: { markdown: '# Parsed fixture' },
          success: true,
        })
      );
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/v2/monitor')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unhandled ${req.method} ${req.url}` }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');

  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function httpToolCall(port, { endpoint = '/v2/mcp', id, headers, params }) {
  return fetch(`http://127.0.0.1:${port}${endpoint}`, {
    body: JSON.stringify({ id, jsonrpc: '2.0', method: 'tools/call', params }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });
}

test('HTTP cloud keyless transport preserves app challenge without advertising OAuth', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_API_URL: backend.url,
    OPENAI_APPS_CHALLENGE_TOKEN: 'challenge-123',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  const health = await waitForHealth(port, child);
  assert.equal(await health.text(), 'ok');

  const challenge = await fetch(
    `http://127.0.0.1:${port}/.well-known/openai-apps-challenge`
  );
  assert.equal(challenge.status, 200);
  assert.equal(await challenge.text(), 'challenge-123');

  const prm = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`
  );
  assert.equal(prm.status, 404);

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  assert.equal(unauthenticated.status, 200);
  const anonymousTools = parseSseJson(await unauthenticated.text()).result.tools;
  assert.deepEqual(
    anonymousTools.map((tool) => tool.name).sort(),
    ['firecrawl_parse', 'firecrawl_scrape', 'firecrawl_search']
  );
  const anonymousParse = anonymousTools.find(
    (tool) => tool.name === 'firecrawl_parse'
  );
  assert.ok(anonymousParse);
  assert.match(anonymousParse.description, /redactPII/i);
  assert.match(anonymousParse.description, /omit it for anonymous keyless/i);
  assert.doesNotMatch(anonymousParse.description, /"zeroDataRetention"\s*:\s*true/);
  const anonymousSearch = anonymousTools.find(
    (tool) => tool.name === 'firecrawl_search'
  );
  assert.ok(anonymousSearch);
  assert.match(
    anonymousSearch.description,
    /categories: \["developer"\].*data\.web.*category.*developer/is
  );
  assert.match(
    anonymousSearch.description,
    /categories: \["research"\].*research-affiliated websites.*`firecrawl_research_\*` tools are a separate surface.*PubMed, bioRxiv, medRxiv.*arXiv/is
  );
  assert.doesNotMatch(anonymousSearch.description, /data\.developer/i);

  const initialize = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({
      id: 2,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'firecrawl-http-smoke', version: '0.0.0' },
        protocolVersion: '2025-06-18',
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-api-key': 'fc-test',
    },
    method: 'POST',
  });
  assert.equal(initialize.status, 200);
  assert.match(initialize.headers.get('content-type') ?? '', /text\/event-stream/);
  const initializeMessage = parseSseJson(await initialize.text());
  assert.equal(initializeMessage.result.serverInfo.name, 'firecrawl-fastmcp');
  assert.match(
    initializeMessage.result.instructions,
    /An Authorization bearer API key can provide higher usage limits and expose additional tools/i
  );
  assert.doesNotMatch(initializeMessage.result.instructions, /\bOAuth\b/i);

  const toolsList = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-api-key': 'fc-test',
    },
    method: 'POST',
  });
  assert.equal(toolsList.status, 200);
  const toolsMessage = parseSseJson(await toolsList.text());
  const httpToolNames = toolsMessage.result.tools.map((tool) => tool.name);
  assert.ok(httpToolNames.includes('firecrawl_scrape'));
  assert.ok(httpToolNames.includes('firecrawl_search'));
  assert.ok(httpToolNames.includes('firecrawl_parse'));
  assert.equal(httpToolNames.includes('firecrawl_extract'), false);

  const deprecatedExtract = await httpToolCall(port, {
    id: 31,
    headers: { 'x-api-key': 'fc-test' },
    params: { arguments: {}, name: 'firecrawl_extract' },
  });
  assert.equal(deprecatedExtract.status, 200);
  const deprecatedExtractMessage = parseSseJson(await deprecatedExtract.text()).result;
  assert.equal(deprecatedExtractMessage.isError, true);
  assert.equal(deprecatedExtractMessage.structuredContent.code, 'DEPRECATED_TOOL');

  const searchTool = toolsMessage.result.tools.find(
    (tool) => tool.name === 'firecrawl_search'
  );
  assert.equal(searchTool.inputSchema.properties.highlights.type, 'boolean');
  assert.equal('default' in searchTool.inputSchema.properties.highlights, false);
  assert.equal(searchTool.inputSchema.properties.limit.type, 'integer');
  assert.equal(searchTool.inputSchema.properties.limit.minimum, 1);
  assert.equal(searchTool.inputSchema.properties.limit.maximum, 100);

  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'raw API keys must not be introspected during initialize, tools/list, or tools/call'
  );
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP cloud transport calls Firecrawl API with authenticated session', async (t) => {
  const fakeApi = await startFakeFirecrawlApi();
  t.after(() => fakeApi.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: fakeApi.url,
    FIRECRAWL_OAUTH_ISSUER: fakeApi.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  const toolCall = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({
      id: 4,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { highlights: false, limit: 1, query: 'example domain' },
        name: 'firecrawl_search',
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-api-key': 'fc-http-test',
    },
    method: 'POST',
  });
  assert.equal(toolCall.status, 200);

  const message = parseSseJson(await toolCall.text());
  const result = message.result;
  assert.notEqual(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), {
    creditsUsed: 1,
    data: {
      web: [
        {
          title: 'Example Domain',
          url: 'https://example.com/',
        },
      ],
    },
    id: '00000000-0000-4000-8000-000000000000',
    success: true,
  });

  const searchRequest = fakeApi.requests.find((request) => request.url === '/v2/search');
  assert.equal(searchRequest.method, 'POST');
  assert.equal(searchRequest.headers.authorization, 'Bearer fc-http-test');
  assert.deepEqual(searchRequest.body, {
    highlights: false,
    limit: 1,
    origin: 'mcp-fastmcp',
    query: 'example domain',
  });
  assert.equal(
    fakeApi.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'raw API keys must reach Core without introspection'
  );
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP cloud transport rejects invalid search limits before calling Firecrawl', async (t) => {
  const fakeApi = await startFakeFirecrawlApi();
  t.after(() => fakeApi.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: fakeApi.url,
    FIRECRAWL_OAUTH_ISSUER: fakeApi.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const searchRequestsBefore = fakeApi.requests.filter(
    (request) => request.url === '/v2/search'
  ).length;
  for (const [index, limit] of [0, 1.5, 101].entries()) {
    const response = await httpToolCall(port, {
      id: 400 + index,
      headers: { 'x-api-key': 'fc-test' },
      params: {
        arguments: { limit, query: 'invalid search limit' },
        name: 'firecrawl_search',
      },
    });
    assert.equal(response.status, 200);
    const message = parseSseJson(await response.text());
    assert.equal(
      Boolean(message.error) || message.result?.isError === true,
      true,
      JSON.stringify(message)
    );
  }
  const searchRequestsAfter = fakeApi.requests.filter(
    (request) => request.url === '/v2/search'
  ).length;
  assert.equal(searchRequestsAfter, searchRequestsBefore);
});

class StdioMcpClient {
  #buffer = '';
  #child;
  #id = 0;
  #pending = new Map();

  constructor(child) {
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.once('exit', (code, signal) => {
      const error = new Error(`MCP server exited: code=${code} signal=${signal}`);
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  request(method, params = {}) {
    const id = ++this.#id;
    this.#write({ id, jsonrpc: '2.0', method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10_000);
      this.#pending.set(id, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && this.#pending.has(message.id)) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

test('stdio transport initializes and lists Firecrawl tools', async (t) => {
  const child = spawnServer({
    FIRECRAWL_API_KEY: 'fc-test',
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  const init = await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-mcp-smoke', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  assert.equal(init.serverInfo.name, 'firecrawl-fastmcp');

  client.notify('notifications/initialized');
  const tools = await client.request('tools/list');
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('firecrawl_scrape'));
  assert.ok(toolNames.includes('firecrawl_search'));
  assert.ok(toolNames.includes('firecrawl_parse'));
  assert.equal(toolNames.includes('firecrawl_extract'), false);

  const deprecatedExtract = await client.request('tools/call', {
    // beforeValidate must intercept before the legacy required `urls` schema.
    arguments: {},
    name: 'firecrawl_extract',
  });
  assert.equal(deprecatedExtract.isError, true);
  assert.equal(deprecatedExtract.structuredContent.code, 'DEPRECATED_TOOL');
  assert.equal(
    deprecatedExtract.structuredContent.replacement.name,
    'firecrawl_scrape'
  );
  assert.deepEqual(
    deprecatedExtract.structuredContent.replacement.example_arguments.formats,
    ['json']
  );

  const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  assert.match(init.instructions, /firecrawl_scrape retrieves one supplied page/i);
  assert.match(
    init.instructions,
    /Authorization bearer API key.*including firecrawl_map for site URL discovery/is
  );
  assert.match(
    init.instructions,
    /Authorization bearer API key.*firecrawl_agent and firecrawl_agent_status for multi-source research that returns structured data when the URLs are not known/is
  );
  assert.match(
    byName.get('firecrawl_scrape').description,
    /request identifies a page and needs its content or defined fields/i
  );
  assert.match(
    byName.get('firecrawl_map').description,
    /returns matching URLs rather than page bodies/i
  );
  assert.match(
    byName.get('firecrawl_agent').description,
    /returns only a job ID, not the research result/i
  );
  assert.match(
    byName.get('firecrawl_agent_status').description,
    /processing.*non-terminal.*does not contain the final research result/is
  );
  assert.match(
    byName.get('firecrawl_search').description,
    /operators include.*related:host.*non-exhaustive/is
  );
  assert.match(
    byName.get('firecrawl_search').description,
    /each web result is a title, URL, and description, not the page.*scrapeOptions.*ignore `maxAge`.*firecrawl_scrape/is
  );
  assert.match(
    byName.get('firecrawl_search_feedback').description,
    /good.*valuable source.*partial.*missingContent.*bad.*missingContent.*query suggestion/is
  );
  assert.match(
    byName.get('firecrawl_search_feedback').description,
    /50.*valuableSources.*20.*missingContent.*feedback age window.*idempotent.*daily-cap/is
  );
  assert.match(
    byName.get('firecrawl_search_feedback').description,
    /eligible first feedback.*can refund 1 credit.*daily cap.*response reports whether a refund was applied/is
  );
  assert.doesNotMatch(
    byName.get('firecrawl_search_feedback').description,
    /costs?\s+2\s+credits?/i
  );
  // The paper index is ~90% biomedical. Naming that coverage is what keeps
  // agents from routing biomedical questions to the `research` website filter.
  assert.match(
    byName.get('firecrawl_research_search_papers').description,
    /indexed corpus.*biomedical.*PubMed.*bioRxiv.*medRxiv.*arXiv/is
  );
  // The two surfaces that both answer to "research" must stay distinguishable.
  // This has to live in the tool description, not a parameter `.describe()`:
  // no property description survives serialization into tools/list.
  assert.match(
    byName.get('firecrawl_search').description,
    /categories: \["research"\].*research-affiliated websites.*`firecrawl_research_\*` tools are a separate surface.*PubMed, bioRxiv, medRxiv.*arXiv/is
  );
  assert.match(
    byName.get('firecrawl_search').description,
    /categories: \["developer"\].*data\.web.*category.*developer/is
  );
  assert.doesNotMatch(
    byName.get('firecrawl_search').description,
    /data\.developer/i
  );
  assert.match(
    init.instructions,
    /firecrawl_search with categories: \["research"\] filters ordinary web results to research-affiliated websites/i
  );
  assert.match(
    init.instructions,
    /Authorization bearer API key.*firecrawl_research_\* for paper-index and repository research/is
  );
  assert.match(
    byName.get('firecrawl_research_related_papers').description,
    /seed_ids.*first ID.*primary seed.*later IDs.*anchors/is
  );
  assert.match(
    byName.get('firecrawl_research_related_papers').description,
    /mode.*defaults to.*similar.*citers.*references/is
  );
  assert.match(
    byName.get('firecrawl_monitor_create').description,
    /queries.*create the search target.*page targets are ignored/is
  );

  const renderedLanguage = [
    init.instructions,
    ...tools.tools.map((tool) => tool.description),
  ].join('\n');
  assertAgentMetadataPolicy(renderedLanguage, assert);
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('local keyless stdio keeps profile guidance keyless-scoped and omits feedback tools', async (t) => {
  const child = spawnServer({
    FIRECRAWL_API_KEY: '',
    FIRECRAWL_API_URL: '',
    FIRECRAWL_OAUTH_TOKEN: '',
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  const init = await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-local-keyless', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  const apiKeyBoundary = 'An Authorization bearer API key';
  const apiKeyBoundaryIndex = init.instructions.indexOf(apiKeyBoundary);
  assert.notEqual(apiKeyBoundaryIndex, -1);
  const keylessGuidance = init.instructions.slice(0, apiKeyBoundaryIndex);
  const apiKeyGuidance = init.instructions.slice(apiKeyBoundaryIndex);
  assert.match(
    keylessGuidance,
    /Hosted keyless sessions expose firecrawl_search, firecrawl_scrape, and firecrawl_parse with usage limits/i
  );
  assert.match(
    keylessGuidance,
    /firecrawl_search with categories: \["developer"\].*curated documentation sites/i
  );
  assert.match(
    keylessGuidance,
    /firecrawl_search with categories: \["research"\].*research-affiliated websites/i
  );
  assert.match(keylessGuidance, /firecrawl_scrape retrieves one supplied page/i);
  assert.match(keylessGuidance, /firecrawl_parse processes supported local files/i);
  assert.doesNotMatch(
    keylessGuidance,
    /firecrawl_(?:map|agent|agent_status|research_)/i
  );
  assert.doesNotMatch(init.instructions, /\bOAuth\b/i);
  assert.match(
    apiKeyGuidance,
    /higher usage limits.*additional tools.*subject to plan, deployment, and team policy/is
  );
  for (const name of [
    'firecrawl_map',
    'firecrawl_agent',
    'firecrawl_agent_status',
    'firecrawl_research_*',
  ]) {
    assert.ok(apiKeyGuidance.includes(name), `${name} must be API-key qualified`);
  }
  client.notify('notifications/initialized');
  const tools = await client.request('tools/list');
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes('firecrawl_search_feedback'), false);
  assert.equal(toolNames.includes('firecrawl_feedback'), false);
  const search = tools.tools.find((tool) => tool.name === 'firecrawl_search');
  assert.ok(search);
  assert.match(
    search.description,
    /authenticated responses can include an `id` for optional search feedback/i
  );
});

test('monitor create gives queries precedence over page targets', async (t) => {
  const fakeApi = await startFakeFirecrawlApi();
  t.after(() => fakeApi.close());

  const child = spawnServer({
    FIRECRAWL_API_KEY: 'fc-test',
    FIRECRAWL_API_URL: fakeApi.url,
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-monitor-precedence', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  client.notify('notifications/initialized');

  const result = await client.request('tools/call', {
    arguments: {
      goal: 'Track new pages about Firecrawl',
      page: 'https://example.com/ignored',
      pages: ['https://example.org/also-ignored'],
      queries: ['firecrawl release notes'],
    },
    name: 'firecrawl_monitor_create',
  });

  assert.notEqual(result.isError, true);
  const whitespaceQueryResult = await client.request('tools/call', {
    arguments: {
      goal: 'Track the supplied page',
      page: 'https://example.com/retained',
      queries: [' ', ''],
    },
    name: 'firecrawl_monitor_create',
  });
  assert.notEqual(whitespaceQueryResult.isError, true);

  const monitorRequests = fakeApi.requests.filter(
    (request) => request.method === 'POST' && request.url === '/v2/monitor'
  );
  assert.equal(monitorRequests.length, 2);
  assert.deepEqual(monitorRequests[0].body.targets, [
    { queries: ['firecrawl release notes'], type: 'search' },
  ]);
  assert.deepEqual(monitorRequests[1].body.targets, [
    { type: 'scrape', urls: ['https://example.com/retained'] },
  ]);
});

test('developer search serves server-shaped passages uncapped', async (t) => {
  const fakeApi = await startFakeDeveloperApi();
  t.after(() => fakeApi.close());

  const child = spawnServer({
    FIRECRAWL_API_KEY: 'fc-test',
    FIRECRAWL_API_URL: fakeApi.url,
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-developer-budget', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list');
  const developerTool = tools.tools.find(
    (tool) => tool.name === 'firecrawl_developer_search'
  );
  assert.ok(developerTool);
  assert.equal('passage_budget' in developerTool.inputSchema.properties, false);

  const serverBudgeted = await client.request('tools/call', {
    arguments: { query: 'server budget' },
    name: 'firecrawl_developer_search',
  });
  assert.notEqual(serverBudgeted.isError, true);
  assert.ok(serverBudgeted.content[0].text.includes(fakeApi.passage));
  assert.equal(
    serverBudgeted.content[0].text.match(/https:\/\/example\.com\/answer/g)
      ?.length,
    1
  );
  assert.ok(serverBudgeted.content[0].text.includes('\nThe answer.'));
  assert.equal(serverBudgeted.content[0].text.includes('\n---\n'), false);
  assert.ok(
    serverBudgeted.content[0].text.includes(
      '## [web:https://example.com/base/child] (web) Developer base answer\nhttps://example.com/base\n'
    )
  );

  // No client-side cap in any case: even a response without
  // passage_budget_applied (older server) serves the passage whole.
  const legacy = await client.request('tools/call', {
    arguments: { query: 'legacy server' },
    name: 'firecrawl_developer_search',
  });
  assert.notEqual(legacy.isError, true);
  assert.ok(legacy.content[0].text.includes(fakeApi.passage));

  assert.deepEqual(
    fakeApi.requests.map((request) => request.url),
    [
      '/v2/search/developer?query=server+budget',
      '/v2/search/developer?query=legacy+server',
    ]
  );
});

test('stdio transport calls Firecrawl API through a tool end to end', async (t) => {
  const fakeApi = await startFakeFirecrawlApi();
  t.after(() => fakeApi.close());

  const child = spawnServer({
    FIRECRAWL_API_KEY: 'fc-test',
    FIRECRAWL_API_URL: fakeApi.url,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-mcp-tool-e2e', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  client.notify('notifications/initialized');

  const result = await client.request('tools/call', {
    arguments: { limit: 1, query: 'example domain' },
    name: 'firecrawl_search',
  });

  assert.equal(fakeApi.requests.length, 1);
  assert.equal(fakeApi.requests[0].method, 'POST');
  assert.equal(fakeApi.requests[0].url, '/v2/search');
  assert.equal(fakeApi.requests[0].headers.authorization, 'Bearer fc-test');
  assert.deepEqual(fakeApi.requests[0].body, {
    limit: 1,
    origin: 'mcp-fastmcp',
    query: 'example domain',
  });

  assert.notEqual(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const toolPayload = JSON.parse(result.content[0].text);
  assert.deepEqual(toolPayload, {
    creditsUsed: 1,
    data: {
      web: [
        {
          title: 'Example Domain',
          url: 'https://example.com/',
        },
      ],
    },
    id: '00000000-0000-4000-8000-000000000000',
    success: true,
  });
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP cloud transport swaps an fco_ OAuth token for its introspected API key (once)', async (t) => {
  const backend = await startFakeFirecrawlBackend({
    apiKeyFromIntrospection: 'fc-introspected-key',
  });
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  const toolCall = await httpToolCall(port, {
    id: 10,
    headers: { authorization: 'Bearer fco_live_access_token' },
    params: { arguments: { limit: 1, query: 'example domain' }, name: 'firecrawl_search' },
  });
  assert.equal(toolCall.status, 200);
  const message = parseSseJson(await toolCall.text());
  assert.notEqual(message.result.isError, true);

  const introspectCalls = backend.requests.filter(
    (r) => r.url === '/api/oauth/introspect'
  );
  const searchCalls = backend.requests.filter((r) => r.url === '/v2/search');

  // The raw fco_ token must be introspected exactly once per request (the
  // per-request memoization must dedupe FastMCP's + mcp-proxy's auth calls),
  // authenticated with the configured introspection secret, and the downstream
  // Firecrawl API call must carry the *introspected* API key, never the raw token.
  assert.equal(introspectCalls.length, 1, 'introspection should be called exactly once');
  assert.equal(introspectCalls[0].headers.authorization, 'Bearer introspect-secret');
  assert.equal(introspectCalls[0].body.token, 'fco_live_access_token');
  assert.equal(introspectCalls[0].body.token_type_hint, 'access_token');

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].headers.authorization, 'Bearer fc-introspected-key');
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP cloud keyless transport rejects inactive OAuth without advertising login', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  const toolCall = await httpToolCall(port, {
    id: 11,
    headers: { authorization: 'Bearer fco_invalid_token' },
    params: { arguments: { limit: 1, query: 'example domain' }, name: 'firecrawl_search' },
  });

  assert.equal(toolCall.status, 401);
  const wwwAuthenticate = toolCall.headers.get('www-authenticate') ?? '';
  assert.match(wwwAuthenticate, /^Bearer /);
  assert.equal(wwwAuthenticate.includes('resource_metadata='), false);
  assert.match(wwwAuthenticate, /error="invalid_token"/);
  const body = await toolCall.json();
  assert.equal(body.error, 'invalid_token');
  assert.equal(body.code, 'OAUTH_CONNECTION_INVALID');
  assert.equal(body.auth_mode, 'oauth');
  assert.equal(
    body.error_description,
    INVALID_OAUTH_MESSAGE
  );
  assert.equal(body.next_actions, undefined);
  assert.doesNotMatch(body.error_description, /Authorization: Bearer/);
  // The failed introspection must NOT leak downstream as an API call.
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP transport returns invalid OAuth recovery without an OAuth challenge when OAuth is disabled', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'false',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    HOST: '127.0.0.1',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    id: 'invalid-oauth-without-challenge',
    headers: { authorization: 'Bearer fco_invalid_token' },
    params: {
      arguments: { limit: 1, query: 'example domain' },
      name: 'firecrawl_search',
    },
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), null);
  const body = await response.json();
  assert.equal(body.error, 'invalid_token');
  assert.equal(body.code, 'OAUTH_CONNECTION_INVALID');
  assert.equal(body.auth_mode, 'oauth');
  assert.equal(
    body.error_description,
    INVALID_OAUTH_MESSAGE
  );
  assert.equal(body.next_actions, undefined);
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), false);
});

test('local HTTP header API keys receive Core credential recovery', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'false',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_KEY: '',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_TOKEN: '',
    HOST: '127.0.0.1',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    headers: { 'x-firecrawl-api-key': 'fc-invalid' },
    id: 'local-http-invalid-header-key',
    params: {
      arguments: { limit: 1, query: 'example domain' },
      name: 'firecrawl_search',
    },
  });
  assert.equal(response.status, 200);
  const result = parseSseJson(await response.text()).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.equal(result.structuredContent.code, 'CREDENTIAL_INVALID');
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), true);
  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0
  );
});

test('local HTTP environment credentials keep self-hosted Core errors', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'false',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_KEY: 'fc-invalid',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_TOKEN: '',
    HOST: '127.0.0.1',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    id: 'local-http-invalid-env-key',
    params: {
      arguments: { limit: 1, query: 'example domain' },
      name: 'firecrawl_search',
    },
  });
  assert.equal(response.status, 200);
  const result = parseSseJson(await response.text()).result;
  assert.equal(result.isError, true);
  assert.notEqual(result.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.notEqual(result.structuredContent?.code, 'CREDENTIAL_INVALID');
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), true);
});

test('HTTP cloud transport accepts the x-firecrawl-api-key header', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  const toolCall = await httpToolCall(port, {
    id: 12,
    headers: { 'x-firecrawl-api-key': 'fc-header-key' },
    params: { arguments: { limit: 1, query: 'example domain' }, name: 'firecrawl_search' },
  });
  assert.equal(toolCall.status, 200);
  const message = parseSseJson(await toolCall.text());
  assert.notEqual(message.result.isError, true);

  const searchCalls = backend.requests.filter((r) => r.url === '/v2/search');
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].headers.authorization, 'Bearer fc-header-key');
  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'x-firecrawl-api-key must bypass introspection'
  );
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP cloud transport serves an eligible keyless client and forwards its IP', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-secret',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  const toolCall = await httpToolCall(port, {
    id: 13,
    headers: { 'x-forwarded-for': '8.8.8.7' },
    params: { arguments: { limit: 1, query: 'example domain' }, name: 'firecrawl_search' },
  });
  assert.equal(toolCall.status, 200);
  const message = parseSseJson(await toolCall.text());
  assert.notEqual(message.result.isError, true);
  const keylessSearchPayload = JSON.parse(message.result.content[0].text);
  assert.equal('id' in keylessSearchPayload, false);

  const eligibilityCalls = backend.requests.filter(
    (r) => r.url === '/v2/keyless/eligibility'
  );
  assert.equal(eligibilityCalls.length >= 1, true);
  // nginx preserves the single source IP sanitized by the trusted ingress.
  assert.equal(eligibilityCalls[0].headers['x-firecrawl-keyless-ip'], '8.8.8.7');
  assert.equal(
    eligibilityCalls[0].headers['x-firecrawl-keyless-secret'],
    'keyless-secret'
  );
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('HTTP cloud keyless returns retry recovery when eligibility is unavailable', async (t) => {
  const backend = await startFakeFirecrawlBackend({
    keylessEligibilityResponse: { status: 503, body: { error: 'unavailable' } },
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    id: 'keyless-eligibility-unavailable',
    headers: { 'x-forwarded-for': '8.8.8.7' },
    params: {
      arguments: { limit: 1, query: 'example domain' },
      name: 'firecrawl_search',
    },
  });
  const result = parseSseJson(await response.text()).result;
  assert.equal(result.isError, true);
  assert.equal(
    result.structuredContent.code,
    'KEYLESS_ELIGIBILITY_UNAVAILABLE'
  );
  assert.deepEqual(result.structuredContent.next_actions, [
    { kind: 'retry_later', after_seconds: 30 },
  ]);
  assert.equal(
    result.structuredContent.available_tools.includes('firecrawl_search'),
    true
  );
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
});

test('HTTP cloud keyless blocks account-only tools instead of continuing keyless', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    id: 'keyless-account-only-tool',
    headers: { 'x-forwarded-for': '8.8.8.7' },
    params: {
      arguments: { url: 'https://example.com/' },
      name: 'firecrawl_crawl',
    },
  });
  const result = parseSseJson(await response.text()).result;
  assertKeylessAccountRecovery(result, {
    code: 'KEYLESS_TOOL_NOT_AVAILABLE',
    message: KEYLESS_TOOL_MESSAGE,
  });
  assert.doesNotMatch(result.content[0].text, /remain available/);
  assert.doesNotMatch(result.content[0].text, /continue with those/);
  assert.equal(backend.requests.some((r) => r.url === '/v2/crawl'), false);
});

test('HTTP cloud keyless quota stays 200 isError without inlining retry_after_seconds', async (t) => {
  for (const [label, backendOptions, expectedCode, retryAfterSeconds] of [
    [
      'core-with-reason',
      {
        keylessEligible: true,
        searchResponse: {
          status: 429,
          body: { error: 'limit', reason: 'credits', retry_after_seconds: 42 },
        },
      },
      'KEYLESS_QUOTA_EXHAUSTED',
      42,
    ],
    [
      'core-without-reason',
      {
        keylessEligible: true,
        searchResponse: { status: 429, body: { error: 'limit' } },
      },
      'KEYLESS_LIMIT_REACHED',
      undefined,
    ],
    [
      'eligibility-exhausted',
      {
        keylessEligibilityResponse: {
          status: 200,
          body: { eligible: false, reason: 'credits', retryAfterSeconds: 42 },
        },
      },
      'KEYLESS_QUOTA_EXHAUSTED',
      42,
    ],
  ]) {
    const backend = await startFakeFirecrawlBackend(backendOptions);
    const port = await getFreePort();
    const child = spawnServer({
      CLOUD_SERVICE: 'true',
      FASTMCP_ENDPOINT: '/v2/mcp',
      FIRECRAWL_API_URL: backend.url,
      HTTP_STREAMABLE_SERVER: 'true',
      KEYLESS_PROXY_SECRET: 'keyless-secret',
      PORT: String(port),
    });
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await stopChild(child);
      await backend.close();
    };
    t.after(cleanup);
    await waitForHealth(port, child);
    const response = await httpToolCall(port, {
      id: `keyless-${label}`,
      headers: { 'x-forwarded-for': '8.8.8.7' },
      params: { arguments: { limit: 1, query: 'example domain' }, name: 'firecrawl_search' },
    });
    assert.equal(response.status, 200, label);
    const result = parseSseJson(await response.text()).result;
    assertKeylessAccountRecovery(result, {
      code: expectedCode,
      message: KEYLESS_QUOTA_MESSAGE,
      retryAfterSeconds,
    });
    assert.doesNotMatch(result.content[0].text, /about 42 seconds/, label);
    assert.doesNotMatch(result.content[0].text, /claude mcp add/, label);
    await cleanup();
  }
});

test('HTTP cloud keyless Parse completes both phases without credentials and forwards redactPII', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-parse-secret',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const phaseOne = await httpToolCall(port, {
    id: 'keyless-parse-phase-one',
    headers: { 'x-forwarded-for': '8.8.8.43' },
    params: {
      arguments: {
        contentType: 'application/pdf',
        filePath: '/not-read-by-hosted-mcp/document.pdf',
        formats: ['markdown'],
        parsers: ['pdf'],
      },
      name: 'firecrawl_parse',
    },
  });
  assert.equal(phaseOne.status, 200);
  const phaseOneResult = parseSseJson(await phaseOne.text()).result;
  assert.notEqual(phaseOneResult.isError, true);
  const phaseOnePayload = JSON.parse(phaseOneResult.content[0].text);
  assert.equal(phaseOnePayload.upload.uploadRef, 'test-upload-ref');
  assert.equal(phaseOnePayload.nextToolCall.arguments.uploadRef, 'test-upload-ref');

  const phaseTwo = await httpToolCall(port, {
    id: 'keyless-parse-phase-two',
    headers: { 'x-forwarded-for': '8.8.8.43' },
    params: {
      arguments: {
        formats: ['markdown'],
        redactPII: true,
        uploadRef: 'test-upload-ref',
      },
      name: 'firecrawl_parse',
    },
  });
  assert.equal(phaseTwo.status, 200);
  assert.notEqual(parseSseJson(await phaseTwo.text()).result.isError, true);

  const uploadCalls = backend.requests.filter((r) => r.url === '/v2/parse/upload-url');
  const parseCalls = backend.requests.filter((r) => r.url === '/v2/parse');
  assert.equal(uploadCalls.length, 1);
  assert.equal(parseCalls.length, 1);
  assert.equal(uploadCalls[0].headers.authorization, undefined);
  assert.equal(parseCalls[0].headers.authorization, undefined);
  assert.equal(parseCalls[0].body.uploadRef, 'test-upload-ref');
  assert.equal(parseCalls[0].body.redactPII, true);
  assert.equal(parseCalls[0].body.origin, 'mcp-fastmcp');
  assert.equal(stderr.includes('keyless-parse-secret'), false, stderr);
  assert.equal(stderr.includes('8.8.8.43'), false, stderr);
});

test('HTTP cloud keyless Parse rejects zeroDataRetention before any backend call', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-zdr-secret',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const requestIds = [];
  for (const arguments_ of [
    { filePath: '/not-read-by-hosted-mcp/zdr.pdf', zeroDataRetention: true },
    { uploadRef: 'test-upload-ref', zeroDataRetention: true },
  ]) {
    const clientRequestId = `client-${'filePath' in arguments_ ? 'phase-one' : 'phase-two'}`;
    const jsonRpcId = `keyless-zdr-${'filePath' in arguments_ ? 'phase-one' : 'phase-two'}`;
    const response = await httpToolCall(port, {
      id: jsonRpcId,
      headers: {
        'x-forwarded-for': '8.8.8.44',
        'x-request-id': clientRequestId,
      },
      params: { arguments: arguments_, name: 'firecrawl_parse' },
    });
    assert.equal(response.status, 200);
    const result = parseSseJson(await response.text()).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'KEYLESS_OPTION_NOT_AVAILABLE');
    assert.equal(result.structuredContent.option, 'zeroDataRetention');
    assert.match(result.structuredContent.message, /omit zeroDataRetention/i);
    assert.doesNotMatch(result.structuredContent.message, /connect an account/i);
    requestIds.push(
      assertServerGeneratedRequestId(result.structuredContent, [
        clientRequestId,
        jsonRpcId,
      ])
    );
  }
  assert.equal(backend.requests.length, 0, JSON.stringify(backend.requests));
  const loggedErrorRequestIds = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[MCP_ACTION] '))
    .map((line) => JSON.parse(line.slice('[MCP_ACTION] '.length)))
    .filter(
      (entry) =>
        entry.tool_name === 'firecrawl_parse' && entry.status === 'error'
    )
    .map((entry) => entry.request_id);
  assert.deepEqual(new Set(loggedErrorRequestIds), new Set(requestIds));
  assert.equal(stderr.includes('keyless-zdr-secret'), false, stderr);
  assert.equal(stderr.includes('8.8.8.44'), false, stderr);
});

test('HTTP cloud keyless rejects multi-hop or malformed forwarded IP identity', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  for (const xff of ['8.8.8.8, 10.0.0.1', 'not-an-ip']) {
    const response = await httpToolCall(port, {
      id: `keyless-untrusted-ip-${xff}`,
      headers: { 'x-forwarded-for': xff },
      params: {
        arguments: { limit: 1, query: 'example domain' },
        name: 'firecrawl_search',
      },
    });
    assert.equal(response.status, 200, xff);
    const result = parseSseJson(await response.text()).result;
    assertKeylessAccountRecovery(result, {
      code: 'KEYLESS_ACCESS_NOT_AVAILABLE',
      message: KEYLESS_ACCESS_MESSAGE,
    });
  }
  assert.equal(backend.requests.length, 0, JSON.stringify(backend.requests));
});

test('HTTP cloud keyless accepts one internal IP supplied by the trusted edge', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    id: 'keyless-trusted-internal-ip',
    headers: { 'x-forwarded-for': '10.0.0.1' },
    params: {
      arguments: { limit: 1, query: 'example domain' },
      name: 'firecrawl_search',
    },
  });
  assert.equal(response.status, 200);
  assert.notEqual(parseSseJson(await response.text()).result.isError, true);
  const eligibility = backend.requests.find((r) => r.url === '/v2/keyless/eligibility');
  assert.equal(eligibility.headers['x-firecrawl-keyless-ip'], '10.0.0.1');
});

test('HTTP cloud authenticated Parse forwards ZDR for API-key and managed OAuth sessions', async (t) => {
  const accountResource = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const backend = await startFakeFirecrawlBackend({
    introspectionHandler: ({ token }) =>
      token === 'fc-parse-api-key'
        ? {
            active: true,
            api_key: 'fc-parse-api-key',
            credential_purpose: 'general',
            scope: 'firecrawl:global',
          }
        : token === 'fco_parse'
        ? {
            active: true,
            api_key: 'fc-managed-parse-key',
            api_key_id: '42',
            aud: accountResource,
            credential_purpose: 'hosted_mcp_oauth',
            scope: 'firecrawl:global',
            sub: '00000000-0000-4000-8000-000000000001',
            team_id: '00000000-0000-4000-8000-000000000002',
          }
        : { active: false },
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: accountResource,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  for (const [label, headers] of [
    ['api-key', { 'x-firecrawl-api-key': 'fc-parse-api-key' }],
    ['managed-oauth', { authorization: 'Bearer fco_parse' }],
  ]) {
    const phaseOne = await httpToolCall(port, {
      endpoint: '/v2/mcp-oauth',
      headers,
      id: `${label}-parse-phase-one`,
      params: {
        arguments: { filePath: `/not-read-by-hosted-mcp/${label}.pdf`, zeroDataRetention: true },
        name: 'firecrawl_parse',
      },
    });
    assert.equal(phaseOne.status, 200);
    const phaseOnePayload = JSON.parse(parseSseJson(await phaseOne.text()).result.content[0].text);
    assert.equal(phaseOnePayload.nextToolCall.arguments.zeroDataRetention, true);

    const phaseTwo = await httpToolCall(port, {
      endpoint: '/v2/mcp-oauth',
      headers,
      id: `${label}-parse-phase-two`,
      params: {
        arguments: { uploadRef: 'test-upload-ref', zeroDataRetention: true },
        name: 'firecrawl_parse',
      },
    });
    assert.equal(phaseTwo.status, 200);
    assert.notEqual(parseSseJson(await phaseTwo.text()).result.isError, true);
  }

  const uploads = backend.requests.filter((r) => r.url === '/v2/parse/upload-url');
  const parses = backend.requests.filter((r) => r.url === '/v2/parse');
  const introspectedTokens = backend.requests
    .filter((request) => request.url === '/api/oauth/introspect')
    .map((request) => request.body.token);
  assert.equal(uploads.length, 2);
  assert.equal(parses.length, 2);
  assert.deepEqual(
    introspectedTokens,
    ['fco_parse', 'fco_parse'],
    'only OAuth access tokens may be introspected on the account route'
  );
  assert.equal(uploads[0].headers.authorization, 'Bearer fc-parse-api-key');
  assert.equal(parses[0].headers.authorization, 'Bearer fc-parse-api-key');
  for (const request of [uploads[1], parses[1]]) {
    const assertion = request.headers.authorization?.replace(/^Bearer /, '');
    assert.match(assertion ?? '', /^fcmcp_/);
    assert.equal(assertion?.includes('fc-managed-parse-key'), false);
    assert.equal(assertion?.includes('fco_parse'), false);
  }
  assert.equal(parses[0].body.zeroDataRetention, true);
  assert.equal(parses[1].body.zeroDataRetention, true);
});

test('HTTP cloud transport returns recovery when keyless identity has no client IP', async (t) => {
  const backend = await startFakeFirecrawlBackend({ keylessEligible: true });
  t.after(() => backend.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'keyless-secret',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  await waitForHealth(port, child);

  // Discovery remains keyless-first, but the actual call fails closed because
  // the API cannot enforce the anonymous per-IP allowance.
  const toolCall = await httpToolCall(port, {
    id: 'client-json-rpc-id',
    headers: { 'x-request-id': 'client-request-header-id' },
    params: { arguments: { limit: 1, query: 'example domain' }, name: 'firecrawl_search' },
  });
  assert.equal(toolCall.status, 200);
  const result = parseSseJson(await toolCall.text()).result;
  assertKeylessAccountRecovery(result, {
    code: 'KEYLESS_ACCESS_NOT_AVAILABLE',
    message: KEYLESS_ACCESS_MESSAGE,
    untrustedRequestIds: [
      'client-json-rpc-id',
      'client-request-header-id',
    ],
  });
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

test('hosted keyless warns when KEYLESS_PROXY_SECRET is missing', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: '',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 503);
  assert.match(stderr, /KEYLESS_PROXY_SECRET is missing/);
});

test('account endpoint challenges anonymous clients and accepts API keys', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_ACTION_LOG_SECRET: 'action-secret',
    FIRECRAWL_MCP_RESOURCE_URL: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true });

  const prm = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/v2/mcp-oauth`
  );
  assert.equal(prm.status, 200);
  assert.equal(
    (await prm.json()).resource,
    'https://mcp.firecrawl.dev/v2/mcp-oauth'
  );

  const anonymous = await fetch(`http://127.0.0.1:${port}/v2/mcp-oauth`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  assert.equal(anonymous.status, 401);
  assert.match(
    anonymous.headers.get('www-authenticate') ?? '',
    /oauth-protected-resource\/v2\/mcp-oauth/
  );

  const authenticated = await fetch(`http://127.0.0.1:${port}/v2/mcp-oauth`, {
    body: JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: 'Bearer fc-account-key',
    },
    method: 'POST',
  });
  assert.equal(authenticated.status, 200);
  const names = parseSseJson(await authenticated.text()).result.tools.map(
    (tool) => tool.name
  );
  assert.ok(names.includes('firecrawl_crawl'));
  assert.ok(names.length > 3);
  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'the account route must not introspect raw API keys'
  );
});

test('account endpoint keeps OAuth discovery and gives safe re-auth guidance for inactive OAuth', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await httpToolCall(port, {
    endpoint: '/v2/mcp-oauth',
    headers: { authorization: 'Bearer fco_invalid_account_token' },
    id: 'invalid-account-token',
    params: {
      arguments: { limit: 1, query: 'example domain' },
      name: 'firecrawl_search',
    },
  });

  assert.equal(response.status, 401);
  const wwwAuthenticate = response.headers.get('www-authenticate') ?? '';
  assert.match(wwwAuthenticate, /resource_metadata=/);
  assert.match(wwwAuthenticate, /oauth-protected-resource\/v2\/mcp-oauth/);
  const body = await response.json();
  assert.equal(body.error, 'invalid_token');
  assert.equal(body.code, 'OAUTH_CONNECTION_INVALID');
  assert.equal(body.auth_mode, 'oauth');
  assert.equal(
    body.error_description,
    INVALID_OAUTH_MESSAGE
  );
  assert.equal(body.next_actions, undefined);
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), false);
});

test('account readiness requires the managed OAuth delegation secret', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_ACTION_LOG_SECRET: 'action-secret',
    FIRECRAWL_MCP_RESOURCE_URL: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    MCP_DELEGATED_CREDENTIAL_SECRET: '',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    missing: ['MCP_DELEGATED_CREDENTIAL_SECRET'],
    ok: false,
  });
});

test('credential validation outages do not misdirect clients into OAuth', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  let introspectionCalls = 0;
  const issuer = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/oauth/introspect') {
      introspectionCalls += 1;
      response.destroy();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    issuer.once('error', reject);
    issuer.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        issuer.close((error) => (error ? reject(error) : resolve()));
      })
  );
  const issuerAddress = issuer.address();
  assert.equal(typeof issuerAddress, 'object');
  const issuerUrl = `http://127.0.0.1:${issuerAddress.port}`;

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    FIRECRAWL_OAUTH_ISSUER: issuerUrl,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await waitForHealth(port, child);

  const listTools = (token) =>
    fetch(`http://127.0.0.1:${port}/v2/mcp-oauth`, {
      body: JSON.stringify({ id: token, jsonrpc: '2.0', method: 'tools/list', params: {} }),
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

  // An OAuth access token has nothing to fall back to, so it still fails closed.
  stderr = '';
  const oauth = await listTools('fco_account_token');
  await assertCredentialValidationUnavailable(oauth, 'fco_account_token');

  // An unreachable issuer is a transport fault, not the abort budget firing.
  const oauthRecord = await waitForCredentialValidationLog(() => stderr);
  assert.ok(oauthRecord, `missing validation log in ${stderr}`);
  assert.equal(oauthRecord.reason, 'introspect_transport_error');
  assert.equal(oauthRecord.introspect_status, null);
  assert.equal(oauthRecord.aborted, false);
  assert.equal(oauthRecord.resource, ACCOUNT_RESOURCE);
  assert.equal(typeof oauthRecord.elapsed_ms, 'number');
  assert.doesNotMatch(stderr, /fco_account_token/);
  assert.equal(introspectionCalls, 1);

  // An API key never needs the issuer, so the same outage does not reach it.
  stderr = '';
  const apiKey = await listTools('fc-account-key');
  assert.equal(apiKey.status, 200);
  assert.match(await apiKey.text(), /firecrawl_scrape/);
  assert.equal(
    introspectionCalls,
    1,
    'the API-key request must not make another introspection call'
  );
  assert.doesNotMatch(stderr, /\[MCP_CREDENTIAL_VALIDATION\]/);
});

test('an invalid API key gets recovery from Core without introspection', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const call = await httpToolCall(port, {
    headers: { authorization: 'Bearer fc-invalid' },
    id: 1,
    params: { arguments: { query: 'x' }, name: 'firecrawl_search' },
  });
  assert.equal(call.status, 200);
  const result = parseSseJson(await call.text()).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.equal(result.structuredContent.code, 'CREDENTIAL_INVALID');
  assert.equal(result.structuredContent.message, INVALID_API_KEY_MESSAGE);
  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'Core, not introspection, must decide whether a raw API key is valid'
  );
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), true);

  const forbiddenCall = await httpToolCall(port, {
    headers: { authorization: 'Bearer fc-forbidden' },
    id: 2,
    params: { arguments: { query: 'x' }, name: 'firecrawl_search' },
  });
  assert.equal(forbiddenCall.status, 200);
  const forbiddenResult = parseSseJson(await forbiddenCall.text()).result;
  assert.equal(forbiddenResult.isError, true);
  assert.notEqual(forbiddenResult.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.notEqual(forbiddenResult.structuredContent?.code, 'CREDENTIAL_INVALID');
});

test('feedback tools map a Core 401 to API-key recovery without introspection', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const cases = [
    {
      arguments: {
        querySuggestions: 'Use a narrower query',
        rating: 'bad',
        searchId: '00000000-0000-4000-8000-000000000001',
      },
      name: 'firecrawl_search_feedback',
      path: '/v2/search/00000000-0000-4000-8000-000000000001/feedback',
    },
    {
      arguments: {
        endpoint: 'search',
        jobId: '00000000-0000-4000-8000-000000000002',
        rating: 'bad',
      },
      name: 'firecrawl_feedback',
      path: '/v2/feedback',
    },
  ];

  for (const testCase of cases) {
    const call = await httpToolCall(port, {
      headers: { authorization: 'Bearer fc-invalid' },
      id: testCase.name,
      params: { arguments: testCase.arguments, name: testCase.name },
    });
    assert.equal(call.status, 200, testCase.name);
    const result = parseSseJson(await call.text()).result;
    assert.equal(result.isError, true, testCase.name);
    assert.equal(result.content[0].text, INVALID_API_KEY_MESSAGE, testCase.name);
    assert.equal(result.structuredContent.code, 'CREDENTIAL_INVALID', testCase.name);
    assert.equal(
      backend.requests.some((request) => request.url === testCase.path),
      true,
      testCase.name
    );
  }

  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0
  );
});

test('fetch-based tools map a Core rejection to recovery like SDK tools do', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const cases = [
    {
      arguments: {
        contentType: 'application/pdf',
        filePath: '/not-read-by-hosted-mcp/document.pdf',
        formats: ['markdown'],
        parsers: ['pdf'],
      },
      name: 'firecrawl_parse',
    },
    { arguments: {}, name: 'firecrawl_monitor_list' },
  ];

  for (const testCase of cases) {
    const call = await httpToolCall(port, {
      headers: { authorization: 'Bearer fc-invalid' },
      id: testCase.name,
      params: { arguments: testCase.arguments, name: testCase.name },
    });
    assert.equal(call.status, 200, testCase.name);
    const result = parseSseJson(await call.text()).result;
    assert.equal(result.isError, true, testCase.name);
    assert.equal(result.content[0].text, INVALID_API_KEY_MESSAGE, testCase.name);
    assert.equal(result.structuredContent.code, 'CREDENTIAL_INVALID', testCase.name);
  }

  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0
  );
});

test('an OAuth session keeps its existing Core 401 behavior', async (t) => {
  // The API-key recovery says to replace a key on this server, which is the
  // wrong instruction for a session that authenticated by connecting an
  // account. Only a session that forwarded an unresolved key should get it.
  const backend = await startFakeFirecrawlBackend({
    introspectionHandler: () => ({
      active: true,
      api_key: 'fc-invalid-resolved',
      aud: 'https://mcp.firecrawl.dev/v2/mcp',
      credential_purpose: 'general',
      scope: 'firecrawl:global',
    }),
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const call = await httpToolCall(port, {
    headers: { authorization: 'Bearer fco_resolved_token' },
    id: 1,
    params: { arguments: { query: 'x' }, name: 'firecrawl_search' },
  });
  const result = parseSseJson(await call.text()).result;
  assert.equal(result.isError, true);
  assert.notEqual(result.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.notEqual(result.structuredContent?.code, 'CREDENTIAL_INVALID');

  // Feedback tools intentionally return non-API-key 4xx responses as data so
  // agents do not retry terminal feedback rejections.
  const feedbackCall = await httpToolCall(port, {
    headers: { authorization: 'Bearer fco_resolved_token' },
    id: 2,
    params: {
      arguments: {
        endpoint: 'search',
        jobId: '00000000-0000-4000-8000-000000000003',
        rating: 'bad',
      },
      name: 'firecrawl_feedback',
    },
  });
  assert.equal(feedbackCall.status, 200);
  const feedbackResult = parseSseJson(await feedbackCall.text()).result;
  assert.notEqual(feedbackResult.isError, true);
  assert.deepEqual(JSON.parse(feedbackResult.content[0].text), {
    error: 'Unauthorized: Invalid token',
    retryable: false,
    status: 401,
    success: false,
  });
});

test('active introspection with an unknown credential purpose fails closed', async (t) => {
  const accountResource = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const backend = await startFakeFirecrawlBackend({
    introspectionHandler: () => ({
      active: true,
      api_key: 'fc-untrusted-purpose',
      credential_purpose: 'unexpected',
      scope: 'firecrawl:global',
      aud: accountResource,
    }),
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: accountResource,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'delegation-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await fetch(`http://127.0.0.1:${port}/v2/mcp-oauth`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer fco_unknown_purpose',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  await assertCredentialValidationUnavailable(response, 'unknown purpose');
});

test('a missing delegated signing secret names the resource it failed on', async (t) => {
  const backend = await startFakeFirecrawlBackend({
    introspectionHandler: () => ({
      active: true,
      api_key: 'fc-managed-secret',
      api_key_id: '42',
      aud: ACCOUNT_RESOURCE,
      client_id: 'https://example.test/client',
      credential_purpose: 'hosted_mcp_oauth',
      scope: 'firecrawl:global',
      sub: '00000000-0000-4000-8000-000000000001',
      team_id: '00000000-0000-4000-8000-000000000002',
    }),
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: ACCOUNT_RESOURCE,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    MCP_DELEGATED_CREDENTIAL_SECRET: '',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await waitForHealth(port, child);

  const response = await fetch(`http://127.0.0.1:${port}/v2/mcp-oauth`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer fco_managed_token',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  await assertCredentialValidationUnavailable(response, 'missing delegation secret');

  // Introspection succeeded here, so the record has no status or timing. The
  // resource is the only context distinguishing which surface was affected.
  const record = await waitForCredentialValidationLog(() => stderr);
  assert.ok(record, `missing validation log in ${stderr}`);
  assert.equal(record.reason, 'delegated_signing_secret_missing');
  assert.equal(record.resource, ACCOUNT_RESOURCE);
  assert.equal(record.introspect_status, null);
});

test('each credential validation failure logs its own reason and status', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());

  // Introspection responses are swapped per case so one server exercises every
  // way the check can come back unusable.
  let respond = () => ({ body: '{}', status: 500 });
  const issuerPort = await getFreePort();
  const issuer = createServer(async (req, res) => {
    req.setEncoding('utf8');
    for await (const chunk of req) void chunk;
    if (req.method === 'POST' && req.url === '/api/oauth/introspect') {
      const { body, contentType = 'application/json', status } = respond();
      res.writeHead(status, { 'content-type': contentType });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => issuer.listen(issuerPort, '127.0.0.1', resolve));
  t.after(() => issuer.close());

  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    FIRECRAWL_OAUTH_ISSUER: `http://127.0.0.1:${issuerPort}`,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret-value',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await waitForHealth(port, child);

  const clientToken = 'fco_client_access_token_value';
  const resolvedApiKey = 'fc-resolved-api-key-value';
  const cases = [
    {
      // What an introspection endpoint returns when it rejects this server's
      // own shared secret: a clean, fast answer that is still not a 2xx.
      expectedStatus: 401,
      reason: 'introspect_http_status',
      respond: () => ({ body: JSON.stringify({ active: false }), status: 401 }),
    },
    {
      expectedStatus: 200,
      reason: 'introspect_content_type',
      respond: () => ({
        body: '<html>gateway</html>',
        contentType: 'text/html',
        status: 200,
      }),
    },
    {
      expectedStatus: 200,
      reason: 'introspect_malformed_body',
      respond: () => ({ body: JSON.stringify({ active: 'yes' }), status: 200 }),
    },
    {
      // A JSON null would throw on the `active` read and escape as an OAuth
      // challenge carrying the raw parser message.
      expectedStatus: 200,
      reason: 'introspect_malformed_body',
      respond: () => ({ body: 'null', status: 200 }),
    },
    {
      // Truncated body under a JSON content type: same escape route.
      expectedStatus: 200,
      reason: 'introspect_malformed_body',
      respond: () => ({ body: '{"active":true', status: 200 }),
    },
    {
      // Introspection answered cleanly and the credential it described cannot
      // be used on this resource. Tagged apart from an outage.
      expectedStatus: 200,
      reason: 'introspect_unusable_credential',
      respond: () => ({
        body: JSON.stringify({
          active: true,
          api_key: resolvedApiKey,
          credential_purpose: 'general',
          scope: '',
        }),
        status: 200,
      }),
    },
  ];

  for (const testCase of cases) {
    respond = testCase.respond;
    stderr = '';
    const response = await fetch(`http://127.0.0.1:${port}/v2/mcp-oauth`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    await assertCredentialValidationUnavailable(response, testCase.reason);

    const record = await waitForCredentialValidationLog(() => stderr);
    assert.ok(record, `${testCase.reason}: missing validation log in ${stderr}`);
    assert.equal(record.reason, testCase.reason);
    assert.equal(record.introspect_status, testCase.expectedStatus, testCase.reason);
    assert.equal(record.resource, ACCOUNT_RESOURCE, testCase.reason);
    assert.equal(record.aborted, null, testCase.reason);
    assert.equal(typeof record.elapsed_ms, 'number', testCase.reason);
    assert.ok(record.elapsed_ms >= 0, testCase.reason);

    // The log exists for operators. It must never carry credential material.
    for (const secret of [clientToken, resolvedApiKey, 'introspect-secret-value']) {
      assert.doesNotMatch(stderr, new RegExp(secret), `${testCase.reason}: ${secret}`);
    }
  }
});

test('account endpoint accepts legacy OAuth one way and delegates managed keys', async (t) => {
  const accountResource = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const legacyResource = 'https://mcp.firecrawl.dev/v2/mcp';
  const metadata = {
    active: true,
    api_key: 'fc-managed-secret',
    api_key_id: '42',
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    credential_purpose: 'hosted_mcp_oauth',
    scope: 'firecrawl:global',
    sub: '00000000-0000-4000-8000-000000000001',
    team_id: '00000000-0000-4000-8000-000000000002',
  };
  const backend = await startFakeFirecrawlBackend({
    introspectionHandler: ({ resource, token }) => {
      if (token === 'fco_account') return { ...metadata, aud: accountResource };
      if (token === 'fco_legacy') {
        return resource === legacyResource
          ? { ...metadata, aud: legacyResource }
          : { active: false };
      }
      return { active: false };
    },
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_ACTION_LOG_SECRET: 'action-secret',
    FIRECRAWL_MCP_RESOURCE_URL: accountResource,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    FIRECRAWL_API_KEY: 'fc-shared-env-must-not-be-used',
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'delegation-secret',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  for (const token of ['fco_account', 'fco_legacy']) {
    const response = await httpToolCall(port, {
      endpoint: '/v2/mcp-oauth',
      headers: { authorization: `Bearer ${token}` },
      id: token,
      params: {
        arguments: { limit: 1, query: 'delegated credential' },
        name: 'firecrawl_search',
      },
    });
    assert.equal(response.status, 200);
    assert.notEqual(parseSseJson(await response.text()).result.isError, true);
  }

  const searchCalls = backend.requests.filter((request) => request.url === '/v2/search');
  assert.equal(searchCalls.length, 2);
  for (const request of searchCalls) {
    const assertion = request.headers.authorization?.replace(/^Bearer /, '');
    assert.match(assertion ?? '', /^fcmcp_/);
    const payload = JSON.parse(
      Buffer.from(assertion.split('.')[0].slice('fcmcp_'.length), 'base64url').toString()
    );
    assert.equal(payload.api_key, 'fc-managed-secret');
    assert.equal(payload.purpose, 'hosted_mcp_oauth');
  }

  const monitorResponse = await httpToolCall(port, {
    endpoint: '/v2/mcp-oauth',
    headers: { authorization: 'Bearer fco_account' },
    id: 'managed-monitor',
    params: {
      arguments: { limit: 1 },
      name: 'firecrawl_monitor_list',
    },
  });
  assert.equal(monitorResponse.status, 200);
  assert.notEqual(parseSseJson(await monitorResponse.text()).result.isError, true);
  const monitorCalls = backend.requests.filter((request) =>
    request.url?.startsWith('/v2/monitor')
  );
  assert.equal(monitorCalls.length, 1);
  const monitorAssertion = monitorCalls[0].headers.authorization?.replace(/^Bearer /, '');
  assert.match(monitorAssertion ?? '', /^fcmcp_/);
  assert.notEqual(monitorAssertion, 'fc-shared-env-must-not-be-used');
  const monitorPayload = JSON.parse(
    Buffer.from(
      monitorAssertion.split('.')[0].slice('fcmcp_'.length),
      'base64url'
    ).toString()
  );
  assert.equal(monitorPayload.api_key, 'fc-managed-secret');
  assert.equal(monitorPayload.purpose, 'hosted_mcp_oauth');

  const deprecatedExtractResponse = await httpToolCall(port, {
    endpoint: '/v2/mcp-oauth',
    headers: { authorization: 'Bearer fco_account' },
    id: 'managed-deprecated-extract',
    params: { arguments: {}, name: 'firecrawl_extract' },
  });
  assert.equal(deprecatedExtractResponse.status, 200);
  const deprecatedExtractResult = parseSseJson(
    await deprecatedExtractResponse.text()
  ).result;
  assert.equal(deprecatedExtractResult.isError, true);
  assert.equal(deprecatedExtractResult.structuredContent.code, 'DEPRECATED_TOOL');

  const legacyAttempts = backend.requests
    .filter((request) => request.url === '/api/oauth/introspect')
    .filter((request) => request.body.token === 'fco_legacy')
    .map((request) => request.body.resource);
  assert.deepEqual(legacyAttempts, [accountResource, legacyResource]);

  for (let i = 0; i < 20; i += 1) {
    if (
      backend.requests.filter(
        (request) => request.url === '/v2/mcp/action-logs'
      ).length === 4
    ) {
      break;
    }
    await delay(25);
  }
  const actionLogs = backend.requests.filter(
    (request) => request.url === '/v2/mcp/action-logs'
  );
  assert.equal(actionLogs.length, 4);
  const deprecatedExtractLog = actionLogs.find(
    request => request.body.tool_name === 'firecrawl_extract'
  );
  assert.ok(deprecatedExtractLog);
  assert.equal(deprecatedExtractLog.body.status, 'error');
  assert.equal(deprecatedExtractLog.body.error_class, 'UserError');

  for (const request of actionLogs) {
    assert.equal(request.headers.authorization, 'Bearer action-secret');
    assert.equal(request.body.auth_type, 'oauth');
    assert.equal(request.body.api_key_id, '42');
    assert.equal(request.body.team_id, metadata.team_id);
    assert.equal(request.body.user_id, metadata.sub);
    assert.equal(request.body.oauth_client_id, metadata.client_id);
    assert.equal(request.body.resource, accountResource);
    assert.equal(JSON.stringify(request.body).includes('fc-managed-secret'), false);
    assert.equal(JSON.stringify(request.body).includes('fco_'), false);
  }
  assert.equal(
    actionLogs.filter(request => request.body.status === 'success').length,
    3
  );
  assert.equal(stderr.includes('fc-managed-secret'), false);
  assert.equal(stderr.includes('fco_account'), false);
  assert.equal(stderr.includes('fco_legacy'), false);
});

test('legacy key-in-path telemetry is sanitized and does not leak the credential', async (t) => {
  const backend = await startFakeFirecrawlBackend();
  t.after(() => backend.close());
  const port = await getFreePort();
  const legacyCredential = 'fc-legacy-path-secret';
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(port),
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const response = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-firecrawl-api-key': legacyCredential,
      'x-firecrawl-key-transport': 'path',
    },
    method: 'POST',
  });
  assert.equal(response.status, 200);
  const legacyTools = parseSseJson(await response.text()).result.tools.map((tool) => tool.name);
  assert.ok(legacyTools.includes('firecrawl_scrape'));
  assert.ok(legacyTools.includes('firecrawl_search'));
  assert.ok(legacyTools.includes('firecrawl_map'), legacyTools.join(', '));
  await delay(25);

  const telemetry = stdout
    .split(/\r?\n/)
    .find((line) => line.includes('[MCP_LEGACY_KEY_PATH]'));
  assert.ok(telemetry, stdout);
  assert.match(telemetry, /"key_transport":"path"/);
  assert.match(telemetry, /"outcome":"accepted"/);
  assert.match(telemetry, /"resource":"https:\/\/mcp\.firecrawl\.dev\/v2\/mcp"/);
  assert.doesNotMatch(telemetry, new RegExp(legacyCredential));
  assert.doesNotMatch(telemetry, /\bfc-[^\s"]+/);
  assert.doesNotMatch(telemetry, /(?:\d{1,3}\.){3}\d{1,3}|::1/);
});

test('hosted profile selection fails closed for an unsupported endpoint', async () => {
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/not-a-real-profile',
    HTTP_STREAMABLE_SERVER: 'true',
    PORT: String(await getFreePort()),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => 'timeout'),
  ]);
  if (exitCode === 'timeout') {
    await stopChild(child);
    assert.fail('server did not fail closed for unsupported FASTMCP_ENDPOINT');
  }
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Unsupported FASTMCP_ENDPOINT/);
});

test('account OAuth tokens cannot replay on keyless and invalid keys get correction', async (t) => {
  const accountResource = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const backend = await startFakeFirecrawlBackend({
    introspectionHandler: ({ token }) =>
      token === 'fco_account'
        ? {
            active: true,
            api_key: 'fc-managed-secret',
            aud: accountResource,
            credential_purpose: 'hosted_mcp_oauth',
            scope: 'firecrawl:global',
          }
        : { active: false },
  });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'delegation-secret',
    PORT: String(port),
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const replay = await httpToolCall(port, {
    headers: { authorization: 'Bearer fco_account' },
    id: 1,
    params: { arguments: { query: 'x' }, name: 'firecrawl_search' },
  });
  assert.equal(replay.status, 401);

  // A well-formed API key is admitted because only Core can decide whether it
  // is valid. The session lists tools, then a Core 401 becomes an agent-legible
  // CREDENTIAL_INVALID result instead of an unreachable transport 401.
  const invalidList = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer fc-invalid',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  assert.equal(invalidList.status, 200);
  const invalidListJson = parseSseJson(await invalidList.text());
  assert.ok(
    (invalidListJson.result?.tools?.length ?? 0) > 0,
    'invalid key still lists tools so the client proceeds to a callable tool'
  );

  const invalidCall = await httpToolCall(port, {
    headers: {
      authorization: 'Bearer fc-invalid',
      'x-request-id': 'invalid-client-request-header-id',
    },
    id: 3,
    params: { arguments: { query: 'x' }, name: 'firecrawl_search' },
  });
  assert.equal(invalidCall.status, 200);
  const invalidCallJson = parseSseJson(await invalidCall.text());
  const invalidRecovery = invalidCallJson.result.structuredContent;
  assert.equal(invalidCallJson.result.isError, true);
  assert.equal(invalidCallJson.result.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.equal(invalidRecovery.code, 'CREDENTIAL_INVALID');
  assert.equal(invalidRecovery.message, INVALID_API_KEY_MESSAGE);
  assert.equal(invalidCallJson.result.content[0].text, invalidRecovery.message);
  assert.equal(invalidRecovery.next_actions, undefined);
  assert.doesNotMatch(invalidRecovery.message, /ask the human/i);
  assert.doesNotMatch(invalidRecovery.message, /never ask/i);
  assert.doesNotMatch(invalidRecovery.message, /outside this chat/i);
  assert.doesNotMatch(invalidRecovery.message, /Authorization: Bearer/);
  // The rejected credential cannot call any tool, so the recovery payload must
  // not advertise keyless tools as available.
  assert.equal(
    invalidRecovery.available_tools,
    undefined,
    'CREDENTIAL_INVALID must not advertise tools the agent cannot call'
  );

  const invalidLegacyPath = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({ id: 4, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-firecrawl-api-key': 'fc-invalid',
      'x-firecrawl-key-transport': 'path',
    },
    method: 'POST',
  });
  assert.equal(invalidLegacyPath.status, 200);
  const invalidLegacyJson = parseSseJson(await invalidLegacyPath.text());
  assert.ok((invalidLegacyJson.result?.tools?.length ?? 0) > 0);
  await delay(25);
  // A well-formed API key is admitted at connect time because Core owns the
  // verdict. The legacy-path record must still contain no credential material.
  const legacyTelemetry = stdout
    .split(/\r?\n/)
    .find((line) => line.includes('[MCP_LEGACY_KEY_PATH]'));
  assert.ok(legacyTelemetry, stdout);
  assert.match(legacyTelemetry, /"outcome":"accepted"/);
  assert.doesNotMatch(legacyTelemetry, /\bfc-[^\s"]+/);
  assert.doesNotMatch(legacyTelemetry, /(?:\d{1,3}\.){3}\d{1,3}|::1/);
  const introspectedTokens = backend.requests
    .filter((request) => request.url === '/api/oauth/introspect')
    .map((request) => request.body.token);
  assert.deepEqual(introspectedTokens, ['fco_account']);
});
