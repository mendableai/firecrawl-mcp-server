import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// The frozen agent-visible contract of firecrawl_developer_search.
//
// An agent reaches the developer index through this one tool, and it picks the
// tool and fills its arguments from nothing but the text and the JSON Schema
// below. The HTTP endpoint carries eleven further filters (HTTP_ONLY_FILTERS);
// they are deliberately absent here, so the argument list an agent has to
// reason about on every call stays at query/k/skills.
//
// The constants are duplicated from src/developer.ts on purpose. A change to
// the wire contract then has to be typed out twice and reviewed as its own
// edit, instead of riding along with an unrelated change to the module.
//
// Property-level `.describe()` text is NOT part of the contract: no property
// description survives serialization into tools/list (same constraint noted in
// tests/mcp-smoke.test.mjs), so TOOL_DESCRIPTION is the only prose an agent
// ever reads about this tool.
const DEVELOPER_TOOL = 'firecrawl_developer_search';

const TOOL_DESCRIPTION = `
For a developer question — code behaviour, a library or framework, an API contract, an error message, or a known bug — search an index built for coding agents. The index covers GitHub issues, merged pull requests, repository READMEs, and curated documentation sites. Set skills to "only" to limit the search to agent-skill files.

Returns ranked results with an ID, source type, URL, title, and the matched passages in markdown.
`;

const TOOL_PROPERTIES = {
  k: { maximum: 100, minimum: 1, type: 'integer' },
  query: { minLength: 1, type: 'string' },
  skills: { enum: ['only'], type: 'string' },
};

const REQUIRED_ARGUMENTS = ['query'];

// Documented on GET/POST /v2/search/developer and intentionally not exposed as
// tool arguments. Listed by name so that adding one to the tool fails here
// rather than silently widening the surface.
const HTTP_ONLY_FILTERS = [
  'archived',
  'fork',
  'language',
  'license',
  'max_stars',
  'min_stars',
  'passages',
  'repos',
  'sources',
  'topic',
  'types',
];

// Applied by this server only while the search backend does not report a
// budget of its own. Kept in sync with LEGACY_MAX_PASSAGE_CHARS in
// src/developer.ts: it bounds how much text one result can put into an agent's
// context, which is as much a part of the tool's behaviour as its arguments.
const LEGACY_MAX_PASSAGE_CHARS = 1200;

const FULL_ENDPOINT = '/v2/mcp';

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

// Fake origin for GET /v2/search/developer. Records every request so a test can
// assert on the outbound query string, and echoes back one result whose passage
// length and budget reporting the caller controls.
async function startFakeDeveloperApi(options = {}) {
  const { passageText = 'matched passage', passageBudgetApplied } = options;
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    requests.push({
      headers: req.headers,
      method: req.method,
      pathname: url.pathname,
      searchParams: [...url.searchParams.entries()],
    });

    // The hosted profile introspects the caller's credential before it will
    // serve tools/list, so the fake origin stands in for the issuer too.
    if (req.method === 'POST' && url.pathname === '/api/oauth/introspect') {
      const token = new URLSearchParams(raw).get('token') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          token.startsWith('fc-')
            ? {
                active: true,
                api_key: token,
                credential_purpose: 'general',
                scope: 'firecrawl:global',
              }
            : { active: false }
        )
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v2/search/developer') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              id: 'issue:owner/repo#1',
              passages: [{ text: passageText }],
              title: 'Retry loop never backs off',
              url: 'https://github.com/owner/repo/issues/1',
            },
          ],
          ...(passageBudgetApplied == null
            ? {}
            : { passage_budget_applied: passageBudgetApplied }),
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
      const error = new Error(
        `MCP server exited: code=${code} signal=${signal}`
      );
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
        if (message.error)
          pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

async function connectStdio(t, env) {
  const child = spawnServer({ FIRECRAWL_API_KEY: 'fc-test', ...env });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-developer-contract', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  client.notify('notifications/initialized');
  return { client, getStderr: () => stderr };
}

function assertDeveloperToolContract(tool) {
  assert.ok(tool, `${DEVELOPER_TOOL} is missing from tools/list`);
  assert.equal(tool.description, TOOL_DESCRIPTION);

  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  assert.deepEqual(
    Object.keys(properties).sort(),
    Object.keys(TOOL_PROPERTIES).sort()
  );
  for (const [name, shape] of Object.entries(TOOL_PROPERTIES)) {
    assert.deepEqual(properties[name], shape, `argument ${name} drifted`);
  }
  assert.deepEqual(schema.required, REQUIRED_ARGUMENTS);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.type, 'object');

  for (const filter of HTTP_ONLY_FILTERS) {
    assert.equal(
      filter in properties,
      false,
      `${filter} is an HTTP-only filter and must not become a tool argument`
    );
  }
}

test('stdio tools/list serves the frozen developer search contract', async (t) => {
  const { client, getStderr } = await connectStdio(t);

  const { tools } = await client.request('tools/list');
  const tool = tools.find((entry) => entry.name === DEVELOPER_TOOL);
  assertDeveloperToolContract(tool);
  assert.equal(getStderr().includes('TypeError'), false, getStderr());
});

test('hosted full surface serves the same developer search contract', async (t) => {
  const backend = await startFakeDeveloperApi();
  t.after(() => backend.close());
  const port = await getFreePort();
  const searchPort = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    FASTMCP_ENDPOINT: FULL_ENDPOINT,
    FIRECRAWL_API_URL: backend.url,
    FIRECRAWL_MCP_SEARCH_PORT: String(searchPort),
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    FIRECRAWL_OAUTH_ISSUER: backend.url,
    HTTP_STREAMABLE_SERVER: 'true',
    KEYLESS_PROXY_SECRET: 'delegation-secret',
    PORT: String(port),
  });
  t.after(() => stopChild(child));
  await waitForHealth(port, child);

  const res = await fetch(`http://127.0.0.1:${port}${FULL_ENDPOINT}`, {
    body: JSON.stringify({
      id: 1,
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
  assert.equal(res.status, 200);
  const message = parseSseJson(await res.text());
  const tool = message.result.tools.find(
    (entry) => entry.name === DEVELOPER_TOOL
  );

  // The hosted wrapper adds credential handling around every tool. It must not
  // reword the description or widen the schema the agent reads.
  assertDeveloperToolContract(tool);
});

test('developer search forwards only its declared arguments', async (t) => {
  const backend = await startFakeDeveloperApi();
  t.after(() => backend.close());
  const { client } = await connectStdio(t, { FIRECRAWL_API_URL: backend.url });

  const result = await client.request('tools/call', {
    arguments: {
      k: 10,
      query: 'how do I configure retries',
      skills: 'only',
      // Real filters on the HTTP endpoint, and not tool arguments. A caller
      // that sends one anyway must not reach the search server with it.
      min_stars: 500,
      types: ['issue'],
    },
    name: DEVELOPER_TOOL,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));

  assert.equal(backend.requests.length, 1);
  const [request] = backend.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.pathname, '/v2/search/developer');
  assert.equal(request.headers.authorization, 'Bearer fc-test');
  assert.deepEqual(request.searchParams, [
    ['query', 'how do I configure retries'],
    ['k', '10'],
    ['skills', 'only'],
  ]);

  // Results are markdown blocks, not the HTTP JSON envelope. Agents parse URLs
  // and titles out of this text; switching the payload to raw JSON is a
  // contract change.
  assert.equal(result.content[0].type, 'text');
  assert.equal(
    result.content[0].text,
    [
      '## [issue:owner/repo#1] (issue) Retry loop never backs off',
      'https://github.com/owner/repo/issues/1',
      'matched passage',
    ].join('\n')
  );
});

test('developer search omits absent optional arguments', async (t) => {
  const backend = await startFakeDeveloperApi();
  t.after(() => backend.close());
  const { client } = await connectStdio(t, { FIRECRAWL_API_URL: backend.url });

  const result = await client.request('tools/call', {
    arguments: { query: 'how do I configure retries' },
    name: DEVELOPER_TOOL,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));

  // k and skills are unset rather than defaulted here, so the search server
  // applies its own default depth.
  assert.deepEqual(backend.requests[0].searchParams, [
    ['query', 'how do I configure retries'],
  ]);
});

test('developer passages keep the legacy cap until the server reports a budget', async (t) => {
  const passageText = 'x'.repeat(LEGACY_MAX_PASSAGE_CHARS * 2);
  const backend = await startFakeDeveloperApi({ passageText });
  t.after(() => backend.close());
  const { client } = await connectStdio(t, { FIRECRAWL_API_URL: backend.url });

  const result = await client.request('tools/call', {
    arguments: { query: 'retry backoff' },
    name: DEVELOPER_TOOL,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));

  const [, , renderedPassage] = result.content[0].text.split('\n');
  assert.equal(renderedPassage.length, LEGACY_MAX_PASSAGE_CHARS);
});

test('developer passages pass through once the server reports a budget', async (t) => {
  const passageText = 'x'.repeat(LEGACY_MAX_PASSAGE_CHARS * 2);
  const backend = await startFakeDeveloperApi({
    passageBudgetApplied: passageText.length,
    passageText,
  });
  t.after(() => backend.close());
  const { client } = await connectStdio(t, { FIRECRAWL_API_URL: backend.url });

  const result = await client.request('tools/call', {
    arguments: { query: 'retry backoff' },
    name: DEVELOPER_TOOL,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));

  const [, , renderedPassage] = result.content[0].text.split('\n');
  assert.equal(renderedPassage.length, passageText.length);
});
