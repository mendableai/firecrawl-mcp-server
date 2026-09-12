#!/usr/bin/env node
import FirecrawlApp from '@mendable/firecrawl-js';
import dotenv from 'dotenv';
import { FastMCP, type Logger, UserError } from 'fastmcp';
import type { IncomingHttpHeaders } from 'http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  searchSourceSchema,
  findToolsSchema,
  hasAlexandria,
  normalizeSearchSources,
  searchQueryIsValid,
  ALEXANDRIA_INSTRUCTIONS,
} from './alexandria';
import { loadCliCredentials } from './cli-credentials';
import { registerDeveloperTools } from './developer';
import { extractSingleTrustedClientIp } from './keyless-client-ip';
import { registerMonitorTools } from './monitor';
import { registerResearchTools } from './research';
import { escapeWWWAuthenticateValue } from './www-authenticate';
import {
  credentialForOutboundRequest,
  copyManagedOAuthApiKey,
  CoreHttpError,
  credentialValidationUnavailable,
  CredentialValidationUnavailableError,
  hasCredential,
  hasManagedOAuthCredential,
  requireDelegatedCredentialSigning,
  setManagedOAuthApiKey,
  type CredentialSession,
} from './session-credential';

dotenv.config({ debug: false, quiet: true });
loadCliCredentials();

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../package.json') as {
  version: string;
};

interface SessionData extends CredentialSession {
  /**
   * FC API key (`fc-...`) or OAuth access token (`fco_...`) sent as
   * `Authorization: Bearer ...` to the Firecrawl API.
   */
  firecrawlApiKey?: string;
  /**
   * For keyless requests over the hosted (CLOUD_SERVICE) MCP, the end-user's
   * real client IP, forwarded to the API so it can rate-limit per real IP
   * instead of the shared server IP.
   */
  keylessClientIp?: string;
  authType?: 'api-key' | 'oauth' | 'env' | 'keyless' | 'none';
  credentialError?: 'CREDENTIAL_INVALID';
  /** Internal nginx marker for the deprecated credential-in-path route. */
  keyTransport?: 'path';
  teamId?: string;
  userId?: string;
  apiKeyId?: string;
  oauthClientId?: string;
  resource?: string;
  requestId?: string;
  [key: string]: unknown;
}

type ToolLogger = Pick<Logger, 'debug' | 'error' | 'info' | 'warn'>;

/**
 * A server profile parameterizes how a FastMCP instance is constructed. Hosted
 * deployments run one primary identity (`full` or `account`) per process. The
 * existing search profile remains an in-process companion of `full` until its
 * deployment is migrated separately.
 */
type ServerProfile = {
  id: 'full' | 'account' | 'search';
  /** OAuth protected-resource display name. */
  resourceName: string;
  /** Server-level instructions surfaced to clients. */
  instructions: string;
  /** OAuth protected-resource identifier for this surface. */
  resourceUrl: string;
  /** httpStream endpoint override (defaults to fastmcp's own default). */
  endpoint?: `/${string}`;
  /** TCP port this instance listens on. */
  port: number;
  /** When set, only these tool names may register on this instance. */
  toolAllowlist?: Set<string>;
  /** Allow the keyless free-tier fallback (no credential required). */
  allowKeyless: boolean;
  /** Whether ordinary Firecrawl API keys are accepted for this identity. */
  acceptApiKeys: boolean;
  /** Require a managed hosted-MCP OAuth grant, never a legacy/general token. */
  requireManagedOAuth?: boolean;
  /** Whether this process's primary listener owns this profile. */
  primary?: boolean;
  /** Accept tokens minted for the legacy /v2/mcp resource during migration. */
  acceptLegacyAudience?: boolean;
  /** Publish OAuth discovery metadata for clients configuring this surface. */
  advertiseOAuth: boolean;
};

/** Registers a tool onto an instance; a subset of the FastMCP surface. */
type ToolRegistrar = Pick<FastMCP<SessionData>, 'addTool'>;

const authResultByRequest = Symbol('firecrawlMcpAuthResult');

type MCPAuthRequest = {
  headers: IncomingHttpHeaders;
  url?: string;
  [authResultByRequest]?: Promise<SessionData>;
};

function normalizeHeader(
  value: string | string[] | undefined
): string | undefined {
  if (value == null) return undefined;
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof v === 'string' ? v.trim() : '';
  return trimmed || undefined;
}

function extractBearerToken(headers: IncomingHttpHeaders): string | undefined {
  const headerAuth = normalizeHeader(headers['authorization']);
  if (!headerAuth?.toLowerCase().startsWith('bearer ')) return undefined;
  const raw = headerAuth.slice(7).trim();
  return raw || undefined;
}

/** OAuth access tokens minted by Firecrawl (Authorization Server). */
function isFirecrawlOAuthAccessToken(token: string): boolean {
  return token.startsWith('fco_');
}

function isFirecrawlApiKey(token: string): boolean {
  return token.startsWith('fc-');
}

function isLegacyKeyPathRequest(request: MCPAuthRequest | undefined): boolean {
  return (
    normalizeHeader(request?.headers?.['x-firecrawl-key-transport']) === 'path'
  );
}

function requestShouldReceiveOAuthChallenge(
  request: MCPAuthRequest | undefined,
  profile: ServerProfile
): boolean {
  // OAuth-only profiles must challenge API-key and key-in-path attempts too;
  // otherwise FastMCP would return a generic error instead of the resource's
  // reconnectable OAuth challenge.
  if (!profile.acceptApiKeys) return true;
  if (!request?.headers) return true;
  const headerApiKey = normalizeHeader(
    request.headers['x-firecrawl-api-key'] ?? request.headers['x-api-key']
  );
  if (headerApiKey) return false;
  const bearer = extractBearerToken(request.headers);
  return !bearer || isFirecrawlOAuthAccessToken(bearer);
}

function resolveCredentialFromEnv(): string | undefined {
  return (
    normalizeHeader(process.env.FIRECRAWL_OAUTH_TOKEN) ??
    normalizeHeader(process.env.FIRECRAWL_API_KEY)
  );
}

function isHttpStreamingTransport(): boolean {
  return (
    process.env.HTTP_STREAMABLE_SERVER === 'true' ||
    process.env.SSE_LOCAL === 'true'
  );
}

const DEFAULT_OAUTH_ISSUER = 'https://www.firecrawl.dev';
const DEFAULT_MCP_RESOURCE_URL = 'https://mcp.firecrawl.dev/v2/mcp';
const DEFAULT_MCP_OAUTH_RESOURCE_URL = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
const DEFAULT_MCP_SEARCH_RESOURCE_URL = 'https://mcp.firecrawl.dev/v2/mcp-search';
const DEFAULT_MCP_SEARCH_ENDPOINT = '/v2/mcp-search';

// Human-facing guidance values, co-located with the resource defaults above.
// MCP_CONNECTION_GUIDE_URL stays a stable, neutral entry point even while the
// docs routing evolves; do not bind recovery payloads to an auth-mode leaf
// page. It is a human-facing guide, not an MCP endpoint.
const MCP_CONNECTION_GUIDE_URL =
  'https://docs.firecrawl.dev/mcp-server';

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getOAuthIssuer(): string {
  return withoutTrailingSlash(
    normalizeHeader(process.env.FIRECRAWL_OAUTH_ISSUER) ?? DEFAULT_OAUTH_ISSUER
  );
}

function getMcpResourceUrl(): string {
  return (
    normalizeHeader(process.env.FIRECRAWL_MCP_RESOURCE_URL) ??
    DEFAULT_MCP_RESOURCE_URL
  );
}

function getPrimaryEndpoint(): '/v2/mcp' | '/v2/mcp-oauth' | '/v2/mcp-search' {
  const endpoint = normalizeHeader(process.env.FASTMCP_ENDPOINT) ?? '/v2/mcp';
  if (
    endpoint === '/v2/mcp' ||
    endpoint === '/v2/mcp-oauth' ||
    endpoint === '/v2/mcp-search'
  ) {
    return endpoint;
  }
  throw new Error(
    `Unsupported FASTMCP_ENDPOINT: ${endpoint}. Expected /v2/mcp, /v2/mcp-oauth, or /v2/mcp-search.`
  );
}

function getSearchMcpResourceUrl(): string {
  return (
    normalizeHeader(process.env.FIRECRAWL_MCP_SEARCH_RESOURCE_URL) ??
    DEFAULT_MCP_SEARCH_RESOURCE_URL
  );
}

function getSearchMcpEndpoint(): `/${string}` {
  const configured = normalizeHeader(process.env.FIRECRAWL_MCP_SEARCH_ENDPOINT);
  if (configured && configured.startsWith('/')) {
    return configured as `/${string}`;
  }
  return DEFAULT_MCP_SEARCH_ENDPOINT;
}

// PRM location per RFC 9728. firecrawl-fastmcp serves the document both at the
// origin-level path and at `/.well-known/oauth-protected-resource${endpoint}`.
// The full surface uses the origin-level document (unchanged); a path-scoped
// surface advertises the document that sits under its own resource path, so a
// single host can carry more than one protected resource.
function getOAuthProtectedResourceMetadataUrl(profile: ServerProfile): string {
  const resource = new URL(profile.resourceUrl);
  const base = `${resource.origin}/.well-known/oauth-protected-resource`;
  return profile.id === 'full' ? base : `${base}${resource.pathname}`;
}

function createOAuthChallengeResponse(
  error: unknown,
  profile: ServerProfile,
  details: Record<string, unknown> = {}
): Response | undefined {
  if (!isMcpOAuthEnabled()) {
    return undefined;
  }

  const errorMessage =
    error instanceof Error ? error.message : String(error || 'Unauthorized');
  // WWW-Authenticate is one header. Flatten CR/LF so a multiline JSON
  // message cannot split the header value.
  const wwwAuthenticateDescription = errorMessage.replace(/[\r\n]+/g, ' ').trim();
  const wwwAuthenticate = [
    ...(profile.advertiseOAuth
      ? [
          `resource_metadata="${escapeWWWAuthenticateValue(getOAuthProtectedResourceMetadataUrl(profile))}"`,
        ]
      : []),
    'error="invalid_token"',
    `error_description="${escapeWWWAuthenticateValue(wwwAuthenticateDescription)}"`,
  ].join(', ');

  return new Response(
    JSON.stringify({
      error: 'invalid_token',
      error_description: errorMessage,
      ...details,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer ${wwwAuthenticate}`,
      },
      status: 401,
    }
  );
}

function createInvalidCredentialResponse(_error: InvalidFirecrawlCredentialError): Response {
  const recovery = invalidApiKeyRecoveryPayload();
  return new Response(
    JSON.stringify({
      error: 'invalid_api_key',
      error_description: recovery.message,
      ...recovery,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      status: 401,
    }
  );
}

function createInvalidOAuthRecoveryResponse(
  recovery: Record<string, unknown> & { message: string }
): Response {
  return new Response(
    JSON.stringify({
      error: 'invalid_token',
      error_description: recovery.message,
      ...recovery,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      status: 401,
    }
  );
}

/**
 * Seconds advertised to the client after a failed credential check. Short
 * enough that a working session recovers on the next attempt, long enough that
 * a client retrying immediately does not amplify an upstream outage.
 */
const CREDENTIAL_VALIDATION_RETRY_AFTER_SECONDS = 5;

/**
 * A failed credential check is a temporary server-side condition, not a verdict
 * on the client's credential, so this stays a 503 (RFC 9110 15.6.4) and carries
 * `Retry-After` to name a concrete wait. Two things are deliberately absent:
 * `WWW-Authenticate`, which would push a still-valid session into a needless
 * reauthorization, and an OAuth `error` code, which RFC 6749 reserves for 400
 * and 401 responses and which clients surface as an authentication verdict. The
 * body is the sentence alone; the reason for the failure goes to the server log.
 */
function createCredentialValidationUnavailableResponse(
  error: CredentialValidationUnavailableError
): Response {
  return new Response(error.message, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(CREDENTIAL_VALIDATION_RETRY_AFTER_SECONDS),
    },
    status: 503,
  });
}

function getOAuthIntrospectionEndpoint(): string {
  return `${getOAuthIssuer()}/api/oauth/introspect`;
}

function getOAuthIntrospectionSecret(): string | undefined {
  return normalizeHeader(process.env.FIRECRAWL_OAUTH_INTROSPECT_SECRET);
}

function isMcpOAuthEnabled(): boolean {
  return process.env.CLOUD_SERVICE === 'true';
}

type OAuthCredentialPurpose = 'general' | 'hosted_mcp_oauth';

function isOAuthCredentialPurpose(value: unknown): value is OAuthCredentialPurpose {
  return value === 'general' || value === 'hosted_mcp_oauth';
}

type OAuthIntrospectionResponse = {
  active?: boolean;
  api_key?: string;
  aud?: string | string[];
  credential_purpose?: OAuthCredentialPurpose;
  scope?: string | string[];
  team_id?: string;
  sub?: string;
  api_key_id?: string;
  client_id?: string;
};

type CredentialMetadata = Pick<
  SessionData,
  'teamId' | 'userId' | 'apiKeyId' | 'oauthClientId' | 'resource'
>;

type ResolvedCredential = {
  credential?: string;
  managedOAuthApiKey?: string;
  invalid?: boolean;
  source?: 'api-key' | 'oauth' | 'env';
  metadata?: CredentialMetadata;
};

class InvalidFirecrawlCredentialError extends Error {
  constructor() {
    super('The supplied Firecrawl credential is invalid or revoked. Replace it and retry.');
    this.name = 'InvalidFirecrawlCredentialError';
  }
}

class InvalidOAuthCredentialError extends Error {
  constructor() {
    super('Invalid OAuth access token');
    this.name = 'InvalidOAuthCredentialError';
  }
}

const MCP_GLOBAL_SCOPE = 'firecrawl:global';

function values(value: string | string[] | undefined): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value)
    ? value.flatMap((item) => item.split(/\s+/).filter(Boolean))
    : [];
}

function audienceMatchesResource(
  aud: string | string[] | undefined,
  resourceUrl: string
): boolean {
  const target = withoutTrailingSlash(resourceUrl);
  return values(aud).some((entry) => withoutTrailingSlash(entry) === target);
}

function credentialMetadata(data: OAuthIntrospectionResponse): CredentialMetadata {
  return {
    teamId: typeof data.team_id === 'string' ? data.team_id : undefined,
    userId: typeof data.sub === 'string' ? data.sub : undefined,
    apiKeyId: typeof data.api_key_id === 'string' ? data.api_key_id : undefined,
    oauthClientId:
      typeof data.client_id === 'string' ? data.client_id : undefined,
    resource: typeof data.aud === 'string' ? data.aud : undefined,
  };
}

async function introspectToken(
  token: string,
  expectedResource: string
): Promise<OAuthIntrospectionResponse> {
  const introspectionSecret = getOAuthIntrospectionSecret();
  if (!introspectionSecret) {
    throw credentialValidationUnavailable({
      reason: 'introspect_secret_missing',
      resource: expectedResource,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  let response: Response;
  try {
    response = await fetch(getOAuthIntrospectionEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${introspectionSecret}`,
      },
      body: new URLSearchParams({
        resource: expectedResource,
        token,
        token_type_hint: 'access_token',
      }),
      signal: controller.signal,
    });
  } catch {
    // Separating the budget abort from a genuine transport fault is the whole
    // point of recording `aborted`: they need different operational responses.
    throw credentialValidationUnavailable({
      aborted: controller.signal.aborted,
      elapsedMs: elapsedMs(),
      reason: 'introspect_transport_error',
      resource: expectedResource,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw credentialValidationUnavailable({
      elapsedMs: elapsedMs(),
      reason: 'introspect_http_status',
      resource: expectedResource,
      status: response.status,
    });
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw credentialValidationUnavailable({
      elapsedMs: elapsedMs(),
      reason: 'introspect_content_type',
      resource: expectedResource,
      status: response.status,
    });
  }
  // A body that fails to parse, or that parses to something without a boolean
  // `active`, is an unusable answer rather than a verdict on the credential.
  // Reading `active` off `null` would throw past every tagged error here and
  // reach the client as an OAuth challenge carrying raw parser text.
  const data = (await response
    .json()
    .catch(() => null)) as OAuthIntrospectionResponse | null;
  if (!data || typeof data.active !== 'boolean') {
    throw credentialValidationUnavailable({
      elapsedMs: elapsedMs(),
      reason: 'introspect_malformed_body',
      resource: expectedResource,
      status: response.status,
    });
  }
  if (
    data.active &&
    (!data.api_key ||
      !isOAuthCredentialPurpose(data.credential_purpose) ||
      !values(data.scope).includes(MCP_GLOBAL_SCOPE))
  ) {
    // Introspection answered cleanly; the credential it described cannot be
    // used here. Tagged apart from an outage so the two are never conflated.
    throw credentialValidationUnavailable({
      elapsedMs: elapsedMs(),
      reason: 'introspect_unusable_credential',
      resource: expectedResource,
      status: response.status,
    });
  }
  return data;
}

async function resolveCredentialFromHeaders(
  headers: IncomingHttpHeaders,
  profile: ServerProfile
): Promise<ResolvedCredential | undefined> {
  const bearer = extractBearerToken(headers);
  const headerApiKey = normalizeHeader(
    headers['x-firecrawl-api-key'] ?? headers['x-api-key']
  );
  const token = headerApiKey ?? bearer;
  if (!token) return undefined;
  if (!profile.acceptApiKeys && !isFirecrawlOAuthAccessToken(token)) {
    throw new Error(
      `OAuth access token required for the Firecrawl MCP resource ${profile.endpoint}`
    );
  }
  if (!isFirecrawlOAuthAccessToken(token) && !isFirecrawlApiKey(token)) {
    return { invalid: true };
  }

  // An API key is already the credential Core authenticates, so introspection
  // resolves it to itself. Forward it unchanged and let Core be the authority;
  // a 401 becomes CREDENTIAL_INVALID at the tool boundary. OAuth access tokens
  // keep the strict path below because Core cannot resolve them on its own.
  if (isFirecrawlApiKey(token)) {
    return { credential: token, source: 'api-key' };
  }

  let data = await introspectToken(token, profile.resourceUrl);
  if (
    isFirecrawlOAuthAccessToken(token) &&
    !data.active &&
    profile.acceptLegacyAudience
  ) {
    data = await introspectToken(token, DEFAULT_MCP_RESOURCE_URL);
  }
  if (!data.active || !data.api_key) {
    throw new InvalidOAuthCredentialError();
  }
  const expectedAudience =
    profile.acceptLegacyAudience &&
    audienceMatchesResource(data.aud, DEFAULT_MCP_RESOURCE_URL)
      ? DEFAULT_MCP_RESOURCE_URL
      : profile.resourceUrl;
  if (!audienceMatchesResource(data.aud, expectedAudience)) {
    throw new Error('OAuth token audience does not match this resource');
  }
  if (
    profile.requireManagedOAuth &&
    data.credential_purpose !== 'hosted_mcp_oauth'
  ) {
    throw new Error('OAuth token is not a managed Firecrawl MCP credential');
  }
  if (data.credential_purpose === 'hosted_mcp_oauth') {
    // expectedAudience, not profile.resourceUrl: it is the resource the token
    // was actually validated against once the legacy fallback is applied.
    requireDelegatedCredentialSigning(expectedAudience);
    return {
      managedOAuthApiKey: data.api_key,
      source: 'oauth',
      metadata: credentialMetadata(data),
    };
  }
  return {
    credential: data.api_key,
    source: 'oauth',
    metadata: credentialMetadata(data),
  };
}

async function authenticateRequest(
  request: MCPAuthRequest | undefined,
  profile: ServerProfile
): Promise<SessionData> {
  // FastMCP invokes `authenticate(undefined)` for the stdio transport
  // because there is no HTTP request context. Without this null guard,
  // accessing `request.headers` throws a TypeError, FastMCP silently
  // swallows it, and every subsequent tool call fails with
  // "Unauthorized: API key is required when not using a self-hosted
  // instance" even though `FIRECRAWL_API_KEY` is set in env.
  const resolved = request?.headers
    ? await resolveCredentialFromHeaders(request.headers, profile)
    : undefined;

  const headerCred = resolved?.credential;
  const managedCred = resolved?.managedOAuthApiKey;
  const envCred = resolveCredentialFromEnv();

  if (process.env.CLOUD_SERVICE === 'true') {
    if (!headerCred && !managedCred) {
      if (resolved?.invalid) {
        // A supplied-but-invalid credential must reach the *agent*, not die as a
        // transport 401. MCP clients treat a 401 at initialize/tools-list as
        // "server unavailable" and never surface the response body to the model,
        // so the recovery payload in that 401 was unreachable in a real session.
        // On the keyless+API-key endpoint, admit the session flagged with
        // credentialError: the connection succeeds, tools list, and every tool
        // call returns the CREDENTIAL_INVALID recovery payload as a 200 isError
        // result — the same agent-legible path keyless quota recovery uses. No
        // credential is forwarded and no tool executes, so this grants zero
        // functional access. OAuth-only surfaces (e.g. /v2/mcp-search) keep the
        // hard 401 credential-rejection contract they already advertise.
        if (profile.allowKeyless) {
          return {
            authType: 'api-key',
            credentialError: 'CREDENTIAL_INVALID',
            firecrawlApiKey: undefined,
            keylessClientIp: extractClientIp(request),
          };
        }
        throw new InvalidFirecrawlCredentialError();
      }
      if (profile.allowKeyless) {
        return {
          authType: 'keyless',
          firecrawlApiKey: undefined,
          keylessClientIp: extractClientIp(request),
        };
      }
      if (!profile.acceptApiKeys) {
        throw new Error(
          `OAuth access token required for the Firecrawl MCP resource ${profile.endpoint}`
        );
      }
      throw new Error(
        'Firecrawl credentials required: OAuth access token (Authorization: Bearer fco_...) or API key (x-firecrawl-api-key)'
      );
    }
    const session: SessionData = {
      authType: resolved?.source === 'oauth' ? 'oauth' : 'api-key',
      firecrawlApiKey: headerCred,
      ...(isLegacyKeyPathRequest(request) ? { keyTransport: 'path' as const } : {}),
      ...resolved?.metadata,
    };
    return managedCred ? setManagedOAuthApiKey(session, managedCred) : session;
  }

  const credential = headerCred ?? managedCred ?? envCred;

  // Self-hosted / stdio / HTTP streamable — headers supply MCP OAuth token when present
  const httpStreaming = isHttpStreamingTransport();
  if (
    !httpStreaming &&
    !process.env.FIRECRAWL_API_KEY &&
    !process.env.FIRECRAWL_API_URL
  ) {
    // No credential and no self-hosted URL: run in keyless mode. scrape and
    // search work for free (rate-limited per IP) against the Firecrawl cloud;
    // every other tool needs an API key and will return Unauthorized.
    console.error(
      'No FIRECRAWL_API_KEY or FIRECRAWL_API_URL set — running in keyless mode. ' +
        'firecrawl_scrape and firecrawl_search are free (rate-limited per IP) against the Firecrawl cloud; ' +
        'other tools require an API key (get one free at https://firecrawl.dev).'
    );
  }

  if (httpStreaming && !credential && !process.env.FIRECRAWL_API_URL) {
    console.error(
      'HTTP MCP transport requires FIRECRAWL_API_URL and/or credentials (OAuth: Authorization Bearer fco_..., or FIRECRAWL_API_KEY / FIRECRAWL_OAUTH_TOKEN)'
    );
    process.exit(1);
  }

  const session: SessionData = {
    authType:
      resolved?.source === 'oauth'
        ? 'oauth'
        : resolved?.source === 'api-key'
          ? 'api-key'
          : credential
            ? 'env'
            : 'none',
    firecrawlApiKey: headerCred ?? envCred,
    ...resolved?.metadata,
  };
  return managedCred ? setManagedOAuthApiKey(session, managedCred) : session;
}

type SearchCompanionAuthMode = 'oauth' | 'api-key' | 'none';

function searchCompanionAuthMode(
  request?: MCPAuthRequest,
  session?: SessionData
): SearchCompanionAuthMode {
  if (session?.authType === 'oauth') return 'oauth';
  if (session?.authType === 'api-key') return 'api-key';
  // Mirror resolveCredentialFromHeaders precedence: explicit API-key headers
  // win over Authorization when both are present.
  const headerApiKey = normalizeHeader(
    request?.headers?.['x-firecrawl-api-key'] ?? request?.headers?.['x-api-key']
  );
  if (headerApiKey) return 'api-key';
  const bearer = request?.headers ? extractBearerToken(request.headers) : undefined;
  if (bearer?.startsWith('fco_')) return 'oauth';
  if (bearer) return 'api-key';
  return 'none';
}

/**
 * Additive, intentionally low-cardinality companion traffic telemetry. This
 * is the only reliable way to establish whether the live companion is still
 * serving API-key consumers before its explicit OAuth-only cutover. Do not add
 * identifiers, credentials, request URLs, user agents, or hashes here.
 */
function emitSearchCompanionAuthTelemetry(
  profile: ServerProfile,
  request: MCPAuthRequest | undefined,
  outcome: 'accepted' | 'rejected',
  session?: SessionData
): void {
  if (
    process.env.CLOUD_SERVICE !== 'true' ||
    profile.id !== 'search' ||
    profile.primary === true
  ) {
    return;
  }
  console.log(
    '[MCP_SEARCH_AUTH]',
    JSON.stringify({
      auth_mode: searchCompanionAuthMode(request, session),
      outcome,
      profile: 'companion',
      // Unique only to this telemetry record; it is not a cross-service
      // correlation ID and does not accept client-controlled identifiers.
      event_id: randomUUID(),
      route: DEFAULT_MCP_SEARCH_ENDPOINT,
    })
  );
}

function emitLegacyKeyPathTelemetry(
  profile: ServerProfile,
  request: MCPAuthRequest | undefined,
  outcome: 'accepted' | 'rejected',
  session?: SessionData
): void {
  if (profile.id !== 'full' || !isLegacyKeyPathRequest(request)) return;
  console.log(
    '[MCP_LEGACY_KEY_PATH]',
    JSON.stringify({
      auth_type: session?.authType ?? 'none',
      key_transport: 'path',
      outcome,
      resource: profile.resourceUrl,
    })
  );
}

/**
 * Builds the `authenticate` hook for one profile. FastMCP runs it on every
 * request (including `tools/list`), so a rejection here yields a 401 with the
 * profile's own OAuth challenge and no request reaches an unauthenticated tool.
 */
function makeAuthenticate(profile: ServerProfile) {
  return async function authenticateWithOAuthChallenge(
    request?: MCPAuthRequest
  ): Promise<SessionData> {
    if (request?.[authResultByRequest]) {
      return request[authResultByRequest];
    }

    const authResult = authenticateRequest(request, profile)
      .then((session) => {
        emitSearchCompanionAuthTelemetry(
          profile,
          request,
          session.credentialError ? 'rejected' : 'accepted',
          session
        );
        emitLegacyKeyPathTelemetry(
          profile,
          request,
          session.credentialError ? 'rejected' : 'accepted',
          session
        );
        return session;
      })
      .catch((error) => {
        emitSearchCompanionAuthTelemetry(profile, request, 'rejected');
        emitLegacyKeyPathTelemetry(profile, request, 'rejected');
        if (error instanceof InvalidFirecrawlCredentialError) {
          throw createInvalidCredentialResponse(error);
        }
        if (error instanceof InvalidOAuthCredentialError) {
          const recovery = invalidOAuthRecoveryPayload();
          const oauthChallenge = createOAuthChallengeResponse(
            new Error(recovery.message),
            profile,
            recovery
          );
          throw oauthChallenge ?? createInvalidOAuthRecoveryResponse(recovery);
        }
        if (error instanceof CredentialValidationUnavailableError) {
          throw createCredentialValidationUnavailableResponse(error);
        }
        const shouldChallenge = requestShouldReceiveOAuthChallenge(request, profile);
        const oauthChallenge = shouldChallenge
          ? createOAuthChallengeResponse(error, profile)
          : undefined;
        if (oauthChallenge) {
          throw oauthChallenge;
        }
        throw error;
      });

    if (request) {
      request[authResultByRequest] = authResult;
    }

    return authResult;
  };
}

function removeEmptyTopLevel<T extends Record<string, any>>(
  obj: T
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).length === 0
    )
      continue;
    // @ts-expect-error dynamic assignment
    out[k] = v;
  }
  return out;
}

const searchDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/,
    'Domain must be a valid hostname without protocol or path'
  );

function buildSearchQueryWithDomains(
  query: string,
  includeDomains?: string[],
  excludeDomains?: string[]
): string {
  if (includeDomains?.length) {
    return `${query} (${includeDomains
      .map((domain) => `site:${domain}`)
      .join(' OR ')})`;
  }

  if (excludeDomains?.length) {
    return `${query} ${excludeDomains
      .map((domain) => `-site:${domain}`)
      .join(' ')}`;
  }

  return query;
}

// Parameter fields shared by both firecrawl_search surfaces. The full surface
// adds `scrapeOptions` on top; the search surface uses these as-is (strict, no
// scrapeOptions). Defining the field set once keeps the two surfaces from
// drifting when a source type, category, or filter changes.
const searchToolBaseFields = {
  query: z
    .string()
    .min(1)
    .describe('Query for semantic search; use Find Tools for catalogue lookup.'),
  domainTools: z
    .boolean()
    .optional()
    .describe('Include contextual tool matches for the query and result URLs.'),
  highlights: z
    .boolean()
    .optional()
    .describe(
      'Return query-relevant highlights for each search result. Set to false to keep the original search snippets.'
    ),
  limit: z.number().int().min(1).max(100).optional(),
  tbs: z.string().optional(),
  filter: z.string().optional(),
  location: z.string().optional(),
  includeDomains: z.array(searchDomainSchema).optional(),
  excludeDomains: z.array(searchDomainSchema).optional(),
  sources: z
    .array(searchSourceSchema)
    .optional()
    .describe(ALEXANDRIA_INSTRUCTIONS),
  categories: z
    .array(z.enum(['github', 'research', 'pdf', 'developer']))
    .optional()
    .describe(
      'Limit results to specific source types. `github` searches GitHub repositories, code, issues, and docs; `research` restricts ordinary web results to research-affiliated websites and returns page snippets, which is separate from the `firecrawl_research_*` tools that search paper abstracts and full text across biomedical (PubMed, bioRxiv, medRxiv) and arXiv literature; `pdf` searches PDF results; `developer` searches an index built for coding agents over repositories, GitHub issues, merged pull requests, repository READMEs, and curated documentation sites. `developer` returns hits in `data.web` with `category: "developer"`; the other categories also filter `data.web`.'
    ),
  enterprise: z.array(z.enum(['default', 'anon', 'zdr'])).optional(),
};

// Both surfaces forbid specifying includeDomains and excludeDomains together.
function searchDomainsAreExclusive(args: {
  includeDomains?: string[];
  excludeDomains?: string[];
}): boolean {
  return !(args.includeDomains?.length && args.excludeDomains?.length);
}
const SEARCH_DOMAINS_CONFLICT_MESSAGE =
  'includeDomains and excludeDomains cannot both be specified';

// Firecrawl Exchange (catalogued data providers). Search returns capability
// hits, firecrawl_exchange_discover reads a capability's contract, and scrape
// with `exchange` executes capabilities. Every Exchange call is gated per team
// by an API key, so keyless and unauthenticated sessions are refused here
// with an explanatory message instead of an opaque upstream 401/403.
const EXCHANGE_KEY_REQUIRED_MESSAGE =
  'Alexandria requires an API key on a team with Alexandria access';
const EXCHANGE_MAX_CALLS = 10;

const exchangeCallSchema = z.object({
  provider: z.string().min(1).describe('Provider slug, e.g. "fred".'),
  capability: z
    .string()
    .min(1)
    .describe(
      'Capability address as returned by search or discover, e.g. "series/observations".'
    ),
  options: z
    .record(z.string(), z.any())
    .optional()
    .describe('Capability options as declared by its contract.'),
});
const exchangeCallsSchema = z
  .array(exchangeCallSchema)
  .min(1)
  .max(EXCHANGE_MAX_CALLS);

const exchangeDiscoverParamsSchema = z.object({
  cohort: z.string().min(1).optional().describe('Cohort slug, e.g. "finance".'),
  provider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider slug within the cohort. Requires cohort.'),
  capability: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Capability address within the provider, e.g. "series/observations". Requires cohort and provider; returns the full contract.'
    ),
  q: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Semantic query over all capabilities. Accepted on the index route only (no cohort, provider, or capability).'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe('Maximum semantic hits (1-24). Applies with q.'),
  expand: z
    .enum(['all'])
    .optional()
    .describe('On a cohort route, "all" inlines each provider\'s capabilities.'),
});

type ExchangeDiscoverArgs = z.infer<typeof exchangeDiscoverParamsSchema>;

function assertExchangeCredential(session?: SessionData): void {
  if (hasCredential(session)) return;
  const payload = {
    code: 'EXCHANGE_API_KEY_REQUIRED',
    message: EXCHANGE_KEY_REQUIRED_MESSAGE,
    docs_url: MCP_CONNECTION_GUIDE_URL,
  };
  throw new UserError(payload.message, payload);
}

// Every path segment is a catalogue slug. encodeURIComponent leaves "." and
// ".." intact, so refuse them outright to keep the request under
// /exchange/discover.
function encodeExchangeDiscoverSegment(segment: string): string {
  if (segment === '.' || segment === '..') {
    throw new UserError(
      'cohort, provider, and capability segments must be catalogue slugs; "." and ".." are not accepted.'
    );
  }
  return encodeURIComponent(segment);
}

function buildExchangeDiscoverPath(args: ExchangeDiscoverArgs): string {
  if (args.q && (args.cohort || args.provider || args.capability)) {
    throw new UserError(
      'q is accepted on the index route only: omit cohort, provider, and capability to search semantically, or drop q to walk the catalogue.'
    );
  }
  if (args.provider && !args.cohort) {
    throw new UserError('provider requires cohort.');
  }
  if (args.capability && !(args.cohort && args.provider)) {
    throw new UserError('capability requires cohort and provider.');
  }
  if (args.limit !== undefined && !args.q) {
    throw new UserError('limit applies with q only.');
  }
  if (args.expand && !(args.cohort && !args.provider && !args.capability)) {
    throw new UserError(
      'expand applies on a cohort route only: pass cohort without provider or capability.'
    );
  }
  const segments = [args.cohort, args.provider]
    .filter((segment): segment is string => Boolean(segment))
    .map(encodeExchangeDiscoverSegment);
  if (args.capability) {
    segments.push(
      ...args.capability
        .split('/')
        .filter(Boolean)
        .map(encodeExchangeDiscoverSegment)
    );
  }
  const params = new URLSearchParams();
  if (args.q) params.set('q', args.q);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.expand) params.set('expand', args.expand);
  const query = params.toString();
  return `/exchange/discover${segments.length ? `/${segments.join('/')}` : ''}${query ? `?${query}` : ''}`;
}

const TERMS_REQUIRED_CODE = 'THIRD_PARTY_DATA_TERMS_REQUIRED';

type TermsRequiredAction = {
  type: 'accept_terms';
  terms: string;
  version: string;
  url: string;
};

type ExchangeErrorContext = { tool: string; requestId?: string };

function termsRequiredAction(body: unknown): TermsRequiredAction | undefined {
  const data = body as
    | { code?: unknown; requiresAction?: unknown }
    | null
    | undefined;
  if (data?.code !== TERMS_REQUIRED_CODE) return undefined;
  const action = data.requiresAction as
    | Partial<TermsRequiredAction>
    | null
    | undefined;
  if (
    action?.type !== 'accept_terms' ||
    typeof action.terms !== 'string' ||
    typeof action.version !== 'string' ||
    typeof action.url !== 'string'
  )
    return undefined;
  return {
    type: 'accept_terms',
    terms: action.terms,
    version: action.version,
    url: action.url,
  };
}

function termsRequiredError(
  action: TermsRequiredAction,
  context: ExchangeErrorContext
): UserError {
  const requestId = context.requestId ?? randomUUID();
  const message = `Alexandria provider terms required. An organization admin must accept the ${action.terms} provider's terms (version ${action.version}) before this request can run.`;
  return new UserError(
    `${message}\n\n1. Ask a Firecrawl organization admin to sign in and accept at ${action.url} . Acceptance is a legal act by a human and cannot be performed through this tool; do not try.\n2. After they confirm, call ${context.tool} again with the identical payload and requestId ${requestId}. If it still fails with the same code, wait a few seconds and retry once.\n\nNo credits were charged. Do not retry until acceptance is confirmed.`,
    {
      code: TERMS_REQUIRED_CODE,
      status: 403,
      message,
      requestId,
      requiresAction: action,
      next_actions: [
        {
          kind: 'human_action_required',
          action: 'accept_terms',
          who: 'organization_admin',
          url: action.url,
          provider: action.terms,
          version: action.version,
        },
        {
          kind: 'retry_same_request',
          tool: context.tool,
          requestId,
          after: 'human_action_required',
        },
      ],
    }
  );
}

function throwIfTermsRequired(
  error: unknown,
  context: ExchangeErrorContext
): void {
  const source = error as
    | { response?: { data?: unknown }; details?: unknown }
    | null
    | undefined;
  const action = termsRequiredAction(source?.response?.data ?? source?.details);
  if (action) throw termsRequiredError(action, context);
}

async function relayTermsRequired<T>(
  run: () => Promise<T>,
  context: ExchangeErrorContext
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwIfTermsRequired(error, context);
    throw error;
  }
}

// Exchange errors arrive as {success:false, error, code?, chargeId?} with the
// upstream status (403 without the team flag, 402/409 once billing lands, 5xx
// when the Exchange is unreachable). Relay the message, code, and any chargeId
// so the agent can act on them; a 401 is left to the credential recovery path.
async function relayExchangeError(
  run: () => Promise<any>,
  context: ExchangeErrorContext
): Promise<any> {
  try {
    return await run();
  } catch (error) {
    throwIfTermsRequired(error, context);
    const response = (
      error as { response?: { status?: number; data?: unknown } } | null
    )?.response;
    if (!response || response.status === 401) throw error;
    const data = response.data as
      { error?: unknown; code?: unknown; chargeId?: unknown } | undefined;
    const message =
      typeof data?.error === 'string'
        ? data.error
        : `Alexandria request failed (HTTP ${response.status})`;
    throw new UserError(message, {
      code: typeof data?.code === 'string' ? data.code : 'exchange_error',
      status: response.status,
      message,
      ...(typeof data?.chargeId === 'string'
        ? { chargeId: data.chargeId }
        : {}),
    });
  }
}

class ConsoleLogger implements Logger {
  private shouldLog =
    process.env.CLOUD_SERVICE === 'true' ||
    process.env.SSE_LOCAL === 'true' ||
    process.env.HTTP_STREAMABLE_SERVER === 'true';

  debug(...args: unknown[]): void {
    if (this.shouldLog) {
      console.debug('[DEBUG]', new Date().toISOString(), ...args);
    }
  }
  error(...args: unknown[]): void {
    if (this.shouldLog) {
      console.error('[ERROR]', new Date().toISOString(), ...args);
    }
  }
  info(...args: unknown[]): void {
    if (this.shouldLog) {
      console.log('[INFO]', new Date().toISOString(), ...args);
    }
  }
  log(...args: unknown[]): void {
    if (this.shouldLog) {
      console.log('[LOG]', new Date().toISOString(), ...args);
    }
  }
  warn(...args: unknown[]): void {
    if (this.shouldLog) {
      console.warn('[WARN]', new Date().toISOString(), ...args);
    }
  }
}

const openAiAppsChallengeToken = normalizeHeader(
  process.env.OPENAI_APPS_CHALLENGE_TOKEN
);

const FULL_PROFILE_INSTRUCTIONS =
  ALEXANDRIA_INSTRUCTIONS +
  ` firecrawl_skills_resolve matches query mentions and page URLs, and firecrawl_skill reads a Markdown contract. Execution with firecrawl_scrape alexandria uses requestId; reuse the returned ID for retries of the same payload, never a new ID to bypass a pending or uncertain 409. Firecrawl provides web search, page retrieval, site URL discovery, multi-page collection, structured page data, monitoring, and multi-source research that returns structured data. Match the requested operation to the tool boundary: firecrawl_scrape retrieves one supplied page and can return JSON matching a supplied schema, firecrawl_map enumerates URLs under a site without retrieving their content, and firecrawl_agent runs multi-source research and returns structured data when the URLs are not known or the answer spans several sites (an entity plus its fields, a list, a dataset); its result is read with firecrawl_agent_status. For biomedical, life-science, clinical, or arXiv literature, the firecrawl_research_* tools search a paper index of abstracts and full text; firecrawl_search with categories: ["research"] is a website filter over ordinary web results and reaches different sources. For a programming question — code behaviour, a library or framework, an API contract, an error message, or a known bug — firecrawl_developer_search (or firecrawl_search with categories: ["developer"]) searches an index of repositories, GitHub issues, merged pull requests, READMEs, and curated documentation sites. Alexandria is a catalogue of data providers: firecrawl_search with sources: [{type: "alexandria"}] returns complete tool contracts in data.tools, firecrawl_find_tools walks providers, groups, and capabilities to progressively read contracts, and firecrawl_scrape with alexandria: [{provider, capability, options}] executes up to ten capabilities and reports data.creditsCost. Alexandria access needs an API key on a team with it enabled. A terms-gated Alexandria provider fails with code THIRD_PARTY_DATA_TERMS_REQUIRED and a requiresAction.url that a human organization admin must visit to accept the terms; no tool can accept them. Provide only the required inputs and account for stated network or external side effects.`;
const KEYLESS_PROFILE_INSTRUCTIONS = `Hosted keyless sessions expose firecrawl_search, firecrawl_scrape, and firecrawl_parse with usage limits. firecrawl_search searches the web. For programming questions, firecrawl_search with categories: ["developer"] searches indexed repositories, GitHub issues, merged pull requests, repository READMEs, and curated documentation sites. For biomedical, life-science, clinical, or arXiv literature, firecrawl_search with categories: ["research"] filters ordinary web results to research-affiliated websites. firecrawl_scrape retrieves one supplied page and can return JSON matching a supplied schema. firecrawl_parse processes supported local files through its two-phase upload flow. An Authorization bearer API key can provide higher usage limits and expose additional tools, subject to plan, deployment, and team policy, including firecrawl_map for site URL discovery, firecrawl_agent and firecrawl_agent_status for multi-source research that returns structured data when the URLs are not known, firecrawl_research_* for paper-index and repository research, and firecrawl_exchange_discover with the Exchange options of firecrawl_search and firecrawl_scrape for catalogued data providers.`;

// The search surface exposes web/developer/research search only. Its instructions
// and tool copy describe just those tools and stay neutral about how a client
// uses them.
const SEARCH_PROFILE_INSTRUCTIONS =
  ALEXANDRIA_INSTRUCTIONS +
  `Firecrawl provides web, developer, and research search. Use firecrawl_search to find relevant results across the web and specialized indexes. For a programming question, firecrawl_developer_search searches indexed repositories, GitHub issues, merged pull requests, READMEs, and curated documentation sites and returns the matched passages, and skills: "only" narrows it to agent-skill files; firecrawl_search with categories: ["developer"] reaches the same index beside ordinary web results, returning the hits in the web group rather than as passages and offering no skills filter. For a biomedical, life-science, clinical, or arXiv literature question, the firecrawl_research_* tools search the paper index, while categories: ["research"] on firecrawl_search filters ordinary web results to research-affiliated websites. Use the firecrawl_research_* tools to search academic and research literature, expand from anchor papers via the citation graph, and read full-text passages from a specific paper. All tools are read-only and return ranked results.`;

// The exact set of tools the search surface exposes. Registration is filtered
// against this set, so anything not listed here can never appear on that
// instance's tools/list or be called through it.
const SEARCH_PROFILE_TOOLS = new Set<string>([
  'firecrawl_search',
  'firecrawl_developer_search',
  'firecrawl_research_search_papers',
  'firecrawl_research_inspect_paper',
  'firecrawl_research_related_papers',
  'firecrawl_research_read_paper',
  // Registered so cached sessions get a DEPRECATED_TOOL payload, hidden from
  // tools/list via canList. See registerResearchTools.
  'firecrawl_research_search_github',
]);

function makeFullProfile(): ServerProfile {
  const account = getPrimaryEndpoint() === '/v2/mcp-oauth';
  return {
    id: account ? 'account' : 'full',
    resourceName: account ? 'Firecrawl MCP Account' : 'Firecrawl MCP',
    instructions: account ? FULL_PROFILE_INSTRUCTIONS : KEYLESS_PROFILE_INSTRUCTIONS,
    resourceUrl: account
      ? (normalizeHeader(process.env.FIRECRAWL_MCP_RESOURCE_URL) ??
        DEFAULT_MCP_OAUTH_RESOURCE_URL)
      : getMcpResourceUrl(),
    endpoint: account ? '/v2/mcp-oauth' : undefined,
    port: Number(process.env.PORT || 3000),
    allowKeyless: !account,
    acceptApiKeys: true,
    acceptLegacyAudience:
      account && process.env.MCP_OAUTH_ACCEPT_LEGACY_V2_MCP_AUD !== 'false',
    advertiseOAuth: account,
    primary: true,
  };
}

function searchOAuthOnly(): boolean {
  return process.env.FIRECRAWL_MCP_SEARCH_OAUTH_ONLY === 'true';
}

function makeSearchProfile({
  primary = false,
}: { primary?: boolean } = {}): ServerProfile {
  const oauthOnly = searchOAuthOnly();
  if (primary && !oauthOnly) {
    throw new Error(
      'FASTMCP_ENDPOINT=/v2/mcp-search requires FIRECRAWL_MCP_SEARCH_OAUTH_ONLY=true'
    );
  }
  return {
    id: 'search',
    resourceName: 'Firecrawl Search',
    instructions: SEARCH_PROFILE_INSTRUCTIONS,
    resourceUrl: getSearchMcpResourceUrl(),
    endpoint: primary ? DEFAULT_MCP_SEARCH_ENDPOINT : getSearchMcpEndpoint(),
    port: primary
      ? Number(process.env.PORT || 3000)
      : Number(process.env.FIRECRAWL_MCP_SEARCH_PORT || 3001),
    toolAllowlist: SEARCH_PROFILE_TOOLS,
    allowKeyless: false,
    // This is deliberately default-false because the image auto-deploys: the
    // existing in-process companion remains API-key compatible unless its
    // deployment explicitly enables the same profile flag used by primary.
    acceptApiKeys: !oauthOnly,
    requireManagedOAuth: oauthOnly,
    advertiseOAuth: true,
    primary,
  };
}

function makePrimaryProfile(): ServerProfile {
  return getPrimaryEndpoint() === '/v2/mcp-search'
    ? makeSearchProfile({ primary: true })
    : makeFullProfile();
}

function createServer(profile: ServerProfile): FastMCP<SessionData> {
  return new FastMCP<SessionData>({
    name: 'firecrawl-fastmcp',
    version: packageVersion as `${number}.${number}.${number}`,
    instructions: profile.instructions,
    logger: new ConsoleLogger(),
    roots: { enabled: false },
    oauth: {
      enabled: isMcpOAuthEnabled() && profile.advertiseOAuth,
      protectedResource: {
        authorizationServers: [getOAuthIssuer()],
        bearerMethodsSupported: ['header'],
        resource: profile.resourceUrl,
        resourceName: profile.resourceName,
        scopesSupported: ['firecrawl:global'],
      },
    },
    authenticate: makeAuthenticate(profile),
    // Lightweight health endpoint for LB checks
    health: {
      enabled: true,
      message: 'ok',
      path: '/health',
      status: 200,
    },
  });
}

const primaryProfile = makePrimaryProfile();
const server = createServer(primaryProfile);
type RegisteredTool = Parameters<typeof server.addTool>[0];

const KEYLESS_TOOL_NAMES = new Set([
  'firecrawl_scrape',
  'firecrawl_search',
  'firecrawl_parse',
]);

function isHostedKeylessSession(session?: SessionData): boolean {
  return (
    process.env.CLOUD_SERVICE === 'true' &&
    session?.authType === 'keyless' &&
    !session.firecrawlApiKey
  );
}

// A stdio client without a cloud credential can use only the keyless tools.
// Do this at registration time so unsupported feedback tools are not advertised.
function isLocalKeylessStartup(): boolean {
  return (
    process.env.CLOUD_SERVICE !== 'true' &&
    !isHttpStreamingTransport() &&
    !resolveCredentialFromEnv() &&
    !normalizeHeader(process.env.FIRECRAWL_API_URL)
  );
}

// FastMCP copies UserError.message onto both content[0].text and
// structuredContent.message. Hosts forward the text block, not
// structured next_actions, so bearer and OAuth recovery strings live here.
const KEYLESS_ACCOUNT_FIX =
  'Fix: Create an API key at https://www.firecrawl.dev/app/api-keys, then:\n- Set the header: Authorization: Bearer YOUR_API_KEY on https://mcp.firecrawl.dev/v2/mcp\nThen start a new session.';
const KEYLESS_QUOTA_MESSAGE = `You've hit Firecrawl's free MCP rate limit. To continue using without limits, create a Firecrawl API key.\n\n${KEYLESS_ACCOUNT_FIX}`;
const KEYLESS_TOOL_MESSAGE = `This tool needs a Firecrawl account.\n\n${KEYLESS_ACCOUNT_FIX}`;
const KEYLESS_ACCESS_MESSAGE = `Anonymous keyless access is unavailable for this request.\n\n${KEYLESS_ACCOUNT_FIX}`;
const INVALID_API_KEY_MESSAGE =
  'The Firecrawl API key is invalid or revoked.\nFix: Replace the key on the existing Firecrawl MCP server, then start a new session. Get an API key at https://www.firecrawl.dev/app/api-keys';
const INVALID_OAUTH_MESSAGE =
  'This Firecrawl account connection is no longer valid.\nFix: Reconnect the existing Firecrawl server in the client, or set that existing server URL to https://mcp.firecrawl.dev/v2/mcp-oauth, then start a new session.';

function connectionRecoveryPayload(params: {
  code: string;
  authMode: string;
  message: string;
}): Record<string, unknown> & { message: string } {
  return {
    code: params.code,
    auth_mode: params.authMode,
    message: params.message,
    docs_url: MCP_CONNECTION_GUIDE_URL,
  };
}

function invalidApiKeyRecoveryPayload(): Record<string, unknown> & {
  message: string;
} {
  return connectionRecoveryPayload({
    code: 'CREDENTIAL_INVALID',
    authMode: 'api_key',
    message: INVALID_API_KEY_MESSAGE,
  });
}

function invalidOAuthRecoveryPayload(): Record<string, unknown> & {
  message: string;
} {
  return connectionRecoveryPayload({
    code: 'OAUTH_CONNECTION_INVALID',
    authMode: 'oauth',
    message: INVALID_OAUTH_MESSAGE,
  });
}

/**
 * Core rejected the credential this session forwarded. Tools reach Core by
 * several routes, the SDK helpers, the SDK's HTTP layer, and plain fetch, so
 * this reads the status rather than the error's type: every route reports one,
 * and inside a tool a 401 can only have come from Core. Only 401 is matched,
 * because that is a verdict on the credential; a 403 can mean an entitlement
 * the key legitimately lacks.
 */
function isCoreCredentialRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as {
    response?: { status?: unknown };
    status?: unknown;
  };
  return candidate.status === 401 || candidate.response?.status === 401;
}

/**
 * API keys reach Core unresolved, so an invalid one is discovered when a tool
 * runs rather than at connect time. Translate that rejection into the same
 * CREDENTIAL_INVALID recovery the agent already knows how to act on, so the
 * guidance does not depend on having introspected the key first.
 */
async function runWithCredentialRecovery<T>(
  run: () => T | Promise<T>,
  requestId: string,
  session?: SessionData
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Only an API-key session hands Core a credential nothing resolved first.
    // An OAuth session was validated at connect time, so a rejection there is a
    // different fault and keeps its own reconnect guidance; a keyless session
    // never sent an account credential at all.
    if (session?.authType !== 'api-key' || !isCoreCredentialRejection(error)) {
      throw error;
    }
    const payload = recoveryPayload('CREDENTIAL_INVALID', requestId);
    throw new UserError(String(payload.message), payload);
  }
}

function recoveryPayload(
  code: string,
  requestId: string = randomUUID(),
  options: { retryAfterSeconds?: number } = {}
): Record<string, unknown> {
  const retryAfterSeconds = options.retryAfterSeconds;
  const isQuotaExhausted =
    code === 'KEYLESS_QUOTA_EXHAUSTED' || code === 'KEYLESS_LIMIT_REACHED';
  const isToolUnavailable = code === 'KEYLESS_TOOL_NOT_AVAILABLE';
  const isKeylessAccessUnavailable = code === 'KEYLESS_ACCESS_NOT_AVAILABLE';
  const isKeylessEligibilityUnavailable =
    code === 'KEYLESS_ELIGIBILITY_UNAVAILABLE';
  const isKeylessConversion =
    isQuotaExhausted || isToolUnavailable || isKeylessAccessUnavailable;
  return {
    code,
    request_id: requestId,
    auth_mode: code === 'CREDENTIAL_INVALID' ? 'credential_error' : 'keyless',
    message:
      code === 'CREDENTIAL_INVALID'
        ? INVALID_API_KEY_MESSAGE
        : isQuotaExhausted
          ? KEYLESS_QUOTA_MESSAGE
          : isToolUnavailable
            ? KEYLESS_TOOL_MESSAGE
            : isKeylessAccessUnavailable
              ? KEYLESS_ACCESS_MESSAGE
              : isKeylessEligibilityUnavailable
                ? 'The anonymous keyless eligibility check is temporarily unavailable. Retry shortly.'
                : 'This tool requires a Firecrawl account or API key.',
    // CREDENTIAL_INVALID sessions gate every tool call (including keyless
    // tools) on the credentialError check before the keyless branch ever
    // runs, so none of KEYLESS_TOOL_NAMES are actually callable here. Listing
    // them as available_tools would send the agent into a retry loop against
    // tools that will just return this same recovery payload. Quota, blocked
    // tools, and ineligible access omit available_tools and next_actions for
    // the same reason: those fields retry tools that cannot clear the error.
    ...(isKeylessConversion || code === 'CREDENTIAL_INVALID'
      ? {}
      : { available_tools: [...KEYLESS_TOOL_NAMES] }),
    docs_url: MCP_CONNECTION_GUIDE_URL,
    ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
    ...(isKeylessEligibilityUnavailable
      ? { next_actions: [{ kind: 'retry_later', after_seconds: 30 }] }
      : {}),
  };
}

function deprecatedExtractPayload() {
  return {
    code: 'DEPRECATED_TOOL',
    message:
      'firecrawl_extract is deprecated and unavailable through MCP. For structured data from a known page, call firecrawl_scrape once per URL with formats: ["json"] and jsonOptions containing the prompt and schema. When the URLs are not known or the data spans several sites, use firecrawl_agent for multi-source research.',
    replacement: {
      name: 'firecrawl_scrape',
      instructions:
        'Call once per known URL. Set formats to ["json"] and pass the extraction prompt and JSON schema in jsonOptions.',
      example_arguments: {
        url: 'https://example.com/page',
        formats: ['json'],
        jsonOptions: {
          prompt: 'Extract the requested fields from this page.',
          schema: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
    docs_url: 'https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor',
  };
}
type ActionStatus = 'started' | 'success' | 'error';

function emitActionLog(
  toolName: string,
  status: ActionStatus,
  session?: SessionData,
  error?: unknown,
  requestId = randomUUID(),
  code?: string
): void {
  if (process.env.CLOUD_SERVICE !== 'true') return;
  const payload = {
    team_id: session?.teamId,
    user_id: session?.userId,
    api_key_id: session?.apiKeyId,
    oauth_client_id: session?.oauthClientId,
    auth_type: session?.authType ?? 'none',
    tool_name: toolName,
    status,
    request_id: requestId,
    resource: primaryProfile.resourceUrl,
    ...(error
      ? { error_class: error instanceof Error ? error.name : typeof error }
      : {}),
    ...(code ? { code } : {}),
  };
  console.error('[MCP_ACTION]', JSON.stringify(payload));

  const secret = normalizeHeader(process.env.FIRECRAWL_MCP_ACTION_LOG_SECRET);
  const apiUrl = normalizeHeader(process.env.FIRECRAWL_API_URL);
  const endpoint =
    normalizeHeader(process.env.FIRECRAWL_MCP_ACTION_LOG_URL) ??
    (apiUrl ? `${withoutTrailingSlash(apiUrl)}/v2/mcp/action-logs` : undefined);
  if (!secret || !endpoint || !payload.team_id || status === 'started') return;
  // `code` is an MCP console-log discriminator, not part of the account-scoped
  // action-log API contract.
  const actionLogPayload = { ...payload };
  delete actionLogPayload.code;
  void fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(actionLogPayload),
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined);
}

function guardHostedTool(
  tool: RegisteredTool,
  { logActions }: { logActions: boolean }
): RegisteredTool {
  const keylessTool = KEYLESS_TOOL_NAMES.has(tool.name);
  const execute = tool.execute;
  const canList = tool.canList;
  const beforeValidate = tool.beforeValidate;
  return {
    ...tool,
    canList: (session: SessionData) =>
      // A credentialError session lists the keyless tool surface (same as a
      // real keyless session, not the full authenticated schema) so the
      // client proceeds past tools/list and calling any listed tool returns
      // the CREDENTIAL_INVALID recovery payload (below). An empty list would
      // leave MCP clients that stop after tools/list unable to ever surface
      // the recovery guidance; the full non-keyless schema would over-disclose
      // to a request carrying an unrecognized or invalid credential.
      (session?.credentialError || isHostedKeylessSession(session)
        ? keylessTool
        : true) &&
      (canList?.(session) ?? true),
    beforeValidate: async (args: unknown, session: SessionData) => {
      const code = session?.credentialError
        ? 'CREDENTIAL_INVALID'
        : isHostedKeylessSession(session) && !keylessTool
          ? 'KEYLESS_TOOL_NOT_AVAILABLE'
          : undefined;
      if (code) {
        const requestId = randomUUID();
        const payload = recoveryPayload(code, requestId);
        if (logActions) {
          emitActionLog(tool.name, 'error', session, new UserError(String(payload.message), payload), requestId, code);
        }
        return {
          content: [{ type: 'text' as const, text: String(payload.message) }],
          isError: true,
          structuredContent: payload,
        };
      }
      const earlyResult = await beforeValidate?.(args, session);
      const payload = earlyResult?.structuredContent;
      const recoveryCode =
        payload &&
        typeof payload === 'object' &&
        'code' in payload &&
        typeof payload.code === 'string'
          ? payload.code
          : undefined;
      if (logActions && earlyResult?.isError && recoveryCode) {
        emitActionLog(
          tool.name,
          'error',
          session,
          new UserError(`Tool validation failed: ${recoveryCode}`, payload),
          randomUUID(),
          recoveryCode
        );
      }
      return earlyResult;
    },
    execute: async (args, context) => {
      const requestId = randomUUID();
      const invocationSession: SessionData = {
        ...context.session,
        requestId,
      };
      copyManagedOAuthApiKey(context.session, invocationSession);
      const invocationContext = {
        ...context,
        session: invocationSession,
      };

      if (invocationSession.credentialError) {
        const code = 'CREDENTIAL_INVALID';
        const payload = recoveryPayload(code, requestId);
        if (logActions) emitActionLog(tool.name, 'error', invocationSession, new UserError(String(payload.message), payload), requestId, code);
        throw new UserError(String(payload.message), payload);
      }
      if (isHostedKeylessSession(invocationSession) && !keylessTool) {
        const code = 'KEYLESS_TOOL_NOT_AVAILABLE';
        const payload = recoveryPayload(code, requestId);
        if (logActions) emitActionLog(tool.name, 'error', invocationSession, new UserError(String(payload.message), payload), requestId, code);
        throw new UserError(String(payload.message), payload);
      }
      const runTool = () =>
        runWithCredentialRecovery(
          () => execute(args, invocationContext),
          requestId,
          invocationSession
        );
      if (!logActions) return runTool();

      emitActionLog(tool.name, 'started', invocationSession, undefined, requestId);
      try {
        const result = await runTool();
        emitActionLog(tool.name, 'success', invocationSession, undefined, requestId);
        return result;
      } catch (error) {
        emitActionLog(tool.name, 'error', invocationSession, error, requestId);
        throw error;
      }
    },
  };
}

const addTool = server.addTool.bind(server);
server.addTool = ((tool: RegisteredTool) => {
  // A dedicated search process registers through the same module-level tool
  // setup as full MCP. Filter at the server boundary so an accidental future
  // registration cannot widen its frozen public contract.
  if (
    primaryProfile.toolAllowlist &&
    !primaryProfile.toolAllowlist.has(tool.name)
  ) {
    return;
  }
  // The module registers the full `firecrawl_search` before startup. A primary
  // search profile must instead receive the strict marketplace variant below:
  // it has no scrapeOptions and no instructions referring to the excluded
  // feedback tool. Keep the name filter here so the full registration cannot
  // leak into the frozen search surface.
  if (primaryProfile.id === 'search' && tool.name === 'firecrawl_search') {
    return;
  }
  addTool(guardHostedTool(tool, { logActions: primaryProfile.id !== 'search' }));
}) as typeof server.addTool;

if (openAiAppsChallengeToken) {
  server
    .getApp()
    .get('/.well-known/openai-apps-challenge', (context) =>
      context.text(openAiAppsChallengeToken)
    );
}

server.getApp().get('/ready', (context) => {
  if (process.env.CLOUD_SERVICE !== 'true') {
    return context.json({ ok: true }, 200);
  }
  const searchPrimary = primaryProfile.id === 'search';
  // Readiness covers only dependencies that can prevent this profile from
  // serving authenticated requests. Account and search identities never take
  // the keyless path; action logging is intentionally best-effort (see
  // emitActionLog), so neither should make those profiles unavailable.
  const required = [
    'FIRECRAWL_API_URL',
    'FIRECRAWL_OAUTH_INTROSPECT_SECRET',
    'MCP_DELEGATED_CREDENTIAL_SECRET',
  ];
  if (primaryProfile.allowKeyless) {
    required.push('KEYLESS_PROXY_SECRET');
  }
  const missing = required.filter((name) => !normalizeHeader(process.env[name]));
  const configuredEndpoint = getPrimaryEndpoint();
  const resourceMatchesEndpoint = searchPrimary
    ? withoutTrailingSlash(primaryProfile.resourceUrl) ===
      DEFAULT_MCP_SEARCH_RESOURCE_URL
    : withoutTrailingSlash(primaryProfile.resourceUrl).endsWith(
        configuredEndpoint
      );
  if (!resourceMatchesEndpoint) {
    missing.push(
      searchPrimary
        ? 'FIRECRAWL_MCP_SEARCH_RESOURCE_URL (endpoint mismatch)'
        : 'FIRECRAWL_MCP_RESOURCE_URL (endpoint mismatch)'
    );
  }
  return missing.length
    ? context.json({ ok: false, missing }, 503)
    : context.json({ ok: true }, 200);
});

function createClient(apiKey?: string): FirecrawlApp {
  const config: any = {
    ...(process.env.FIRECRAWL_API_URL && {
      apiUrl: process.env.FIRECRAWL_API_URL,
    }),
  };

  // Only add apiKey if it's provided (required for cloud, optional for self-hosted)
  if (apiKey) {
    config.apiKey = apiKey;
  }

  return new FirecrawlApp(config);
}

const ORIGIN = 'mcp-fastmcp';
const ORIGIN_HEADERS = { 'X-Origin': ORIGIN };

// Safe mode is enabled by default for cloud service to comply with ChatGPT safety requirements
const SAFE_MODE = process.env.CLOUD_SERVICE === 'true';

function getClient(session?: SessionData): FirecrawlApp {
  if (process.env.CLOUD_SERVICE === 'true' && !hasCredential(session)) {
    throw new Error('Unauthorized');
  }
  if (!process.env.FIRECRAWL_API_URL && !hasCredential(session)) {
    throw new Error(
      'Unauthorized: API key is required when not using a self-hosted instance'
    );
  }
  if (!hasManagedOAuthCredential(session)) {
    return createClient(credentialForOutboundRequest(session));
  }

  const client = createClient('request-scoped-hosted-oauth');
  const axiosInstance = (client as any).http?.instance;
  if (!axiosInstance?.interceptors?.request?.use) {
    throw credentialValidationUnavailable({
      reason: 'outbound_client_uninstrumented',
    });
  }
  axiosInstance.interceptors.request.use((config: any) => {
    const credential = credentialForOutboundRequest(session);
    // Unreachable in practice: this interceptor is installed only for a session
    // holding a managed key, and that always signs to a non-empty credential or
    // throws while signing. Kept because the signature is `string | undefined`,
    // so removing it would mean asserting instead of checking.
    if (!credential) {
      throw credentialValidationUnavailable({
        reason: 'delegated_credential_unavailable',
      });
    }
    config.headers = {
      ...(config.headers ?? {}),
      Authorization: `Bearer ${credential}`,
    };
    return config;
  });
  return client;
}

function asText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// scrape tool (v2 semantics, minimal args)
// Centralized scrape params (used by scrape, and referenced in search/crawl scrapeOptions)

// Define safe action types
const safeActionTypes = ['wait', 'screenshot', 'scroll', 'scrape'] as const;
const otherActions = [
  'click',
  'write',
  'press',
  'executeJavascript',
  'generatePDF',
] as const;
const allActionTypes = [...safeActionTypes, ...otherActions] as const;

// Use appropriate action types based on safe mode
const allowedActionTypes = SAFE_MODE ? safeActionTypes : allActionTypes;

function buildFormatsArray(
  args: Record<string, unknown>
): Record<string, unknown>[] | undefined {
  const formats = args.formats as string[] | undefined;
  if (!formats || formats.length === 0) return undefined;

  const result: Record<string, unknown>[] = [];
  for (const fmt of formats) {
    if (fmt === 'json') {
      const jsonOpts = args.jsonOptions as Record<string, unknown> | undefined;
      result.push({ type: 'json', ...jsonOpts });
    } else if (fmt === 'query') {
      const queryOpts = args.queryOptions as
        Record<string, unknown> | undefined;
      result.push({ type: 'query', ...queryOpts });
    } else if (fmt === 'screenshot' && args.screenshotOptions) {
      const ssOpts = args.screenshotOptions as Record<string, unknown>;
      result.push({ type: 'screenshot', ...ssOpts });
    } else {
      result.push(fmt as unknown as Record<string, unknown>);
    }
  }
  return result;
}

function buildParsersArray(
  args: Record<string, unknown>
): Record<string, unknown>[] | undefined {
  const parsers = args.parsers as string[] | undefined;
  if (!parsers || parsers.length === 0) return undefined;

  const result: Record<string, unknown>[] = [];
  for (const p of parsers) {
    if (p === 'pdf' && args.pdfOptions) {
      const pdfOpts = args.pdfOptions as Record<string, unknown>;
      result.push({ type: 'pdf', ...pdfOpts });
    } else {
      result.push(p as unknown as Record<string, unknown>);
    }
  }
  return result;
}

function buildWebhook(
  args: Record<string, unknown>
): string | Record<string, unknown> | undefined {
  const webhook = args.webhook as string | undefined;
  if (!webhook) return undefined;
  const headers = args.webhookHeaders as Record<string, string> | undefined;
  if (headers && Object.keys(headers).length > 0) {
    return { url: webhook, headers };
  }
  return webhook;
}

function transformScrapeParams(
  args: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...args };

  const formats = buildFormatsArray(out);
  if (formats) out.formats = formats;

  const parsers = buildParsersArray(out);
  if (parsers) out.parsers = parsers;

  delete out.jsonOptions;
  delete out.queryOptions;
  delete out.screenshotOptions;
  delete out.pdfOptions;

  return out;
}

const scrapeParamsSchema = z.object({
  url: z.string().url(),
  formats: z
    .array(
      z.enum([
        'markdown',
        'html',
        'rawHtml',
        'screenshot',
        'links',
        'summary',
        'changeTracking',
        'branding',
        'json',
        'query',
        'audio',
      ])
    )
    .optional(),
  jsonOptions: z
    .object({
      prompt: z.string().optional(),
      schema: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  queryOptions: z
    .object({
      prompt: z.string().max(10000),
      mode: z.enum(['directQuote', 'freeform']).default('freeform'),
    })
    .optional(),
  screenshotOptions: z
    .object({
      fullPage: z.boolean().optional(),
      quality: z.number().optional(),
      viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    })
    .optional(),
  parsers: z.array(z.enum(['pdf'])).optional(),
  pdfOptions: z
    .object({
      maxPages: z.number().int().min(1).max(10000).optional(),
    })
    .optional(),
  onlyMainContent: z.boolean().optional(),
  redactPII: z.boolean().optional(),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  waitFor: z.number().optional(),
  ...(SAFE_MODE
    ? {}
    : {
        actions: z
          .array(
            z.object({
              type: z.enum(allowedActionTypes),
              selector: z.string().optional(),
              milliseconds: z.number().optional(),
              text: z.string().optional(),
              key: z.string().optional(),
              direction: z.enum(['up', 'down']).optional(),
              script: z.string().optional(),
              fullPage: z.boolean().optional(),
            })
          )
          .optional(),
      }),
  mobile: z.boolean().optional(),
  skipTlsVerification: z.boolean().optional(),
  removeBase64Images: z.boolean().optional(),
  location: z
    .object({
      country: z.string().optional(),
      languages: z.array(z.string()).optional(),
    })
    .optional(),
  storeInCache: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  maxAge: z.number().optional(),
  lockdown: z.boolean().optional(),
  proxy: z.enum(['basic', 'stealth', 'enhanced', 'auto']).optional(),
  profile: z
    .object({
      name: z.string(),
      saveChanges: z.boolean().optional(),
    })
    .optional(),
});

// firecrawl_scrape accepts either a page URL or an Exchange batch. The base
// schema stays url-required because search, crawl, and monitor reuse it for
// nested scrapeOptions, where `alexandria` has no meaning.
const scrapeToolParamsSchema = scrapeParamsSchema
  .extend({
    url: z.string().url().optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional()
      .describe(
        'Exchange execution ID. Reuse for retries of the identical payload; generated when omitted and returned with the result.'
      ),
    alexandria: z.union([exchangeCallSchema, exchangeCallsSchema])
      .optional()
      .describe(
        'Execute Firecrawl Exchange capabilities instead of scraping a URL. Exactly one of url or alexandria.'
      ),
    domainTools: z
      .boolean()
      .optional()
      .describe(
        'URL mode only: include domain-matched Alexandria tools for the page in data.tools.'
      ),
  })
  .refine(
    (args) => Boolean(args.url) !== Boolean(args.alexandria),
    'Provide exactly one of url or alexandria'
  )
  .refine(
    (args) =>
      !args.alexandria ||
      Object.entries(args).every(
        ([key, value]) =>
          key === 'alexandria' || key === 'requestId' || key === 'timeout' || value === undefined
      ),
    'alexandria cannot be combined with url or other scrape options'
  )
  .refine(
    (args) => !args.requestId || !!args.alexandria,
    'requestId applies to Exchange execution only'
  );

const parseOptionParamsSchema = z.object({
  formats: z
    .array(
      z.enum([
        'markdown',
        'html',
        'rawHtml',
        'links',
        'summary',
        'json',
        'query',
      ])
    )
    .optional(),
  jsonOptions: z
    .object({
      prompt: z.string().optional(),
      schema: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  queryOptions: z
    .object({
      prompt: z.string().max(10000),
      mode: z.enum(['directQuote', 'freeform']).default('freeform'),
    })
    .optional(),
  parsers: z.array(z.enum(['pdf'])).optional(),
  pdfOptions: z
    .object({
      maxPages: z.number().int().min(1).max(10000).optional(),
    })
    .optional(),
  onlyMainContent: z.boolean().optional(),
  redactPII: z.boolean().optional(),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  removeBase64Images: z.boolean().optional(),
  skipTlsVerification: z.boolean().optional(),
  storeInCache: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  maxAge: z
    .number()
    .optional()
    .describe('Ignored: parse never reuses or stores indexed content.'),
  proxy: z.enum(['basic', 'auto']).optional(),
});

const localParseParamsSchema = parseOptionParamsSchema.extend({
  filePath: z
    .string()
    .min(1)
    .describe(
      'Absolute or relative path to a local file to parse. Supported: .html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls'
    ),
  contentType: z
    .string()
    .optional()
    .describe(
      'Optional MIME type override. If omitted, the server infers the file kind from the extension.'
    ),
});

const hostedParseParamsSchema = parseOptionParamsSchema
  .extend({
    filePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Phase 1 only: path to the local file on the caller/harness machine. Hosted MCP will not read or stat this path; it is used only to produce upload instructions.'
      ),
    uploadRef: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Phase 2 only: short-lived upload reference returned by phase 1 after the local PUT upload completes.'
      ),
    contentType: z
      .string()
      .optional()
      .describe(
        'Phase 1 MIME type override. If omitted, the server infers it from the file extension without reading the file.'
      ),
    declaredSizeBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional phase 1 size declaration. Hosted MCP does not stat the file; provide this only if the caller already knows it.'
      ),
  })
  .superRefine((value, ctx) => {
    const hasFilePath =
      typeof value.filePath === 'string' && value.filePath.length > 0;
    const hasUploadRef =
      typeof value.uploadRef === 'string' && value.uploadRef.length > 0;
    if (hasFilePath === hasUploadRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Hosted firecrawl_parse requires exactly one of filePath (phase 1) or uploadRef (phase 2).',
        path: hasFilePath && hasUploadRef ? ['uploadRef'] : ['filePath'],
      });
    }
  });

const parseParamsSchema =
  process.env.CLOUD_SERVICE === 'true'
    ? hostedParseParamsSchema
    : localParseParamsSchema;

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

type ParseToolArgs = {
  filePath?: string;
  uploadRef?: string;
  contentType?: string;
  declaredSizeBytes?: number;
} & Record<string, unknown>;

function extractParseOptions(args: ParseToolArgs): Record<string, unknown> {
  const options = { ...args };
  delete options.filePath;
  delete options.uploadRef;
  delete options.contentType;
  delete options.declaredSizeBytes;
  return options;
}

function buildParseOptionsPayload(
  options: Record<string, unknown>
): Record<string, unknown> {
  const transformed = transformScrapeParams(options);
  const cleaned = removeEmptyTopLevel(transformed) as Record<string, unknown>;
  return { origin: ORIGIN, ...cleaned };
}

function buildContinuationArguments(
  uploadRef: string,
  options: Record<string, unknown>
): Record<string, unknown> {
  return {
    uploadRef,
    ...(removeEmptyTopLevel(options) as Record<string, unknown>),
  };
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

type ParseUploadUrlData = {
  uploadUrl: string;
  uploadRef: string;
  method?: string;
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  expiresAt?: string;
  maxSizeBytes?: number;
};

function parseApiData(json: any): any {
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

async function apiPostJson(
  pathName: string,
  body: Record<string, unknown>,
  apiKey: string
): Promise<any> {
  const response = await fetch(`${resolveApiBaseUrl()}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let parsed: any;
  try {
    parsed = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsed = { raw: responseText };
  }
  if (!response.ok) {
    throw new CoreHttpError(
      parsed?.error ||
        parsed?.message ||
        `Firecrawl request failed (HTTP ${response.status})`,
      response.status
    );
  }
  return parsed;
}

async function apiPostJsonForSession(
  pathName: string,
  body: Record<string, unknown>,
  session: SessionData | undefined
): Promise<any> {
  const credential = credentialForOutboundRequest(session);
  if (credential) {
    return apiPostJson(pathName, body, credential);
  }

  if (isKeylessMode(session)) {
    return keylessPost(pathName, body, session);
  }

  throw new Error(
    'Firecrawl credentials or keyless eligibility required for hosted parse.'
  );
}

function buildCurlUploadCommand(
  filePath: string,
  upload: ParseUploadUrlData
): string {
  const method = upload.method ?? 'PUT';
  const headerArgs = Object.entries(upload.headers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `-H ${shellQuote(`${key}: ${value}`)}`);

  if (method.toUpperCase() === 'POST' && upload.fields) {
    const fieldArgs = Object.entries(upload.fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, value]) => ['-F', shellQuote(`${key}=${value}`)]);
    return [
      'curl',
      '-X',
      shellQuote('POST'),
      ...headerArgs,
      ...fieldArgs,
      '-F',
      shellQuote(`file=@${filePath}`),
      shellQuote(upload.uploadUrl),
    ].join(' ');
  }

  return [
    'curl',
    '-X',
    shellQuote(method),
    ...headerArgs,
    '--upload-file',
    shellQuote(filePath),
    shellQuote(upload.uploadUrl),
  ].join(' ');
}

async function executeHostedParse(
  args: ParseToolArgs,
  session: SessionData | undefined,
  log: ToolLogger
): Promise<string> {
  const hasFilePath =
    typeof args.filePath === 'string' && args.filePath.length > 0;
  const hasUploadRef =
    typeof args.uploadRef === 'string' && args.uploadRef.length > 0;
  if (hasFilePath === hasUploadRef) {
    throw new Error(
      'Hosted firecrawl_parse requires exactly one of filePath or uploadRef.'
    );
  }

  if (!hasCredential(session) && !isKeylessMode(session)) {
    return asText({
      success: false,
      mode: 'hosted-upload-ref-auth-required',
      message:
        'Hosted firecrawl_parse requires an authenticated Firecrawl session or keyless eligibility before a local file upload URL can be minted. Connect a Firecrawl account, provide an API key, or use keyless hosted MCP while eligible, then call firecrawl_parse again.',
    });
  }

  if (isHostedKeylessSession(session) && args.zeroDataRetention === true) {
    const payload = {
      ...recoveryPayload('KEYLESS_OPTION_NOT_AVAILABLE', session?.requestId),
      option: 'zeroDataRetention',
      message:
        'Zero Data Retention is not available in anonymous keyless mode. Omit zeroDataRetention to parse with keyless access, or configure an API key for a team where Zero Data Retention is enabled, then retry.',
    };
    throw new UserError(String(payload.message), payload);
  }

  const options = extractParseOptions(args);

  if (hasFilePath && args.filePath) {
    const filename = path.basename(args.filePath);
    const contentType =
      typeof args.contentType === 'string' && args.contentType.length > 0
        ? args.contentType
        : inferContentType(filename);
    const uploadRequest = removeEmptyTopLevel({
      filename,
      contentType,
      declaredSizeBytes: args.declaredSizeBytes,
    }) as Record<string, unknown>;

    log.info('Creating hosted parse upload URL', { filename, contentType });
    const uploadJson = await apiPostJsonForSession(
      '/v2/parse/upload-url',
      uploadRequest,
      session
    );
    const upload = parseApiData(uploadJson) as ParseUploadUrlData;
    if (!upload?.uploadUrl || !upload?.uploadRef) {
      throw new Error(
        'Firecrawl upload-url response did not include uploadUrl and uploadRef'
      );
    }
    const uploadHeaders =
      upload.headers && Object.keys(upload.headers).length > 0
        ? upload.headers
        : (upload.method ?? 'PUT').toUpperCase() === 'POST'
          ? {}
          : { 'Content-Type': contentType };
    const uploadForCommand = { ...upload, headers: uploadHeaders };

    return asText({
      success: true,
      mode: 'hosted-upload-ref-awaiting-upload',
      message:
        'Hosted MCP cannot read local files. Run the local upload command, then call firecrawl_parse again with uploadRef. No Firecrawl API key is included in this command.',
      upload: {
        command: buildCurlUploadCommand(args.filePath, uploadForCommand),
        method: upload.method ?? 'PUT',
        headers: uploadHeaders,
        fields: upload.fields,
        uploadUrl: upload.uploadUrl,
        uploadRef: upload.uploadRef,
        expiresAt: upload.expiresAt,
        maxSizeBytes: upload.maxSizeBytes,
      },
      nextToolCall: {
        name: 'firecrawl_parse',
        arguments: buildContinuationArguments(upload.uploadRef, options),
      },
      notes: [
        'Run the curl command on the machine that can read filePath.',
        'After the PUT succeeds, use nextToolCall as the second MCP tool call.',
        'Clients without a local upload mechanism cannot complete hosted parse for local files.',
      ],
    });
  }

  const parsePayload = {
    uploadRef: args.uploadRef as string,
    ...buildParseOptionsPayload(options),
  };
  log.info('Parsing hosted upload reference');
  const parseJson = await apiPostJsonForSession(
    '/v2/parse',
    parsePayload,
    session
  );
  return asText(parseJson);
}

server.addTool({
  name: 'firecrawl_scrape',
  annotations: {
    title: 'Scrape a URL',
    readOnlyHint: SAFE_MODE, // Fetches page content only; in cloud/safe mode interactive browser actions are disabled.
    openWorldHint: true, // Accepts any user-supplied URL on the public web.
    destructiveHint: false, // Does not modify, delete, or write to external websites.
  },
  description: `
Retrieve and extract content from one supplied URL through Firecrawl. Use this when the request identifies a page and needs its content or defined fields. It can return markdown, HTML, links, screenshots, branding data, a targeted answer, or JSON matching a supplied schema; JSON is useful when the requested result has defined fields, while markdown preserves readable page content.

This tool operates on a known page. For a set of pages use \`firecrawl_crawl\`, and to discover page URLs use \`firecrawl_map\` or \`firecrawl_search\`. Options include JavaScript render delay, cache age, main-content filtering, PII redaction, and lockdown cache-only retrieval. Browser actions may change the live page when interactive actions are enabled.

Firecrawl may reuse recently indexed content instead of refetching the page, and the reuse window varies by domain. Set \`maxAge: 0\` to force a live fetch, or a smaller \`maxAge\` to bound how stale reused content may be. A successful response does not by itself confirm that the state it describes is still current.

Returns the selected content formats and page metadata.

Alexandria mode: pass \`alexandria\` (one \`{provider, capability, options}\` object or an array of 1-10) instead of \`url\` to execute catalogued Firecrawl Exchange capabilities found through \`firecrawl_search\` sources \`alexandria\` or \`firecrawl_exchange_discover\`. The optional requestId identifies one logical execution: reuse the returned ID for retries of the identical payload, never a new ID to bypass pending or uncertain execution. Only timeout also applies in this mode. Returns \`{ success, scrape_id, data: { alexandria: [...], creditsCost } }\` where each item is a per-capability result (\`data\`, \`records\`, \`creditsCost\`) or an \`error\` with a code; \`data.creditsCost\` is the sum of the successful items. Exchange needs an API key on a team with Exchange access.

URL mode only: set \`domainTools: true\` to also return domain-matched Alexandria tools for the page in \`data.tools\`.

Alexandria execution errors relay a \`code\` and \`chargeId\`: \`request_in_flight\` (409) retry the same requestId later; \`request_unresolved\` (503) keep the requestId for reconciliation, never mint a new one; \`duplicate_request\` (409) the requestId belongs to a different payload; \`unknown_provider\` (404), \`insufficient_credits\` (402), and \`billing_unavailable\` (503) mean nothing executed. A terms-gated Alexandria provider returns \`THIRD_PARTY_DATA_TERMS_REQUIRED\` (403) with \`requiresAction.url\`: a human organization admin must visit that URL and accept the terms before the identical call can succeed; this tool cannot accept them.
`,
  parameters: scrapeToolParamsSchema,
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const {
      url,
      alexandria,
      requestId: suppliedRequestId,
      ...options
    } = args as {
      requestId?: string;
      url?: string;
      alexandria?: z.infer<typeof exchangeCallSchema> | z.infer<typeof exchangeCallsSchema>;
    } & Record<string, unknown>;
    if (alexandria) {
      assertExchangeCredential(session);
      log.info('Executing Exchange capabilities', {
        count: Array.isArray(alexandria) ? alexandria.length : 1,
      });
      return executeExchangeCalls(session, alexandria, suppliedRequestId, options.timeout as number | undefined);
    }
    const transformed = transformScrapeParams(
      options as Record<string, unknown>
    );
    const cleaned = removeEmptyTopLevel(transformed);
    if (cleaned.lockdown) {
      log.info('Scraping URL (lockdown)');
    } else {
      log.info('Scraping URL', { url: String(url) });
    }
    if (isKeylessMode(session)) {
      const json = await keylessPost(
        '/v2/scrape',
        {
          url: String(url),
          ...cleaned,
          origin: ORIGIN,
        },
        session
      );
      return asText(json?.data ?? json);
    }
    const client = getClient(session);
    const res = await relayTermsRequired(
      () =>
        client.scrape(String(url), {
          ...cleaned,
          origin: ORIGIN,
        } as any),
      { tool: 'firecrawl_scrape', requestId: session?.requestId }
    );
    return asText(res);
  },
});

server.addTool({
  name: 'firecrawl_map',
  annotations: {
    title: 'Map a website',
    readOnlyHint: true, // Discovers and returns indexed URLs; does not modify the target site.
    openWorldHint: true, // Operates against arbitrary user-supplied web domains.
    destructiveHint: false, // Read-only discovery; no deletion or destructive updates.
  },
  description: `
Enumerate URLs indexed under one website through Firecrawl without fetching each page's content. Use this when the request asks for a site's URL inventory, when several relevant pages must be located, or when the desired page URL is unknown. An optional \`search\` term narrows the URL list, while sitemap, subdomain, query-parameter, and result-limit options control coverage.

Returns matching URLs rather than page bodies. Retrieve one page with \`firecrawl_scrape\`; collect content across multiple pages with \`firecrawl_crawl\`.
`,
  parameters: z.object({
    url: z.string().url(),
    search: z.string().optional(),
    sitemap: z.enum(['include', 'skip', 'only']).optional(),
    includeSubdomains: z.boolean().optional(),
    limit: z.number().optional(),
    ignoreQueryParameters: z.boolean().optional(),
  }),
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const { url, ...options } = args as { url: string } & Record<
      string,
      unknown
    >;
    const client = getClient(session);
    const cleaned = removeEmptyTopLevel(options as Record<string, unknown>);
    log.info('Mapping URL', { url: String(url) });
    const res = await client.map(String(url), {
      ...cleaned,
      origin: ORIGIN,
    } as any);
    return asText(res);
  },
});

server.addTool({
  name: 'firecrawl_search',
  annotations: {
    title: 'Search the web',
    readOnlyHint: true, // Runs a web search and returns results; does not modify external sites.
    openWorldHint: true, // Searches the open web across arbitrary domains and sources.
    destructiveHint: false, // Query-only; no destructive side effects on external entities.
  },
  description: `
Search web, news, or image sources and return ranked results. Operators include quoted phrases, \`-term\`, \`site:host\`, \`inurl:term\`, \`intitle:term\`, and \`related:host\`; the set is non-exhaustive. \`includeDomains\` and \`excludeDomains\` are mutually exclusive hostname filters; categories limit results to GitHub, research, PDF, or developer sources.

For a programming question, add \`categories: ["developer"]\`. It searches an index of repositories, GitHub issues, merged pull requests, repository READMEs, and curated documentation sites, and returns the hits in \`data.web\` with \`category: "developer"\`.

\`categories: ["research"]\` restricts these web results to research-affiliated websites and returns page snippets. The \`firecrawl_research_*\` tools are a separate surface that searches paper abstracts and full text across biomedical (PubMed, bioRxiv, medRxiv) and arXiv literature.

Each web result is a title, URL, and description, not the page. Add \`scrapeOptions\` to attach page content in the same call; those fetches ignore \`maxAge\`, so use \`firecrawl_scrape\` when you need a live fetch. Returns source-type result groups and usage metadata. Authenticated responses can include an \`id\` for optional search feedback.

${ALEXANDRIA_INSTRUCTIONS}
`,
  parameters: z
    .object({
      ...searchToolBaseFields,
      scrapeOptions: scrapeParamsSchema
        .omit({ url: true })
        .partial()
        .optional(),
    })
    .refine(searchDomainsAreExclusive, SEARCH_DOMAINS_CONFLICT_MESSAGE)
    .refine(
      searchQueryIsValid,
      'A query is required. Use Find Tools for catalogue lookup.'
    ),
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const { query, ...opts } = args as Record<string, unknown>;

    const searchOpts = {
      ...opts,
      sources: normalizeSearchSources(opts.sources),
    } as Record<string, unknown>;
    const includeDomains = searchOpts.includeDomains as string[] | undefined;
    const excludeDomains = searchOpts.excludeDomains as string[] | undefined;
    delete searchOpts.includeDomains;
    delete searchOpts.excludeDomains;

    if (searchOpts.scrapeOptions) {
      searchOpts.scrapeOptions = transformScrapeParams(
        searchOpts.scrapeOptions as Record<string, unknown>
      );
    }

    const cleaned = removeEmptyTopLevel(searchOpts);
    const searchQuery = buildSearchQueryWithDomains(
      (query as string | undefined) ?? '',
      includeDomains,
      excludeDomains
    );
    log.info('Searching', { query: searchQuery });
    const searchBody = {
      query: searchQuery,
      ...(cleaned as any),
      origin: ORIGIN,
    };
    const exchangeSource = hasAlexandria(searchBody.sources);
    if (exchangeSource || searchBody.domainTools)
      assertExchangeCredential(session);
    if (isKeylessMode(session)) {
      const json = await keylessPost('/v2/search', searchBody, session);
      // Search feedback requires an authenticated account. Do not expose its
      // identifier to keyless clients, where it would invite an unusable call.
      const keylessResponse = { ...(json ?? {}) };
      delete keylessResponse.id;
      return asText(keylessResponse);
    }
    // Call /v2/search through the SDK's HTTP layer (auth + retries) instead
    // of `client.search()` so we preserve the full response envelope. The
    // high-level `search()` helper strips `id` and `creditsUsed`, which
    // supports the optional authenticated `firecrawl_search_feedback` workflow.
    const client = getClient(session);
    const postSearch = () =>
      (client as any).http.post('/v2/search', searchBody);
    const context = { tool: 'firecrawl_search', requestId: session?.requestId };
    const httpRes = exchangeSource
      ? await relayExchangeError(postSearch, context)
      : await relayTermsRequired(postSearch, context);
    return asText(httpRes?.data ?? {});
  },
});

async function executeExchangeCalls(
  session: SessionData | undefined,
  alexandria:
    | z.infer<typeof exchangeCallSchema>
    | z.infer<typeof exchangeCallsSchema>,
  suppliedRequestId?: string,
  timeout?: number
): Promise<string> {
  assertExchangeCredential(session);
  const client = getClient(session);
  const requestId = suppliedRequestId ?? randomUUID();
  try {
    const response = await relayExchangeError(() =>
      (client as any).http.post(
        '/v2/scrape',
        {
          alexandria,
          origin: ORIGIN,
          ...(timeout !== undefined ? { timeout } : {}),
        },
        {
          headers: { 'x-request-id': requestId },
          ...(timeout !== undefined ? { timeoutMs: timeout + 5000 } : {}),
        }
      ),
      { tool: 'firecrawl_scrape', requestId }
    );
    return asText({ ...(response?.data ?? {}), requestId });
  } catch (error) {
    if ((error as any)?.response?.status === 401) throw error;
    throw new UserError(
      `${error instanceof Error ? error.message : String(error)} Request ID: ${requestId}. Reuse this ID only with the identical payload.`,
      { ...(error instanceof UserError ? error.extras : {}), requestId }
    );
  }
}

server.addTool({
  name: 'firecrawl_find_tools',
  annotations: {
    title: 'Find Tools',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  description:
    'Free contextual lookup and progressive disclosure of the Alexandria catalogue. Start with URLs or providers, then inspect groups, capabilities and contracts. Does not fetch supplied URLs or execute returned tools. Optional filters intersect; omitted level is inferred. data.alexandria[0].data contains items, total and next. Each next is an Exchange call: send it unchanged as firecrawl_scrape alexandria, or pass next.options to this tool. Top-level next paginates; item.next reveals more detail. To execute a selected tool, supply its provider, capability and contract-derived options to firecrawl_scrape. Use firecrawl_search sources ["alexandria"] for semantic discovery.',
  parameters: findToolsSchema,
  execute: async (options, { session }) =>
    executeExchangeCalls(session, {
      provider: 'firecrawl',
      capability: 'find-tools',
      options,
    }),
});

server.addTool({
  name: 'firecrawl_exchange_discover',
  annotations: {
    title: 'Discover Exchange capabilities',
    readOnlyHint: true, // Reads the Exchange catalogue; executes nothing.
    openWorldHint: false, // Bounded to Firecrawl's own provider catalogue.
    destructiveHint: false, // Catalogue read only.
  },
  description: `
Browse the Firecrawl Exchange catalogue of data providers and read capability contracts. Two modes: walk the catalogue by omitting \`q\` (no arguments lists cohorts; \`cohort\` lists its providers, with \`expand: "all"\` inlining their capabilities; \`cohort\` + \`provider\` lists that provider; \`cohort\` + \`provider\` + \`capability\` returns the full contract with \`options\`, \`returns\`, \`creditsCost\`, \`executable\`, and \`exampleQueries\`), or search semantically with \`q\` and optional \`limit\` on the index route, which returns \`capabilities\` (address, provider, cohorts, concept, creditsCost, similarity) without their contracts.

Legacy semantic hits carry no option schema, so walk to the capability address before executing it with \`firecrawl_scrape\` \`alexandria\`. Discovery costs nothing. Exchange needs an API key on a team with Exchange access; a 501 semantic_not_configured means the deployment has no semantic index.
`,
  parameters: exchangeDiscoverParamsSchema,
  execute: async (args: unknown, { session, log }): Promise<string> => {
    assertExchangeCredential(session);
    const pathName = buildExchangeDiscoverPath(args as ExchangeDiscoverArgs);
    log.info('Discovering Exchange capabilities', { path: pathName });
    const client = getClient(session);
    const httpRes = await relayExchangeError(
      () => (client as any).http.get(pathName, ORIGIN_HEADERS),
      { tool: 'firecrawl_exchange_discover', requestId: session?.requestId }
    );
    return asText(httpRes?.data ?? {});
  },
});

server.addTool({
  name: 'firecrawl_skills_resolve',
  annotations: {
    title: 'Find contextual tools',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description:
    'Find accessible tools mapped to query mentions or URLs from search and scrape. Uses provider-configured mappings, including podcast providers. Returns skill IDs; read their contracts with firecrawl_skill. Free catalogue lookup; executes no provider.',
  parameters: z
    .object({
      urls: z.array(z.string().url()).max(100).default([]),
      query: z.string().min(1).max(2000).optional(),
      context: z
        .enum(['search', 'scrape'])
        .optional()
        .describe('Which provider placement rules to apply; defaults to search.'),
    })
    .refine(
      (args) => args.urls.length > 0 || !!args.query,
      'Provide URLs or a query'
    ),
  execute: async (args, { session }): Promise<string> => {
    assertExchangeCredential(session);
    const response = await relayExchangeError(
      () =>
        (getClient(session) as any).http.post(
          '/exchange/skills/resolve',
          JSON.stringify(args),
          { headers: { 'Content-Type': 'application/json' } }
        ),
      { tool: 'firecrawl_skills_resolve', requestId: session?.requestId }
    );
    return asText(response?.data ?? {});
  },
});

server.addTool({
  name: 'firecrawl_skill',
  annotations: {
    title: 'Read a tool skill document',
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description:
    'Read the Markdown contract for a skill ID returned by firecrawl_skills_resolve or search skills. Free catalogue lookup; executes no provider.',
  parameters: z.object({
    id: z
      .string()
      .min(1)
      .refine((id) => id !== '.' && id !== '..', 'Invalid skill ID'),
  }),
  execute: async ({ id }, { session }): Promise<string> => {
    assertExchangeCredential(session);
    const response = await relayExchangeError(
      () =>
        (getClient(session) as any).http.get(
          `/exchange/skills/${encodeURIComponent(id)}/SKILL.md`,
          ORIGIN_HEADERS
        ),
      { tool: 'firecrawl_skill', requestId: session?.requestId }
    );
    return typeof response?.data === 'string'
      ? response.data
      : asText(response?.data ?? {});
  },
});

const DEFAULT_CLOUD_API_URL = 'https://api.firecrawl.dev';

function resolveApiBaseUrl(): string {
  return (process.env.FIRECRAWL_API_URL || DEFAULT_CLOUD_API_URL).replace(
    /\/$/,
    ''
  );
}

// Keyless free tier: when no credential is configured and we're targeting the
// Firecrawl cloud (not self-hosted via FIRECRAWL_API_URL, not the multi-tenant
// CLOUD_SERVICE deployment), scrape and search are free, rate-limited per IP.
// The cloud only grants this when NO Authorization header is sent, so we bypass
// the SDK — which always attaches a Bearer header — and post directly.
/** Best-effort end-user client IP from the incoming MCP request headers. */
function extractClientIp(request?: {
  headers: IncomingHttpHeaders;
}): string | undefined {
  return extractSingleTrustedClientIp(request?.headers?.['x-forwarded-for']);
}

/**
 * Read-only keyless check. MCP tool failures are returned in-band, not as an
 * OAuth transport challenge, so preserve only the quota details needed for recovery.
 */
type KeylessEligibility = {
  eligible: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  unavailable?: boolean;
};

function keylessQuotaReason(reason: unknown): reason is 'requests' | 'credits' {
  return reason === 'requests' || reason === 'credits';
}

async function keylessEligible(clientIp: string): Promise<KeylessEligibility> {
  const secret = process.env.KEYLESS_PROXY_SECRET;
  if (!secret) return { eligible: false, unavailable: true };
  try {
    const response = await fetch(
      `${resolveApiBaseUrl()}/v2/keyless/eligibility`,
      {
        headers: {
          ...ORIGIN_HEADERS,
          'x-firecrawl-keyless-ip': clientIp,
          'x-firecrawl-keyless-secret': secret,
        },
      }
    );
    if (!response.ok) return { eligible: false, unavailable: true };
    const json: any = await response.json().catch(() => null);
    if (typeof json?.eligible !== 'boolean') {
      return { eligible: false, unavailable: true };
    }
    return {
      eligible: json?.eligible === true,
      ...(typeof json?.reason === 'string' ? { reason: json.reason } : {}),
      ...(Number.isFinite(json?.retryAfterSeconds) && json.retryAfterSeconds > 0
        ? { retryAfterSeconds: json.retryAfterSeconds }
        : {}),
    };
  } catch {
    return { eligible: false, unavailable: true };
  }
}
function isKeylessMode(session?: SessionData): boolean {
  if (hasCredential(session) || session?.credentialError) return false;
  if (process.env.CLOUD_SERVICE === 'true') {
    return session?.authType === 'keyless';
  }
  // Local/stdio against the cloud (not a self-hosted FIRECRAWL_API_URL).
  return !process.env.FIRECRAWL_API_URL;
}

async function keylessPost(
  path: string,
  body: Record<string, unknown>,
  session?: SessionData
): Promise<any> {
  if (isHostedKeylessSession(session)) {
    const eligibility = session?.keylessClientIp
      ? await keylessEligible(session.keylessClientIp)
      : { eligible: false };
    if (!eligibility.eligible) {
      const code = eligibility.unavailable
        ? 'KEYLESS_ELIGIBILITY_UNAVAILABLE'
        : keylessQuotaReason(eligibility.reason)
          ? 'KEYLESS_QUOTA_EXHAUSTED'
          : 'KEYLESS_ACCESS_NOT_AVAILABLE';
      const payload = recoveryPayload(code, session?.requestId, {
        retryAfterSeconds: eligibility.retryAfterSeconds,
      });
      throw new UserError(String(payload.message), payload);
    }
  }
  const headers: Record<string, string> = {
    ...ORIGIN_HEADERS,
    'Content-Type': 'application/json',
  };
  // Forward the real client IP (secret-authenticated) when proxying keyless
  // requests through the hosted MCP, so the API rate-limits per real IP.
  if (session?.keylessClientIp && process.env.KEYLESS_PROXY_SECRET) {
    headers['x-firecrawl-keyless-ip'] = session.keylessClientIp;
    headers['x-firecrawl-keyless-secret'] = process.env.KEYLESS_PROXY_SECRET;
  }
  const response = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (isKeylessMode(session) && response.status === 429) {
      // The API normally supplies requests|credits. Preserve a structured,
      // non-specific recovery payload during a skewed or legacy deployment.
      const code = keylessQuotaReason(json?.reason)
        ? 'KEYLESS_QUOTA_EXHAUSTED'
        : 'KEYLESS_LIMIT_REACHED';
      const payload = recoveryPayload(code, session?.requestId, {
        retryAfterSeconds:
          Number.isFinite(json?.retry_after_seconds) &&
          json.retry_after_seconds > 0
            ? json.retry_after_seconds
            : undefined,
      });
      throw new UserError(String(payload.message), payload);
    }
    const termsAction = termsRequiredAction(json);
    if (termsAction) {
      throw termsRequiredError(termsAction, {
        tool: path === '/v2/search' ? 'firecrawl_search' : 'firecrawl_scrape',
        requestId: session?.requestId,
      });
    }
    throw new Error(
      json?.error || `Firecrawl request failed (HTTP ${response.status})`
    );
  }
  return json;
}

async function getCrawlStatusWithOrigin(
  client: FirecrawlApp,
  jobId: string
): Promise<Record<string, unknown>> {
  const res = await (client as any).http.get(
    `/v2/crawl/${encodeURIComponent(jobId)}`,
    ORIGIN_HEADERS
  );
  const body = (res?.data ?? {}) as any;
  const initialDocs = Array.isArray(body.data) ? body.data : [];

  if (!body.next) {
    return {
      id: jobId,
      status: body.status,
      completed: body.completed ?? 0,
      total: body.total ?? 0,
      creditsUsed: body.creditsUsed,
      expiresAt: body.expiresAt,
      next: body.next ?? null,
      data: initialDocs,
    };
  }

  const docs = initialDocs.slice();
  let current = body.next as string | null;
  while (current) {
    const pageRes = await (client as any).http.get(current, ORIGIN_HEADERS);
    const payload = (pageRes?.data ?? {}) as any;
    if (!payload.success) break;

    const pageData = Array.isArray(payload.data)
      ? payload.data
      : payload.data?.pages || [];
    docs.push(...pageData);
    current =
      payload.next ??
      (Array.isArray(payload.data) ? null : payload.data?.next) ??
      null;
  }

  return {
    id: jobId,
    status: body.status,
    completed: body.completed ?? 0,
    total: body.total ?? 0,
    creditsUsed: body.creditsUsed,
    expiresAt: body.expiresAt,
    next: null,
    data: docs,
  };
}

async function waitForCrawlCompletionWithOrigin(
  client: FirecrawlApp,
  jobId: string,
  pollInterval = 2,
  timeout?: number
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  for (;;) {
    const status = await getCrawlStatusWithOrigin(client, jobId);
    if (
      ['completed', 'failed', 'cancelled'].includes(String(status.status ?? ''))
    ) {
      return status;
    }
    if (timeout != null && Date.now() - startedAt > timeout * 1000) {
      throw new Error(`Crawl job ${jobId} did not complete within ${timeout}s`);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1000, pollInterval * 1000))
    );
  }
}

const feedbackIssueSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'Issue codes must use lowercase letters, numbers, underscores, or hyphens'
  );

const valuableSourceSchema = z.object({
  url: z.string().url(),
  reason: z.string().max(1000).optional(),
});

const missingContentSchema = z.object({
  topic: z
    .string()
    .min(1, 'topic must not be empty')
    .max(200, 'topic must be 200 characters or fewer'),
  description: z.string().max(2000).optional(),
});

const FEEDBACK_DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

function feedbackEnvEnabled(...keys: string[]): boolean {
  return keys.some((key) =>
    FEEDBACK_DISABLED_VALUES.has((process.env[key] || '').trim().toLowerCase())
  );
}

const SEARCH_FEEDBACK_DISABLED = feedbackEnvEnabled(
  'FIRECRAWL_NO_SEARCH_FEEDBACK',
  'FIRECRAWL_DISABLE_SEARCH_FEEDBACK'
);

const ENDPOINT_FEEDBACK_DISABLED = feedbackEnvEnabled(
  'FIRECRAWL_NO_ENDPOINT_FEEDBACK',
  'FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK'
);

if (SEARCH_FEEDBACK_DISABLED) {
  console.error(
    '[firecrawl-mcp] Search feedback tool disabled by FIRECRAWL_NO_SEARCH_FEEDBACK; firecrawl_search_feedback will not be registered.'
  );
}

if (!SEARCH_FEEDBACK_DISABLED && !isLocalKeylessStartup()) {
  server.addTool({
    name: 'firecrawl_search_feedback',
    annotations: {
      title: 'Send feedback on a search result',
      readOnlyHint: false, // POSTs structured feedback to the API, creating a server-side record.
      openWorldHint: true, // Feedback references open-web search results and external URLs.
      destructiveHint: false, // Additive only; records feedback and may refund credits, does not delete data.
    },
    description: `
Records schema-validated quality feedback for a prior \`firecrawl_search\` UUID \`searchId\`. A \`good\` rating requires a valuable source, \`partial\` a valuable source or at least one \`missingContent\` entry, and \`bad\` at least one \`missingContent\` entry or a query suggestion; caps are 50 \`valuableSources\` and 20 \`missingContent\` entries.

Eligibility is limited to successful searches within the feedback age window. The record is idempotent per search ID. Eligible first feedback for a search can refund 1 credit; refunds are subject to the team's daily cap. The response reports whether a refund was applied, along with submission and daily-cap status.
`,
    parameters: z.object({
      searchId: z
        .string()
        .uuid('searchId must be the UUID returned by firecrawl_search'),
      rating: z.enum(['good', 'bad', 'partial']),
      valuableSources: z
        .array(
          z.object({
            url: z.string().url(),
            reason: z.string().max(1000).optional(),
          })
        )
        .max(50)
        .optional(),
      missingContent: z
        .array(
          z.object({
            topic: z
              .string()
              .min(1, 'topic must not be empty')
              .max(200, 'topic must be 200 characters or fewer'),
            description: z.string().max(2000).optional(),
          })
        )
        .max(20)
        .optional()
        .describe(
          'Array of specific pieces of content the agent expected to find but did not. ' +
            'One entry per distinct topic. Each entry has a short `topic` and optional ' +
            'longer `description`.'
        ),
      querySuggestions: z.string().max(2000).optional(),
    }),
    execute: async (args: unknown, { session, log }): Promise<string> => {
      const {
        searchId,
        rating,
        valuableSources,
        missingContent,
        querySuggestions,
      } = args as {
        searchId: string;
        rating: 'good' | 'bad' | 'partial';
        valuableSources?: { url: string; reason?: string }[];
        missingContent?: { topic: string; description?: string }[];
        querySuggestions?: string;
      };

      const apiBase = resolveApiBaseUrl();
      const endpoint = `${apiBase}/v2/search/${encodeURIComponent(
        searchId
      )}/feedback`;

      const body: Record<string, unknown> = {
        rating,
        origin: ORIGIN,
      };
      if (valuableSources && valuableSources.length > 0) {
        body.valuableSources = valuableSources;
      }
      if (missingContent && missingContent.length > 0) {
        body.missingContent = missingContent;
      }
      if (querySuggestions) body.querySuggestions = querySuggestions;

      const headers: Record<string, string> = {
        ...ORIGIN_HEADERS,
        'Content-Type': 'application/json',
      };
      const credential = credentialForOutboundRequest(session);
      if (credential) {
        headers['Authorization'] = `Bearer ${credential}`;
      } else if (process.env.CLOUD_SERVICE === 'true') {
        throw new Error('Unauthorized: missing API key for search feedback.');
      }

      log.info('Submitting search feedback', { searchId, rating });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = { raw: responseText };
      }

      // A 401 is Core's verdict on the forwarded API key, so let the shared
      // credential-recovery boundary turn it into CREDENTIAL_INVALID.
      if (session?.authType === 'api-key' && response.status === 401) {
        throw new CoreHttpError(
          parsed?.error ?? 'Unauthorized: invalid Firecrawl API key',
          response.status
        );
      }

      // Other 4xx responses are terminal; surface a structured payload (with
      // retryable=false) so agents do not retry-loop on substantive-feedback
      // rejections, expired windows, etc.
      if (!response.ok) {
        log.warn('Search feedback rejected', {
          status: response.status,
          feedbackErrorCode: parsed?.feedbackErrorCode,
        });
        return asText({
          success: false,
          status: response.status,
          feedbackErrorCode: parsed?.feedbackErrorCode,
          error: parsed?.error ?? `HTTP ${response.status}`,
          retryable: response.status >= 500,
        });
      }

      return asText(parsed);
    },
  });
}

if (ENDPOINT_FEEDBACK_DISABLED) {
  console.error(
    '[firecrawl-mcp] Endpoint feedback tool disabled by FIRECRAWL_NO_ENDPOINT_FEEDBACK; firecrawl_feedback will not be registered.'
  );
}

if (!ENDPOINT_FEEDBACK_DISABLED && !isLocalKeylessStartup()) {
  server.addTool({
    name: 'firecrawl_feedback',
    annotations: {
      title: 'Send feedback on a Firecrawl job',
      readOnlyHint: false, // POSTs structured feedback for a completed job to /v2/feedback.
      openWorldHint: true, // Feedback is tied to jobs that processed open-web URLs.
      destructiveHint: false, // Additive only; submits ratings and notes, does not delete jobs or external content.
    },
    description: `
Submit concise quality feedback for a completed search, scrape, parse, or map job. Provide the endpoint, job ID, rating, and relevant issue codes or small contextual fields; omit large page contents and raw outputs.

Returns submission status, feedback ID, and accounting fields.
`,
    parameters: z.object({
      endpoint: z.enum(['search', 'scrape', 'parse', 'map']),
      jobId: z.string().uuid('jobId must be the UUID returned by Firecrawl'),
      rating: z.enum(['good', 'bad', 'partial']),
      issues: z.array(feedbackIssueSchema).max(20).optional(),
      tags: z.array(feedbackIssueSchema).max(20).optional(),
      note: z.string().max(4000).optional(),
      valuableSources: z.array(valuableSourceSchema).max(50).optional(),
      missingContent: z.array(missingContentSchema).max(50).optional(),
      querySuggestions: z.string().max(2000).optional(),
      url: z.string().url().optional(),
      pageNumbers: z.array(z.number().int().positive()).max(100).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    execute: async (args: unknown, { session, log }): Promise<string> => {
      const {
        endpoint,
        jobId,
        rating,
        issues,
        tags,
        note,
        valuableSources,
        missingContent,
        querySuggestions,
        url,
        pageNumbers,
        metadata,
      } = args as {
        endpoint: 'search' | 'scrape' | 'parse' | 'map';
        jobId: string;
        rating: 'good' | 'bad' | 'partial';
        issues?: string[];
        tags?: string[];
        note?: string;
        valuableSources?: { url: string; reason?: string }[];
        missingContent?: { topic: string; description?: string }[];
        querySuggestions?: string;
        url?: string;
        pageNumbers?: number[];
        metadata?: Record<string, unknown>;
      };

      const apiBase = resolveApiBaseUrl();
      const headers: Record<string, string> = {
        ...ORIGIN_HEADERS,
        'Content-Type': 'application/json',
      };
      const credential = credentialForOutboundRequest(session);
      if (credential) {
        headers['Authorization'] = `Bearer ${credential}`;
      } else if (process.env.CLOUD_SERVICE === 'true') {
        throw new Error('Unauthorized: missing API key for feedback.');
      }

      const body = removeEmptyTopLevel({
        endpoint,
        jobId,
        rating,
        issues,
        tags,
        note,
        valuableSources,
        missingContent,
        querySuggestions,
        url,
        pageNumbers,
        metadata,
        origin: ORIGIN,
      });

      log.info('Submitting endpoint feedback', { endpoint, jobId, rating });
      const response = await fetch(`${apiBase}/v2/feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = { raw: responseText };
      }

      // A 401 is Core's verdict on the forwarded API key, so let the shared
      // credential-recovery boundary turn it into CREDENTIAL_INVALID.
      if (session?.authType === 'api-key' && response.status === 401) {
        throw new CoreHttpError(
          parsed?.error ?? 'Unauthorized: invalid Firecrawl API key',
          response.status
        );
      }

      if (!response.ok) {
        log.warn('Endpoint feedback rejected', {
          status: response.status,
          feedbackErrorCode: parsed?.feedbackErrorCode,
        });
        return asText({
          success: false,
          status: response.status,
          feedbackErrorCode: parsed?.feedbackErrorCode,
          error: parsed?.error ?? `HTTP ${response.status}`,
          retryable: response.status >= 500,
        });
      }

      return asText(parsed);
    },
  });
}

server.addTool({
  name: 'firecrawl_crawl',
  annotations: {
    title: 'Run a site crawl',
    readOnlyHint: false, // Starts a server-side crawl job and polls until the job reaches a terminal state.
    openWorldHint: true, // Crawls user-specified URLs across the public web.
    destructiveHint: false, // Reads pages from target sites; does not delete or alter external websites.
  },
  description: `
Start a multi-page crawl at a website URL, poll it to a terminal state, and return the final status and collected data. Scope can be bounded with include/exclude paths, depth, page limit, subdomain/external-link controls, sitemap handling, delay, and scrape options.

Crawl results can be large; use conservative limits when full-site coverage is unnecessary. Webhooks and interactive scrape actions are unavailable in safe mode. Returns the crawl ID, status, and page data.
`,
  parameters: z.object({
    url: z.string(),
    prompt: z.string().optional(),
    excludePaths: z.array(z.string()).optional(),
    includePaths: z.array(z.string()).optional(),
    maxDiscoveryDepth: z.number().optional(),
    sitemap: z.enum(['skip', 'include', 'only']).optional(),
    limit: z.number().optional(),
    allowExternalLinks: z.boolean().optional(),
    allowSubdomains: z.boolean().optional(),
    crawlEntireDomain: z.boolean().optional(),
    delay: z.number().optional(),
    maxConcurrency: z.number().optional(),
    ...(SAFE_MODE
      ? {}
      : {
          webhook: z.string().optional(),
          webhookHeaders: z.record(z.string(), z.string()).optional(),
        }),
    deduplicateSimilarURLs: z.boolean().optional(),
    ignoreQueryParameters: z.boolean().optional(),
    scrapeOptions: scrapeParamsSchema.omit({ url: true }).partial().optional(),
  }),
  execute: async (args, { session, log }) => {
    const { url, ...options } = args as Record<string, unknown>;
    const client = getClient(session);

    const opts = { ...options } as Record<string, unknown>;
    if (opts.scrapeOptions) {
      opts.scrapeOptions = transformScrapeParams(
        opts.scrapeOptions as Record<string, unknown>
      );
    }

    const webhook = buildWebhook(opts);
    if (webhook) opts.webhook = webhook;
    delete opts.webhookHeaders;

    const cleaned = removeEmptyTopLevel(opts);
    const pollInterval =
      typeof cleaned.pollInterval === 'number'
        ? (cleaned.pollInterval as number)
        : 2;
    const timeout =
      typeof cleaned.timeout === 'number'
        ? (cleaned.timeout as number)
        : undefined;
    delete (cleaned as Record<string, unknown>).pollInterval;
    delete (cleaned as Record<string, unknown>).timeout;

    log.info('Starting crawl', { url: String(url) });
    const started = await (client as any).http.post('/v2/crawl', {
      url: String(url),
      ...(cleaned as Record<string, unknown>),
      origin: ORIGIN,
    });
    const crawlId = started?.data?.id;
    if (!crawlId) {
      return asText(started?.data ?? {});
    }
    const res = await waitForCrawlCompletionWithOrigin(
      client,
      crawlId,
      pollInterval,
      timeout
    );
    return asText(res);
  },
});

server.addTool({
  name: 'firecrawl_check_crawl_status',
  annotations: {
    title: 'Get crawl status',
    readOnlyHint: true, // Retrieves status and results for an existing crawl job by ID; no mutations.
    openWorldHint: false, // Queries only Firecrawl job state within the authenticated account.
    destructiveHint: false, // Status lookup only; no deletes or updates.
  },
  description: `
Retrieve the current status, progress, and available results for an existing crawl ID. This only reads Firecrawl job state and does not start or modify the crawl.
`,
  parameters: z.object({ id: z.string() }),
  execute: async (
    args: unknown,
    { session }: { session?: SessionData }
  ): Promise<string> => {
    const client = getClient(session);
    const id = (args as any).id as string;
    const res = await getCrawlStatusWithOrigin(client, id);
    return asText(res);
  },
});

server.addTool({
  name: 'firecrawl_extract',
  annotations: {
    title: 'Deprecated: use Scrape JSON',
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Deprecated compatibility entry point. Use firecrawl_scrape once per known URL with formats: ["json"] and jsonOptions containing the prompt and schema. Use firecrawl_agent for multi-source research when the URLs are not known or the data spans several sites.
`,
  parameters: z.object({
    urls: z.array(z.string()),
    prompt: z.string().optional(),
    schema: z.record(z.string(), z.any()).optional(),
    allowExternalLinks: z.boolean().optional(),
    enableWebSearch: z.boolean().optional(),
    includeSubdomains: z.boolean().optional(),
  }),
  canList: () => false,
  beforeValidate: () => {
    const payload = deprecatedExtractPayload();
    return {
      content: [{ type: 'text' as const, text: payload.message }],
      isError: true,
      structuredContent: payload,
    };
  },
  execute: async (): Promise<string> => {
    const payload = deprecatedExtractPayload();
    throw new UserError(payload.message, payload);
  },
});

server.addTool({
  name: 'firecrawl_agent',
  annotations: {
    title: 'Start a research agent',
    readOnlyHint: false, // Starts an autonomous research agent job on the Firecrawl API.
    openWorldHint: true, // The agent browses and searches the open web to fulfill the prompt.
    destructiveHint: false, // Gathers information only; does not delete external data or user resources.
  },
  description: `
Run web research that returns structured data when the URLs are not known or the answer spans several sites. Describe the fields you need in \`prompt\`, optionally pass a JSON \`schema\` and seed \`urls\`, and the research agent searches, navigates, reads pages, and returns JSON assembled across sources. Use it to research an entity plus its fields (founders, pricing, contact details), to build lists and datasets (companies, people, products, jobs, papers), and for pages that need navigation or interaction to reach the data.

This call returns only a job ID, not the research result. Read the job with \`firecrawl_agent_status\` until it reaches \`completed\` or \`failed\`; a typical research run takes one to three minutes. For one known URL use \`firecrawl_scrape\` (with formats: ["json"] for structured output); for a plain lookup that a results page answers, use \`firecrawl_search\`.
`,
  parameters: z.object({
    prompt: z.string().min(1).max(10000),
    urls: z.array(z.string().url()).optional(),
    schema: z.record(z.string(), z.any()).optional(),
  }),
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const client = getClient(session);
    const a = args as Record<string, unknown>;
    log.info('Starting agent', {
      prompt: (a.prompt as string).substring(0, 100),
      urlCount: Array.isArray(a.urls) ? a.urls.length : 0,
    });
    const agentBody = removeEmptyTopLevel({
      prompt: a.prompt as string,
      urls: a.urls as string[] | undefined,
      schema: (a.schema as Record<string, unknown>) || undefined,
    });
    const res = await (client as any).startAgent({
      ...agentBody,
      origin: ORIGIN,
    });
    return asText(res);
  },
});

server.addTool({
  name: 'firecrawl_agent_status',
  annotations: {
    title: 'Get agent job status',
    readOnlyHint: true, // Polls an existing agent job by ID for progress and results; no mutations.
    openWorldHint: false, // Queries only Firecrawl job state by job ID within the user's account.
    destructiveHint: false, // Read-only status check.
  },
  description: `
Retrieve progress or final results for a \`firecrawl_agent\` job ID. A \`processing\` response is non-terminal and does not contain the final research result. Check again after 15–30 seconds until the status is \`completed\` or \`failed\`; a typical research run takes one to three minutes and complex jobs can take longer. If the job cannot finish within the task's available time, use \`firecrawl_search\` and \`firecrawl_scrape\` to complete the requested output.

Returns job status, progress information, and result data when completed.
`,
  parameters: z.object({ id: z.string() }),
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const client = getClient(session);
    const { id } = args as { id: string };
    log.info('Checking agent status', { id });
    const res = await (client as any).http.get(
      `/v2/agent/${encodeURIComponent(id)}`,
      ORIGIN_HEADERS
    );
    return asText(res?.data ?? {});
  },
});

// Interact tools (scrape-bound browser sessions)
server.addTool({
  name: 'firecrawl_interact',
  annotations: {
    title: 'Interact with a scraped page',
    readOnlyHint: false, // Executes browser interactions (clicks, form input, scripts) in a live session.
    openWorldHint: true, // Interacts with pages on the public web via the scraped session.
    destructiveHint: false, // Transient page interactions only; does not delete monitors, jobs, or external sites.
  },
  description: `
Open or reuse a live browser session to navigate a page, click controls, fill fields, or run browser code. Provide either \`url\` or \`scrapeId\`, and either a natural-language \`prompt\` or executable \`code\`; code can run as Bash, Python, or Node with a bounded timeout.

This acts on the live site, so actions such as form submission can create persistent external side effects. Returns execution output, stdout/stderr, exit status, and session viewing URLs.
`,
  parameters: z
    .object({
      scrapeId: z.string().trim().min(1).optional(),
      url: z.string().trim().url().optional(),
      prompt: z.string().trim().min(1).optional(),
      code: z.string().trim().min(1).optional(),
      language: z.enum(['bash', 'python', 'node']).optional(),
      timeout: z.number().min(1).max(300).optional(),
      scrapeOptions: scrapeParamsSchema.omit({ url: true }).partial().optional(),
    })
    .refine((data) => Boolean(data.scrapeId) !== Boolean(data.url), {
      message:
        "Provide either 'url' (interact directly) or 'scrapeId' (reuse a previous scrape), not both.",
    })
    .refine((data) => !data.scrapeOptions || Boolean(data.url), {
      message: "scrapeOptions can only be used with 'url' mode.",
    })
    .refine((data) => data.code || data.prompt, {
      message: "Either 'code' or 'prompt' must be provided.",
    }),
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const client = getClient(session);
    const {
      scrapeId: providedScrapeId,
      url,
      prompt,
      code,
      language,
      timeout,
      scrapeOptions,
    } = args as {
      scrapeId?: string;
      url?: string;
      prompt?: string;
      code?: string;
      language?: 'bash' | 'python' | 'node';
      timeout?: number;
      scrapeOptions?: Record<string, unknown>;
    };
    // No scrapeId means the caller passed a url: scrape it first to open the
    // session, then interact. One tool call instead of scrape + interact.
    let scrapeId = providedScrapeId;
    const openedFromUrl = !scrapeId;
    if (openedFromUrl) {
      log.info('Opening interact session from url', { url });
      const cleanedScrapeOptions = removeEmptyTopLevel(scrapeOptions ?? {});
      const scraped = await relayTermsRequired(
        () =>
          client.scrape(String(url), {
            ...cleanedScrapeOptions,
            origin: ORIGIN,
          } as any),
        { tool: 'firecrawl_interact', requestId: session?.requestId }
      );
      scrapeId = (scraped as any)?.metadata?.scrapeId;
      if (!scrapeId) {
        return asText({
          error:
            'Could not open an interact session: the scrape did not return a scrapeId. Try firecrawl_scrape first, then pass its scrapeId.',
          url,
        });
      }
    }
    if (!scrapeId) {
      return asText({
        error: 'Could not open an interact session: missing scrapeId.',
        url,
      });
    }
    const activeScrapeId = scrapeId;
    log.info('Interacting with page', { scrapeId: activeScrapeId });
    const interactArgs: Record<string, unknown> = { origin: ORIGIN };
    if (prompt) interactArgs.prompt = prompt;
    if (code) interactArgs.code = code;
    if (language) interactArgs.language = language;
    if (timeout != null) interactArgs.timeout = timeout;
    const res = await client.interact(activeScrapeId, interactArgs as any);
    if (openedFromUrl && res && typeof res === 'object' && !Array.isArray(res)) {
      return asText({
        ...(res as unknown as Record<string, unknown>),
        scrapeId: activeScrapeId,
      });
    }
    if (openedFromUrl) {
      return asText({ scrapeId: activeScrapeId, result: res });
    }
    return asText(res);
  },
});

server.addTool({
  name: 'firecrawl_interact_stop',
  annotations: {
    title: 'Stop interact session',
    readOnlyHint: false, // Calls the API to stop and tear down an active interact session.
    openWorldHint: false, // Operates only on a known Firecrawl scrape/interact session ID.
    destructiveHint: true, // Terminates the live browser session; this end state cannot be resumed.
  },
  description: `
Stop the live interact session associated with a \`scrapeId\` and release its resources. Returns a success confirmation.
`,
  parameters: z.object({
    scrapeId: z.string(),
  }),
  execute: async (args: unknown, { session, log }): Promise<string> => {
    const client = getClient(session);
    const { scrapeId } = args as { scrapeId: string };
    log.info('Stopping interact session', { scrapeId });
    const res = await (client as any).http.delete(
      `/v2/scrape/${encodeURIComponent(scrapeId)}/interact`,
      ORIGIN_HEADERS
    );
    return asText(res?.data ?? {});
  },
});

// Parse a local file directly in non-cloud mode, or orchestrate a hosted two-call
// uploadRef flow in CLOUD_SERVICE mode without reading the caller's filesystem.
server.addTool({
  name: 'firecrawl_parse',
  annotations: {
    title: 'Parse a local file',
    readOnlyHint: true, // Local mode reads a file; hosted mode only returns upload instructions or parses an uploadRef.
    openWorldHint: false, // Operates on a local filesystem path/upload reference, not an arbitrary web URL.
    destructiveHint: false, // Read-only parsing; no deletion or writes to the source file.
  },
  description: `
Parse one supported document into markdown, HTML, links, summary, targeted answers, or JSON matching a schema. Supported inputs include common HTML, PDF, Word, RTF, OpenDocument, and spreadsheet files; PDF parsing can be bounded with \`pdfOptions.maxPages\`.

Local MCP reads \`filePath\` from the server filesystem. Hosted MCP uses two calls: first provide \`filePath\` to receive upload instructions, upload locally, then call again with the returned \`uploadRef\`; do not send both fields together. Remote web URLs belong in \`firecrawl_scrape\`.

Set \`redactPII\` to request redaction of personally identifiable information in the returned content. \`zeroDataRetention\` requires an eligible authenticated account; omit it for anonymous keyless use. Returns upload instructions for hosted phase one or parsed document content for the final call.
`,
  parameters: parseParamsSchema,
  execute: async (args: unknown, { session, log }): Promise<string> => {
    if (process.env.CLOUD_SERVICE === 'true') {
      return executeHostedParse(args as ParseToolArgs, session, log);
    }

    const apiUrl = process.env.FIRECRAWL_API_URL;
    if (!apiUrl) {
      throw new Error(
        'firecrawl_parse requires FIRECRAWL_API_URL to be set to a self-hosted Firecrawl API instance.'
      );
    }

    const {
      filePath,
      contentType: overrideContentType,
      ...options
    } = args as {
      filePath: string;
      contentType?: string;
    } & Record<string, unknown>;

    const absPath = path.resolve(filePath);
    const buffer = await readFile(absPath);
    const filename = path.basename(absPath);
    const fileContentType =
      overrideContentType && overrideContentType.length > 0
        ? overrideContentType
        : inferContentType(filename);

    const optionsPayload = buildParseOptionsPayload(
      options as Record<string, unknown>
    );

    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], {
      type: fileContentType,
    });
    form.append('file', blob, filename);
    form.append('options', JSON.stringify(optionsPayload));

    const headers: Record<string, string> = { ...ORIGIN_HEADERS };
    const credential = credentialForOutboundRequest(session);
    if (credential) {
      headers['Authorization'] = `Bearer ${credential}`;
    }

    const endpoint = `${apiUrl.replace(/\/$/, '')}/v2/parse`;
    log.info('Parsing local file', {
      endpoint,
      filename,
      size: buffer.length,
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: form,
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Parse request failed with status ${response.status}: ${responseText}`
      );
    }

    try {
      return asText(JSON.parse(responseText));
    } catch {
      return responseText;
    }
  },
});

// Search-surface variant of firecrawl_search. It takes no scrapeOptions and
// builds the outbound /v2/search body from an explicit set of fields, so the
// surface never asks the API to fetch page content. The omission is enforced
// by the schema and the body construction, not a runtime filter.
function registerMarketplaceSearchTool(
  registrar: ToolRegistrar,
  getClientFn: typeof getClient
): void {
  registrar.addTool({
    name: 'firecrawl_search',
    annotations: {
      title: 'Search the web',
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
    description: `
Search web and specialized indexes, returning ranked results. Each web result is a title, URL, and description, not the page. Operators include quoted phrases, \`-term\`, \`site:host\`, \`inurl:term\`, \`intitle:term\`, and \`related:host\`; the set is non-exhaustive. \`includeDomains\` and \`excludeDomains\` are mutually exclusive hostname filters; categories limit result types to \`github\`, \`research\`, \`pdf\`, or \`developer\`.

For a programming question, add \`categories: ["developer"]\`. It searches an index of repositories, GitHub issues, merged pull requests, repository READMEs, and curated documentation sites, and returns the hits in \`data.web\` with \`category: "developer"\`.

\`sources: ["alexandria"]\` returns complete tool contracts in \`data.tools\`. \`domainTools: true\` adds domain-matched contracts to that array. Read warning when discovery is unavailable.

Returns \`{ success, data, id, creditsUsed }\`, with source arrays in \`data\`.
`,
    parameters: z
      .object({ ...searchToolBaseFields })
      // Reject unknown fields (notably scrapeOptions): this surface exposes no
      // way to request page-content fetching, and an unexpected field is an
      // error rather than being silently dropped.
      .strict()
      .refine(searchDomainsAreExclusive, SEARCH_DOMAINS_CONFLICT_MESSAGE)
      .refine(
        searchQueryIsValid,
        'A query is required. Use Find Tools for catalogue lookup.'
      ),
    execute: async (args: unknown, { session, log }): Promise<string> => {
      const {
        query,
        includeDomains,
        excludeDomains,
        limit,
        tbs,
        filter,
        location,
        sources,
        categories,
        highlights,
        enterprise,
        domainTools,
      } = args as {
        query?: string;
        domainTools?: boolean;
        includeDomains?: string[];
        excludeDomains?: string[];
        limit?: number;
        tbs?: string;
        filter?: string;
        location?: string;
        sources?: Array<string | { type: string }>;
        categories?: string[];
        highlights?: boolean;
        enterprise?: string[];
      };

      const searchQuery = buildSearchQueryWithDomains(
        query ?? '',
        includeDomains,
        excludeDomains
      );

      // Build the outbound body from allowed fields only. Never spread the raw
      // arguments, so no scrape/content-fetch options can reach the API.
      const searchBody = {
        query: searchQuery,
        ...removeEmptyTopLevel({
          limit,
          tbs,
          filter,
          location,
          sources: normalizeSearchSources(sources),
          categories,
          highlights,
          enterprise,
          domainTools,
        }),
        origin: ORIGIN,
      };

      log.info('Searching', { query: searchQuery });
      const exchangeSource = hasAlexandria(sources);
      if (exchangeSource || searchBody.domainTools)
        assertExchangeCredential(session);
      const client = getClientFn(session);
      const postSearch = () =>
        (client as any).http.post('/v2/search', searchBody);
      const context = { tool: 'firecrawl_search', requestId: session?.requestId };
      const httpRes = exchangeSource
        ? await relayExchangeError(postSearch, context)
        : await relayTermsRequired(postSearch, context);
      return asText(httpRes?.data ?? {});
    },
  });
}

const PORT = Number(process.env.PORT || 3000);
const HOST =
  process.env.CLOUD_SERVICE === 'true'
    ? '0.0.0.0'
    : process.env.HOST || 'localhost';
type StartArgs = Parameters<typeof server.start>[0];
let args: StartArgs;

if (
  process.env.CLOUD_SERVICE === 'true' ||
  process.env.SSE_LOCAL === 'true' ||
  process.env.HTTP_STREAMABLE_SERVER === 'true'
) {
  args = {
    transportType: 'httpStream',
    httpStream: {
      port: PORT,
      host: HOST,
      endpoint: primaryProfile.endpoint,
      stateless: true,
    },
  };
} else {
  // default: stdio
  args = {
    transportType: 'stdio',
  };
}

registerMonitorTools(server);
registerResearchTools(server, getClient);
registerDeveloperTools(server, getClient);

if (
  process.env.CLOUD_SERVICE === 'true' &&
  primaryProfile.allowKeyless &&
  !normalizeHeader(process.env.KEYLESS_PROXY_SECRET)
) {
  console.warn(
    '[firecrawl-mcp] KEYLESS_PROXY_SECRET is missing; keyless requests will be unavailable and /ready will fail.'
  );
}

if (primaryProfile.id === 'search') {
  // The strict marketplace search tool intentionally replaces the full
  // surface's same-named registration above. Register through the original
  // bound method so the name-level guard cannot suppress this replacement.
  const primarySearchRegistrar: ToolRegistrar = {
    addTool: ((tool: { name: string }) => {
      if (primaryProfile.toolAllowlist?.has(tool.name)) {
        addTool(guardHostedTool(tool as RegisteredTool, { logActions: false }));
      }
    }) as FastMCP<SessionData>['addTool'],
  };
  registerMarketplaceSearchTool(primarySearchRegistrar, getClient);
}

await server.start(args);

// Bring up the search surface as a second in-process instance on its own port.
// The pod's nginx routes its public path here; the full surface above is
// untouched. Only registered in the hosted profile and when not disabled.
const searchProfileEnabled =
  process.env.CLOUD_SERVICE === 'true' &&
  primaryProfile.id === 'full' &&
  process.env.FIRECRAWL_MCP_SEARCH_ENABLED !== 'false';

if (searchProfileEnabled) {
  const searchProfile = makeSearchProfile();
  const searchServer = createServer(searchProfile);

  // Fail-closed registrar: only allowlisted tool names ever register here.
  const searchRegistrar: ToolRegistrar = {
    addTool: ((tool: { name: string }) => {
      if (searchProfile.toolAllowlist?.has(tool.name)) {
        searchServer.addTool(
          guardHostedTool(tool as RegisteredTool, { logActions: false })
        );
      }
    }) as FastMCP<SessionData>['addTool'],
  };

  registerResearchTools(searchRegistrar, getClient);
  registerDeveloperTools(searchRegistrar, getClient);
  registerMarketplaceSearchTool(searchRegistrar, getClient);

  // Isolate the search instance from the already-serving full instance: if it
  // fails to bind (port in use, etc.), log and carry on rather than let a
  // top-level rejection exit the process and take the healthy full surface down.
  try {
    await searchServer.start({
      transportType: 'httpStream',
      httpStream: {
        port: searchProfile.port,
        host: HOST,
        endpoint: searchProfile.endpoint,
        stateless: true,
      },
    });
  } catch (error) {
    console.error(
      `[search-profile] failed to start on port ${searchProfile.port}; ` +
        'the full surface is unaffected',
      error
    );
  }
}
