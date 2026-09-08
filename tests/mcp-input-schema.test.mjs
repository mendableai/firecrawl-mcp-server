import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

function isUnsatisfiableFreeFormObject(schema) {
  return (
    schema?.type === 'object' &&
    schema?.additionalProperties === false &&
    !schema?.properties &&
    schema?.propertyNames?.type === 'string'
  );
}

async function listToolsViaStdio() {
  const child = spawn('node', ['dist/index.js'], {
    env: { ...process.env, FIRECRAWL_API_KEY: 'fc-test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'schema-probe', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];

  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  await delay(2500);
  child.kill();

  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const payload = JSON.parse(line);
      if (payload.id === 2) {
        return payload.result.tools;
      }
    } catch {
      // ignore non-json lines
    }
  }

  throw new Error('tools/list response not found');
}

test('published scrape jsonOptions.schema accepts real JSON Schema objects', async () => {
  const tools = await listToolsViaStdio();
  const scrape = tools.find((tool) => tool.name === 'firecrawl_scrape');
  assert.ok(scrape, 'firecrawl_scrape missing from tools/list');

  const schemaField = scrape.inputSchema.properties.jsonOptions.properties.schema;
  assert.equal(isUnsatisfiableFreeFormObject(schemaField), false);
  assert.ok(
    schemaField.allOf?.[0]?.$ref ||
      schemaField.additionalProperties !== false,
    'schema field should admit arbitrary JSON Schema keys'
  );

  const agent = tools.find((tool) => tool.name === 'firecrawl_agent');
  assert.ok(agent, 'firecrawl_agent missing from tools/list');
  const agentSchemaField = agent.inputSchema.properties.schema;
  assert.equal(isUnsatisfiableFreeFormObject(agentSchemaField), false);
});
