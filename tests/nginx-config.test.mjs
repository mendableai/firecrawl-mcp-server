import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = await readFile(
  new URL('../docker/nginx.conf', import.meta.url),
  'utf8'
);

function locationBody(pattern) {
  const start = config.indexOf(pattern);
  assert.notEqual(start, -1, `missing nginx location: ${pattern}`);
  const open = config.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < config.length; index += 1) {
    if (config[index] === '{') depth += 1;
    if (config[index] === '}') depth -= 1;
    if (depth === 0) return config.slice(open + 1, index);
  }
  assert.fail(`unterminated nginx location: ${pattern}`);
}

test('key-bearing routes disable access logs before forwarding credentials', () => {
  for (const route of [
    'location ~ ^/(?<apikey>[^/]+)/(?:v2/mcp|mcp)/?$',
    'location ~ ^/(?<apikey>[^/]+)/v(?:1|2)/(.*)$',
    'location ~ ^/(?<apikey>[^/]+)/(.*)$',
  ]) {
    const body = locationBody(route);
    assert.match(body, /access_log off;/);
    assert.match(body, /proxy_set_header X-Firecrawl-API-Key \$apikey;/);
  }
});

test('legacy key-in-path search returns a terminal migration response', () => {
  const route = 'location ~ ^/(?<apikey>[^/]+)/v2/mcp-search(?:/|$)';
  const start = config.indexOf(route);
  assert.notEqual(start, -1, `missing nginx location: ${route}`);
  const nextLocation = config.indexOf('\n    location ', start + route.length);
  const body = config.slice(start, nextLocation === -1 ? config.length : nextLocation);

  assert.match(body, /access_log off;/);
  assert.match(body, /default_type application\/json;/);
  assert.match(body, /return 410/);
  assert.match(body, /"migration_url":"https:\/\/docs\.firecrawl\.dev\/mcp-server"/);
  assert.doesNotMatch(body, /proxy_pass|X-Firecrawl-API-Key/);
});

test('specific MCP identities precede generic legacy regex routes', () => {
  const genericVersioned = config.indexOf(
    'location ~ ^/v(?:1|2)/(.*)$'
  );
  const genericKeyed = config.indexOf(
    'location ~ ^/(?<apikey>[^/]+)/v(?:1|2)/(.*)$'
  );
  for (const route of [
    'location ~ ^/v2/mcp-oauth/?$',
    'location ~ ^/v2/mcp/?$',
    'location ~ ^/v2/mcp-search(?:/|$)',
  ]) {
    assert.ok(config.indexOf(route) < genericVersioned, `${route} ordering`);
  }
  for (const route of [
    'location ~ ^/(?<apikey>[^/]+)/v2/mcp-search(?:/|$)',
    'location ~ ^/(?<apikey>[^/]+)/(?:v2/mcp|mcp)/?$',
  ]) {
    assert.ok(config.indexOf(route) < genericKeyed, `${route} ordering`);
  }
});

test('legacy MCP aliases stay bound to the full identity', () => {
  for (const route of [
    'location = /mcp',
    'location ~ ^/(?<apikey>[^/]+)/(?:v2/mcp|mcp)/?$',
  ]) {
    const body = locationBody(route);
    assert.match(body, /rewrite \^ \/v2\/mcp break;/);
    assert.doesNotMatch(body, /mcp-oauth/);
  }
});

test('only the legacy full-MCP route can mark a request as credential-in-path', () => {
  for (const route of [
    'location ~ ^/v2/mcp-oauth/?$',
    'location ~ ^/v2/mcp/?$',
    'location = /mcp',
    'location ~ ^/v2/mcp-search(?:/|$)',
    'location /mcp',
    'location /messages',
    'location /sse',
  ]) {
    assert.match(
      locationBody(route),
      /proxy_set_header X-Firecrawl-Key-Transport "";/,
      `${route} must clear a client-supplied legacy-path marker`
    );
  }
  assert.match(
    locationBody('location ~ ^/(?<apikey>[^/]+)/(?:v2/mcp|mcp)/?$'),
    /proxy_set_header X-Firecrawl-Key-Transport path;/
  );
});

test('search routes are rendered to a fixed upstream and readiness reaches Node', async () => {
  assert.match(config, /proxy_pass http:\/\/__MCP_SEARCH_UPSTREAM__;/);
  const entrypoint = await readFile(
    new URL('../docker/entrypoint.sh', import.meta.url),
    'utf8'
  );
  assert.match(entrypoint, /FASTMCP_ENDPOINT:-\/v2\/mcp/);
  assert.match(entrypoint, /\[ "\$\{FASTMCP_ENDPOINT:-\/v2\/mcp\}" = "\/v2\/mcp-search" \]/);
  assert.match(entrypoint, /SEARCH_UPSTREAM=app_search/);
  assert.match(entrypoint, /SEARCH_UPSTREAM=app/);
  assert.match(entrypoint, /s\/__MCP_SEARCH_UPSTREAM__\/\$\{SEARCH_UPSTREAM\}\/g/);

  const ready = locationBody('location = /ready');
  assert.match(ready, /proxy_pass http:\/\/app\/ready;/);
});

test('nginx preserves only the trusted edge forwarding chain', () => {
  const forwardedForDirectives = [
    ...config.matchAll(/proxy_set_header X-Forwarded-For ([^;]+);/g),
  ];
  assert.ok(forwardedForDirectives.length > 0);
  for (const [, value] of forwardedForDirectives) {
    assert.equal(value, '$http_x_forwarded_for');
  }
  assert.doesNotMatch(config, /X-Forwarded-For \$remote_addr/);
  assert.doesNotMatch(config, /\$proxy_add_x_forwarded_for/);
});
