import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertAgentMetadataPolicy } from '../scripts/agent-metadata-policy.mjs';

// The fixed contract of the search surface. Nothing outside this set may ever
// appear on its tools/list or be callable through it.
const SEARCH_TOOLS = [
  'firecrawl_search',
  'firecrawl_developer_search',
  'firecrawl_research_search_papers',
  'firecrawl_research_inspect_paper',
  'firecrawl_research_related_papers',
  'firecrawl_research_read_paper',
];

// A representative sample of the full-surface tools that must NOT leak here.
const EXCLUDED_TOOLS = [
  'firecrawl_scrape',
  'firecrawl_map',
  'firecrawl_crawl',
  'firecrawl_check_crawl_status',
  'firecrawl_extract',
  'firecrawl_agent',
  'firecrawl_interact',
  'firecrawl_parse',
  'firecrawl_monitor_create',
  'firecrawl_search_feedback',
  'firecrawl_feedback',
  'firecrawl_research_search_github',
];

const SEARCH_ENDPOINT = '/v2/mcp-search';
const SEARCH_RESOURCE = 'https://mcp.firecrawl.dev/v2/mcp-search';
const INVALID_API_KEY_MESSAGE =
  'The Firecrawl API key is invalid or revoked.\nFix: Replace the key on the existing Firecrawl MCP server, then start a new session. Get an API key at https://www.firecrawl.dev/app/api-keys';

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
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

// Fake origin standing in for both the Firecrawl API (/v2/search) and the OAuth
// issuer (/api/oauth/introspect). Introspection echoes a configurable audience
// so audience-enforcement can be exercised.
async function startFakeBackend(options = {}) {
  const {
    apiKeyFromIntrospection = 'fc-from-introspection',
    introspectionAud,
  } = options;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;

    const contentType = req.headers['content-type'] ?? '';
    let body;
    if (raw && contentType.includes('application/json')) {
      body = JSON.parse(raw);
    } else if (raw && contentType.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    requests.push({ body, headers: req.headers, method: req.method, url: req.url });

    if (req.method === 'POST' && req.url === '/api/oauth/introspect') {
      const token = body?.token ?? '';
      const active = /^(?:fco_|fc-)/.test(token) && !token.includes('invalid');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          active
            ? {
                active: true,
                api_key: token.startsWith('fc-')
                  ? token
                  : apiKeyFromIntrospection,
                credential_purpose: token.startsWith('fco_')
                  ? 'hosted_mcp_oauth'
                  : 'general',
                scope: 'firecrawl:global',
                ...(introspectionAud ? { aud: introspectionAud } : {}),
              }
            : { active: false }
        )
      );
      return;
    }

    // Core, not introspection, decides whether a forwarded API key is valid.
    if (/Bearer fc-\S*invalid/.test(req.headers.authorization ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid token', success: false }));
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/v2/search/developer')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              id: 'issue:firecrawl/firecrawl#1',
              passages: [{ text: 'The matched passage.' }],
              title: 'Fix the retry loop',
              url: 'https://github.com/firecrawl/firecrawl/issues/1',
            },
          ],
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v2/search') {
      // The developer category returns developer-tagged hits in the standard
      // web group, matching the live Search response shape.
      const wantsDeveloper = (body?.categories ?? []).some((category) =>
        typeof category === 'string'
          ? category === 'developer'
          : category?.type === 'developer'
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          creditsUsed: 1,
          data: {
            web: wantsDeveloper
              ? [
                  {
                    category: 'developer',
                    description: 'The matched passage.',
                    title: 'Fix the retry loop',
                    url: 'https://github.com/firecrawl/firecrawl/issues/1',
                  },
                ]
              : [{ title: 'Example Domain', url: 'https://example.com/' }],
          },
          id: '00000000-0000-4000-8000-000000000000',
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
  const { port } = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// Spawn a hosted server with both the full and search instances running, and
// wait until the search instance is healthy. Returns ports + a stderr accessor.
async function startHostedServer(t, extraEnv = {}) {
  const defaultBackend = await startFakeBackend();
  t.after(() => defaultBackend.close());
  const fullPort = await getFreePort();
  const searchPort = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    KEYLESS_PROXY_SECRET: 'delegation-secret',
    FIRECRAWL_API_URL: defaultBackend.url,
    FIRECRAWL_OAUTH_ISSUER: defaultBackend.url,
    PORT: String(fullPort),
    FIRECRAWL_MCP_SEARCH_PORT: String(searchPort),
    ...extraEnv,
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(searchPort, child);
  return {
    backendRequests: defaultBackend.requests,
    child,
    fullPort,
    searchPort,
    issuerUrl: extraEnv.FIRECRAWL_OAUTH_ISSUER ?? defaultBackend.url,
    getStderr: () => stderr,
    getStdout: () => stdout,
  };
}

// The dedicated search deployment runs the search profile as its primary
// listener on :3000. Unlike the live companion, it deliberately has no
// KEYLESS_PROXY_SECRET and rejects every API-key transport.
async function startPrimarySearchServer(t, extraEnv = {}) {
  const defaultBackend = await startFakeBackend({ introspectionAud: SEARCH_RESOURCE });
  t.after(() => defaultBackend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: SEARCH_ENDPOINT,
    FIRECRAWL_API_URL: defaultBackend.url,
    FIRECRAWL_MCP_SEARCH_RESOURCE_URL: SEARCH_RESOURCE,
    FIRECRAWL_MCP_SEARCH_OAUTH_ONLY: 'true',
    FIRECRAWL_OAUTH_ISSUER: defaultBackend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    PORT: String(port),
    ...extraEnv,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);
  return {
    backendRequests: defaultBackend.requests,
    child,
    getStderr: () => stderr,
    issuerUrl: extraEnv.FIRECRAWL_OAUTH_ISSUER ?? defaultBackend.url,
    port,
  };
}

function jsonRpc(port, endpoint, { id, method, params = {}, headers = {} }) {
  return fetch(`http://127.0.0.1:${port}${endpoint}`, {
    body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });
}

async function listToolDefinitions(port, endpoint, headers) {
  const res = await jsonRpc(port, endpoint, {
    id: 1,
    method: 'tools/list',
    headers,
  });
  assert.equal(res.status, 200, `tools/list returned ${res.status}`);
  const message = parseSseJson(await res.text());
  return message.result.tools;
}

async function initializeProfile(port, endpoint, headers) {
  const res = await jsonRpc(port, endpoint, {
    id: 0,
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'firecrawl-search-profile-test', version: '1.0.0' },
      protocolVersion: '2025-06-18',
    },
    headers,
  });
  assert.equal(res.status, 200, `initialize returned ${res.status}`);
  return parseSseJson(await res.text()).result;
}

async function listTools(port, endpoint, headers) {
  const tools = await listToolDefinitions(port, endpoint, headers);
  return tools.map((tool) => tool.name);
}

test('search surface lists exactly the six read-only tools', async (t) => {
  const { searchPort, getStderr } = await startHostedServer(t);

  const tools = await listToolDefinitions(searchPort, SEARCH_ENDPOINT, {
    'x-api-key': 'fc-test',
  });
  const names = tools.map((tool) => tool.name);
  const search = tools.find((tool) => tool.name === 'firecrawl_search');
  assert.ok(search);
  assert.match(
    search.description,
    /categories: \["developer"\].*data\.web.*category.*developer/is
  );
  assert.match(
    search.description,
    /each web result is a title, URL, and description, not the page/i
  );
  assert.doesNotMatch(search.description, /data\.developer/i);

  assert.deepEqual([...names].sort(), [...SEARCH_TOOLS].sort());
  for (const excluded of EXCLUDED_TOOLS) {
    assert.equal(names.includes(excluded), false, `${excluded} must not appear`);
  }
  assert.equal(getStderr().includes('TypeError'), false, getStderr());
});

test('the hidden github tool answers cached callers with a DEPRECATED_TOOL payload', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
  });

  // Not on tools/list (EXCLUDED_TOOLS covers that), but a session that cached
  // the old list must get a pointer to the replacement, not unknown tool.
  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 9,
    method: 'tools/call',
    params: {
      arguments: { query: 'milvus hybrid search' },
      name: 'firecrawl_research_search_github',
    },
    headers: { 'x-api-key': 'fc-test' },
  });
  const message = parseSseJson(await res.text());
  assert.equal(message.result?.isError, true, JSON.stringify(message));
  assert.equal(message.result.structuredContent.code, 'DEPRECATED_TOOL');
  assert.equal(
    message.result.structuredContent.replacement.name,
    'firecrawl_developer_search'
  );
  assert.equal(
    backend.requests.some((r) => r.url.includes('/research/github')),
    false,
    'must not reach the upstream endpoint'
  );
});

test('search surface does not expose an excluded tool', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 2,
    method: 'tools/call',
    params: { arguments: { url: 'https://example.com' }, name: 'firecrawl_scrape' },
    headers: { 'x-api-key': 'fc-test' },
  });
  // Unknown tool: either a JSON-RPC error or an error result, never a scrape.
  const message = parseSseJson(await res.text());
  const errored = Boolean(message.error) || message.result?.isError === true;
  assert.equal(errored, true, JSON.stringify(message));
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
});

test('search firecrawl_search rejects scrapeOptions and never fetches page content', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 3,
    method: 'tools/call',
    params: {
      arguments: {
        query: 'example domain',
        limit: 1,
        scrapeOptions: { formats: ['markdown'] },
      },
      name: 'firecrawl_search',
    },
    headers: { 'x-api-key': 'fc-test' },
  });
  const message = parseSseJson(await res.text());
  const errored = Boolean(message.error) || message.result?.isError === true;
  assert.equal(errored, true, JSON.stringify(message));
  // The rejected call must not have reached the API.
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
});

test('search firecrawl_search sends a clean body built from allowed fields only', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 4,
    method: 'tools/call',
    params: {
      arguments: {
        country: 'DE',
        ignoreInvalidURLs: true,
        query: 'example domain',
        limit: 1,
        sources: [{ type: 'web' }],
        timeout: 30000,
      },
      name: 'firecrawl_search',
    },
    headers: { 'x-api-key': 'fc-search-key' },
  });
  assert.equal(res.status, 200);
  const message = parseSseJson(await res.text());
  assert.notEqual(message.result?.isError, true, JSON.stringify(message));

  const searchCalls = backend.requests.filter((r) => r.url === '/v2/search');
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].headers.authorization, 'Bearer fc-search-key');
  const sentBody = searchCalls[0].body;
  assert.equal('scrapeOptions' in sentBody, false);
  const allowedKeys = new Set([
    'query',
    'limit',
    'tbs',
    'filter',
    'location',
    'country',
    'timeout',
    'ignoreInvalidURLs',
    'sources',
    'categories',
    'highlights',
    'enterprise',
    'origin',
  ]);
  for (const key of Object.keys(sentBody)) {
    assert.equal(allowedKeys.has(key), true, `unexpected outbound field: ${key}`);
  }
  assert.deepEqual(sentBody, {
    country: 'DE',
    ignoreInvalidURLs: true,
    query: 'example domain',
    limit: 1,
    sources: [{ type: 'web' }],
    timeout: 30000,
    origin: 'mcp-fastmcp',
  });
});

test('search firecrawl_search forwards the developer category in the web group', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 41,
    method: 'tools/call',
    params: {
      arguments: {
        query: 'retry loop backoff',
        categories: ['developer'],
        limit: 1,
      },
      name: 'firecrawl_search',
    },
    headers: { 'x-api-key': 'fc-search-key' },
  });
  assert.equal(res.status, 200);
  const message = parseSseJson(await res.text());
  assert.notEqual(message.result?.isError, true, JSON.stringify(message));

  const searchCalls = backend.requests.filter((r) => r.url === '/v2/search');
  assert.equal(searchCalls.length, 1);
  assert.deepEqual(searchCalls[0].body.categories, ['developer']);

  // The tool returns the API envelope unchanged, so the developer-tagged web
  // result must survive into the tool result without a legacy developer group.
  const envelope = JSON.parse(message.result.content[0].text);
  assert.deepEqual(envelope.data.web, [
    {
      category: 'developer',
      description: 'The matched passage.',
      title: 'Fix the retry loop',
      url: 'https://github.com/firecrawl/firecrawl/issues/1',
    },
  ]);
  assert.equal('developer' in envelope.data, false);
});

test('search firecrawl_developer_search queries the developer index and returns its passages', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 42,
    method: 'tools/call',
    params: {
      arguments: { query: 'retry loop backoff', k: 1 },
      name: 'firecrawl_developer_search',
    },
    headers: { 'x-api-key': 'fc-search-key' },
  });
  assert.equal(res.status, 200);
  const message = parseSseJson(await res.text());
  assert.notEqual(message.result?.isError, true, JSON.stringify(message));

  const developerCalls = backend.requests.filter((request) =>
    request.url?.startsWith('/v2/search/developer')
  );
  assert.equal(developerCalls.length, 1);
  const query = new URL(developerCalls[0].url, 'http://localhost').searchParams;
  assert.equal(query.get('query'), 'retry loop backoff');
  assert.equal(query.get('k'), '1');
  assert.equal(query.has('skills'), false);

  const text = message.result.content[0].text;
  assert.match(text, /issue:firecrawl\/firecrawl#1/);
  assert.match(text, /The matched passage\./);
  // The developer tool must not reach the web search endpoint.
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), false);

  // skills is the one filter categories: ["developer"] cannot reach, so assert
  // it is forwarded rather than dropped.
  const skillsRes = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 43,
    method: 'tools/call',
    params: {
      arguments: { query: 'retry loop backoff', skills: 'only' },
      name: 'firecrawl_developer_search',
    },
    headers: { 'x-api-key': 'fc-search-key' },
  });
  assert.equal(skillsRes.status, 200);
  const skillsMessage = parseSseJson(await skillsRes.text());
  assert.notEqual(
    skillsMessage.result?.isError,
    true,
    JSON.stringify(skillsMessage)
  );

  const skillsCalls = backend.requests.filter((request) =>
    request.url?.startsWith('/v2/search/developer')
  );
  assert.equal(skillsCalls.length, 2);
  const skillsQuery = new URL(skillsCalls[1].url, 'http://localhost')
    .searchParams;
  assert.equal(skillsQuery.get('skills'), 'only');
  assert.equal(skillsQuery.get('query'), 'retry loop backoff');
});

test('search surface requires authentication for tools/list', async (t) => {
  const { searchPort, issuerUrl } = await startHostedServer(t);

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 5,
    method: 'tools/list',
  });
  assert.equal(res.status, 401);
  const wwwAuthenticate = res.headers.get('www-authenticate') ?? '';
  assert.match(wwwAuthenticate, /^Bearer /);
  assert.match(
    wwwAuthenticate,
    /resource_metadata="https:\/\/mcp\.firecrawl\.dev\/\.well-known\/oauth-protected-resource\/v2\/mcp-search"/
  );
  assert.match(wwwAuthenticate, /error="invalid_token"/);
});

test('search companion admits a well-formed API key without introspection', async (t) => {
  const { backendRequests, searchPort } = await startHostedServer(t);

  // Core authenticates the key when a tool runs. tools/list must not depend on
  // the OAuth issuer or claim to know whether the raw key is valid.
  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 8,
    method: 'tools/list',
    headers: { 'x-api-key': 'fc-invalid' },
  });
  assert.equal(res.status, 200);
  const message = parseSseJson(await res.text());
  assert.ok((message.result?.tools?.length ?? 0) > 0);
  assert.equal(
    backendRequests.filter((request) => request.url === '/api/oauth/introspect').length,
    0
  );
});

test('search companion turns a Core credential rejection into recovery', async (t) => {
  const backend = await startFakeBackend();
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 9,
    method: 'tools/call',
    params: {
      arguments: { query: 'example domain', limit: 1 },
      name: 'firecrawl_search',
    },
    headers: { 'x-api-key': 'fc-invalid' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.has('www-authenticate'), false);
  const result = parseSseJson(await res.text()).result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, INVALID_API_KEY_MESSAGE);
  assert.equal(result.structuredContent.code, 'CREDENTIAL_INVALID');
  assert.equal(result.structuredContent.message, INVALID_API_KEY_MESSAGE);
  assert.equal(result.structuredContent.next_actions, undefined);
  assert.equal(backend.requests.some((request) => request.url === '/v2/search'), true);
  assert.equal(
    backend.requests.filter((request) => request.url === '/api/oauth/introspect').length,
    0
  );
});

test('search surface serves path-scoped protected-resource metadata', async (t) => {
  const { searchPort, issuerUrl } = await startHostedServer(t);

  const res = await fetch(
    `http://127.0.0.1:${searchPort}/.well-known/oauth-protected-resource${SEARCH_ENDPOINT}`
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    authorization_servers: [issuerUrl],
    bearer_methods_supported: ['header'],
    resource: SEARCH_RESOURCE,
    resource_name: 'Firecrawl Search',
    scopes_supported: ['firecrawl:global'],
  });
});

test('search surface rejects a token minted for a different resource', async (t) => {
  const backend = await startFakeBackend({
    apiKeyFromIntrospection: 'fc-introspected',
    introspectionAud: 'https://mcp.firecrawl.dev/v2/mcp', // the full resource, not search
  });
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 6,
    method: 'tools/call',
    params: { arguments: { query: 'x', limit: 1 }, name: 'firecrawl_search' },
    headers: { authorization: 'Bearer fco_other_resource_token' },
  });
  assert.equal(res.status, 401);
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
});

test('search surface rejects an OAuth token with no audience binding', async (t) => {
  // Introspection returns no `aud` (token was minted without a resource
  // binding). A locked-down surface must fail closed rather than accept it.
  const backend = await startFakeBackend({
    apiKeyFromIntrospection: 'fc-introspected',
    // introspectionAud omitted → introspect response has no aud field
  });
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 8,
    method: 'tools/call',
    params: { arguments: { query: 'x', limit: 1 }, name: 'firecrawl_search' },
    headers: { authorization: 'Bearer fco_unbound_token' },
  });
  assert.equal(res.status, 401);
  assert.equal(backend.requests.some((r) => r.url === '/v2/search'), false);
});

test('search surface accepts a token minted for its own resource', async (t) => {
  const backend = await startFakeBackend({
    apiKeyFromIntrospection: 'fc-introspected',
    introspectionAud: SEARCH_RESOURCE,
  });
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'introspect-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
  });

  const res = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 7,
    method: 'tools/call',
    params: { arguments: { query: 'x', limit: 1 }, name: 'firecrawl_search' },
    headers: { authorization: 'Bearer fco_search_resource_token' },
  });
  assert.equal(res.status, 200);
  const message = parseSseJson(await res.text());
  assert.notEqual(message.result?.isError, true, JSON.stringify(message));
  const searchCalls = backend.requests.filter((r) => r.url === '/v2/search');
  assert.equal(searchCalls.length, 1);
  assert.match(searchCalls[0].headers.authorization ?? '', /^Bearer fcmcp_/);
});

test('full surface still exposes its complete tool set alongside the search surface', async (t) => {
  const { backendRequests, fullPort } = await startHostedServer(t);

  // Full surface is reachable on its own port with all tools intact.
  const names = await listTools(fullPort, '/v2/mcp', { 'x-api-key': 'fc-test' });
  assert.ok(names.includes('firecrawl_scrape'));
  assert.ok(names.includes('firecrawl_search'));
  assert.ok(names.includes('firecrawl_developer_search'));
  assert.ok(names.includes('firecrawl_parse'));
  assert.ok(names.length > SEARCH_TOOLS.length);
  assert.equal(
    backendRequests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'the full route must not introspect raw API keys'
  );

  // The anonymous full surface accepts credentials but does not advertise
  // OAuth, so clients do not start login while configuring keyless MCP.
  const prm = await fetch(
    `http://127.0.0.1:${fullPort}/.well-known/oauth-protected-resource`
  );
  assert.equal(prm.status, 404);
});

test('primary search profile is OAuth-only, six-tool frozen, and ready without keyless configuration', async (t) => {
  const { backendRequests, port, issuerUrl } = await startPrimarySearchServer(t);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true });

  const anonymous = await jsonRpc(port, SEARCH_ENDPOINT, {
    id: 10,
    method: 'tools/list',
  });
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.text();
  assert.match(anonymousBody, /OAuth access token required/);
  assert.doesNotMatch(anonymousBody, /API key/i);
  assert.match(
    anonymous.headers.get('www-authenticate') ?? '',
    /oauth-protected-resource\/v2\/mcp-search/
  );

  for (const headers of [
    { authorization: 'Bearer fc-primary-search-api-key' },
    { 'x-api-key': 'fc-primary-search-api-key' },
    { 'x-firecrawl-api-key': 'fc-primary-search-api-key' },
  ]) {
    const response = await jsonRpc(port, SEARCH_ENDPOINT, {
      id: JSON.stringify(headers),
      method: 'tools/list',
      headers,
    });
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer /);
  }
  assert.equal(
    backendRequests.filter((request) => request.url === '/api/oauth/introspect').length,
    0,
    'the OAuth-only route must reject raw API keys without introspection'
  );

  const prm = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource${SEARCH_ENDPOINT}`
  );
  assert.equal(prm.status, 200);
  assert.deepEqual(await prm.json(), {
    authorization_servers: [issuerUrl],
    bearer_methods_supported: ['header'],
    resource: SEARCH_RESOURCE,
    resource_name: 'Firecrawl Search',
    scopes_supported: ['firecrawl:global'],
  });

  const names = await listTools(port, SEARCH_ENDPOINT, {
    authorization: 'Bearer fco_primary_search_resource_token',
  });
  assert.deepEqual([...names].sort(), [...SEARCH_TOOLS].sort());
});

test('primary search readiness requires the exact canonical resource origin', async (t) => {
  const { port } = await startPrimarySearchServer(t, {
    FIRECRAWL_MCP_SEARCH_RESOURCE_URL: `https://example.invalid${SEARCH_ENDPOINT}`,
  });

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    ok: false,
    missing: ['FIRECRAWL_MCP_SEARCH_RESOURCE_URL (endpoint mismatch)'],
  });
});

test('primary search profile uses the strict marketplace search tool, not the full search variant', async (t) => {
  const { port } = await startPrimarySearchServer(t);
  const headers = { authorization: 'Bearer fco_primary_strict_search' };
  const tools = await listToolDefinitions(port, SEARCH_ENDPOINT, headers);
  const search = tools.find((tool) => tool.name === 'firecrawl_search');
  assert.ok(search, 'primary profile must register firecrawl_search');
  assert.doesNotMatch(JSON.stringify(search.inputSchema), /scrapeOptions/);
  assert.doesNotMatch(search.description ?? '', /search_feedback|refund/i);
  assert.equal(search.inputSchema.properties.limit.type, 'integer');
  assert.equal(search.inputSchema.properties.limit.minimum, 1);
  assert.equal(search.inputSchema.properties.limit.maximum, 100);

  const response = await jsonRpc(port, SEARCH_ENDPOINT, {
    id: 13,
    method: 'tools/call',
    params: {
      arguments: {
        query: 'strict marketplace search',
        scrapeOptions: { formats: ['markdown'] },
      },
      name: 'firecrawl_search',
    },
    headers,
  });
  assert.equal(response.status, 200);
  const message = parseSseJson(await response.text());
  assert.equal(
    Boolean(message.error) || message.result?.isError === true,
    true,
    JSON.stringify(message)
  );
});

test('primary search profile agent language satisfies metadata policy gates', async (t) => {
  const { port } = await startPrimarySearchServer(t);
  const headers = { authorization: 'Bearer fco_primary_search_metadata' };
  const initialize = await initializeProfile(port, SEARCH_ENDPOINT, headers);
  const tools = await listToolDefinitions(port, SEARCH_ENDPOINT, headers);

  assertAgentMetadataPolicy(
    [initialize.instructions, ...tools.map((tool) => tool.description ?? '')],
    assert
  );
});

test('keyless full-surface instructions satisfy the same metadata policy gates', async (t) => {
  // FASTMCP_ENDPOINT '/v2/mcp' (not '/v2/mcp-oauth') makes this the keyless
  // profile, whose instructions must stay descriptive rather than becoming an
  // imperative routing playbook.
  const { fullPort } = await startHostedServer(t);
  const headers = { 'x-api-key': 'fc-keyless-metadata' };
  const initialize = await initializeProfile(fullPort, '/v2/mcp', headers);
  const tools = await listToolDefinitions(fullPort, '/v2/mcp', headers);

  assertAgentMetadataPolicy(
    [initialize.instructions, ...tools.map((tool) => tool.description ?? '')],
    assert
  );
});

test('account (mcp-oauth) full-surface instructions satisfy the same metadata policy gates', async (t) => {
  const accountResource = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const backend = await startFakeBackend({ introspectionAud: accountResource });
  t.after(() => backend.close());
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp-oauth',
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_RESOURCE_URL: accountResource,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const headers = { authorization: 'Bearer fco_account_metadata' };
  const initialize = await initializeProfile(port, '/v2/mcp-oauth', headers);
  const tools = await listToolDefinitions(port, '/v2/mcp-oauth', headers);

  assertAgentMetadataPolicy(
    [initialize.instructions, ...tools.map((tool) => tool.description ?? '')],
    assert
  );
});

test('primary search profile fails closed unless the canonical OAuth-only flag is enabled', async (t) => {
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: SEARCH_ENDPOINT,
    FIRECRAWL_API_URL: 'http://127.0.0.1:9',
    FIRECRAWL_MCP_SEARCH_RESOURCE_URL: SEARCH_RESOURCE,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2_000).then(() => assert.fail('primary search profile unexpectedly started')),
  ]);
  assert.notEqual(child.exitCode, 0);
  assert.match(stderr, /FIRECRAWL_MCP_SEARCH_OAUTH_ONLY=true/);
});

test('primary search profile rejects legacy /v2/mcp audience and requires the delegated signing secret', async (t) => {
  const legacyBackend = await startFakeBackend({
    introspectionAud: 'https://mcp.firecrawl.dev/v2/mcp',
  });
  t.after(() => legacyBackend.close());
  const { port } = await startPrimarySearchServer(t, {
    FIRECRAWL_API_URL: legacyBackend.url,
    FIRECRAWL_OAUTH_ISSUER: legacyBackend.url,
  });

  const wrongAudience = await jsonRpc(port, SEARCH_ENDPOINT, {
    id: 11,
    method: 'tools/list',
    headers: { authorization: 'Bearer fco_legacy_audience' },
  });
  assert.equal(wrongAudience.status, 401);

  // A separate process proves readiness is profile-specific: search needs the
  // fcmcp_ signer but intentionally does not require KEYLESS_PROXY_SECRET.
  const unavailablePort = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: SEARCH_ENDPOINT,
    FIRECRAWL_API_URL: legacyBackend.url,
    FIRECRAWL_MCP_SEARCH_RESOURCE_URL: SEARCH_RESOURCE,
    FIRECRAWL_MCP_SEARCH_OAUTH_ONLY: 'true',
    FIRECRAWL_OAUTH_ISSUER: legacyBackend.url,
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    MCP_DELEGATED_CREDENTIAL_SECRET: '',
    PORT: String(unavailablePort),
  });
  t.after(() => stopChild(child));
  await waitForHealth(unavailablePort, child);
  const ready = await fetch(`http://127.0.0.1:${unavailablePort}/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    missing: ['MCP_DELEGATED_CREDENTIAL_SECRET'],
    ok: false,
  });
});

test('companion stays API-key compatible by default and only becomes OAuth-only behind its explicit flag', async (t) => {
  const backend = await startFakeBackend({ introspectionAud: SEARCH_RESOURCE });
  t.after(() => backend.close());
  const { searchPort } = await startHostedServer(t, {
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    FIRECRAWL_MCP_SEARCH_OAUTH_ONLY: 'true',
  });

  const apiKey = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 12,
    method: 'tools/list',
    headers: { authorization: 'Bearer fc-companion-api-key' },
  });
  assert.equal(apiKey.status, 401);

  const names = await listTools(searchPort, SEARCH_ENDPOINT, {
    authorization: 'Bearer fco_companion_search_resource_token',
  });
  assert.deepEqual([...names].sort(), [...SEARCH_TOOLS].sort());
});

test('companion emits sanitized auth-mode telemetry without credential material', async (t) => {
  const { searchPort, getStdout } = await startHostedServer(t);
  await listTools(searchPort, SEARCH_ENDPOINT, {
    authorization: 'Bearer fc-telemetry-must-not-appear',
  });
  await delay(25);
  const logs = getStdout();
  const eventLine = logs
    .split(/\r?\n/)
    .find((line) => line.startsWith('[MCP_SEARCH_AUTH] '));
  assert.ok(eventLine, logs);
  const event = JSON.parse(eventLine.slice('[MCP_SEARCH_AUTH] '.length));
  assert.deepEqual(event, {
    auth_mode: 'api-key',
    outcome: 'accepted',
    profile: 'companion',
    event_id: event.event_id,
    route: SEARCH_ENDPOINT,
  });
  assert.match(
    event.event_id,
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  );
  assert.doesNotMatch(logs, /fc-telemetry-must-not-appear/);
  assert.doesNotMatch(logs, /authorization/i);
});

test('companion telemetry follows credential precedence without resolving API keys', async (t) => {
  const { searchPort, getStdout } = await startHostedServer(t);

  await listTools(searchPort, SEARCH_ENDPOINT, {
    authorization: 'Bearer fco_secondary-credential',
    'x-api-key': 'fc-primary-credential',
  });
  const unresolved = await jsonRpc(searchPort, SEARCH_ENDPOINT, {
    id: 12,
    method: 'tools/list',
    headers: { authorization: 'Bearer fc-invalid-credential' },
  });
  assert.equal(unresolved.status, 200);
  await delay(25);

  const events = getStdout()
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[MCP_SEARCH_AUTH] '))
    .map((line) => JSON.parse(line.slice('[MCP_SEARCH_AUTH] '.length)));
  assert.deepEqual(
    events.map(({ auth_mode, outcome }) => ({ auth_mode, outcome })),
    [
      { auth_mode: 'api-key', outcome: 'accepted' },
      { auth_mode: 'api-key', outcome: 'accepted' },
    ]
  );
  assert.doesNotMatch(getStdout(), /fc-primary-credential|fco_secondary-credential/);
});
