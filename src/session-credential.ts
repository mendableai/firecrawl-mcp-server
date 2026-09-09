import { createHmac } from 'node:crypto';

const managedOAuthApiKey = Symbol('firecrawlManagedOAuthApiKey');

export interface CredentialSession {
  /** Reusable general/API-key credential. Safe to pass directly to Core. */
  firecrawlApiKey?: string;
  /**
   * Process-local managed credential for a hosted OAuth grant. Symbol-keyed so
   * JSON/session serialization cannot expose it. Never use this value directly
   * as an outbound Authorization credential.
   */
  [managedOAuthApiKey]?: string;
}

/**
 * A non-2xx answer from Core on a path that does not go through the SDK. The
 * status travels with the error so a credential rejection stays recognisable
 * wherever it was raised, rather than being inferred from a message string.
 */
export class CoreHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CoreHttpError';
    this.status = status;
  }
}

/**
 * Names the validation step that failed. Deliberately low cardinality and
 * server-side only: these tags are for operators triaging a credential
 * validation outage, and they never carry credential material.
 */
export type CredentialValidationReason =
  | 'introspect_secret_missing'
  | 'introspect_transport_error'
  | 'introspect_http_status'
  | 'introspect_content_type'
  | 'introspect_malformed_body'
  | 'introspect_unusable_credential'
  | 'delegated_signing_secret_missing'
  | 'delegated_credential_unavailable'
  | 'outbound_client_uninstrumented';

export type CredentialValidationDiagnostics = {
  reason: CredentialValidationReason;
  /** Introspection response status, when a response was actually received. */
  status?: number;
  /** Wall time spent on the introspection attempt, in milliseconds. */
  elapsedMs?: number;
  /** True when the introspection request was cut short by its own budget. */
  aborted?: boolean;
  /** MCP resource the credential was being validated against. */
  resource?: string;
};

/**
 * Every failed credential check funnels through this one error, so the client
 * sees a single stable sentence. The diagnostics ride along for the server log
 * and are never rendered into the response.
 *
 * Raise it with `credentialValidationUnavailable` below. Constructing it
 * directly skips the record and puts the failure back in the dark.
 */
export class CredentialValidationUnavailableError extends Error {
  readonly diagnostics: CredentialValidationDiagnostics;

  constructor(diagnostics: CredentialValidationDiagnostics) {
    super('Firecrawl credential validation is temporarily unavailable');
    this.name = 'CredentialValidationUnavailableError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Builds the error and emits exactly one record for it, for operators only.
 *
 * The record is written here rather than wherever the error is caught, because
 * these are raised from two different call stacks: request authentication, and
 * outbound client setup during tool execution. Logging at a single catch site
 * covers only the first, and silently drops any throw site added later.
 *
 * Intentionally low cardinality. `resource` is one of a handful of server-owned
 * URLs. Never add the token, the resolved API key, the upstream response body
 * or its headers, request URLs, user agents, or hashes of any of them.
 */
export function credentialValidationUnavailable(
  diagnostics: CredentialValidationDiagnostics
): CredentialValidationUnavailableError {
  const { aborted, elapsedMs, reason, resource, status } = diagnostics;
  console.error(
    '[MCP_CREDENTIAL_VALIDATION]',
    JSON.stringify({
      aborted: aborted ?? null,
      elapsed_ms: elapsedMs ?? null,
      introspect_status: status ?? null,
      reason,
      resource: resource ?? null,
    })
  );
  return new CredentialValidationUnavailableError(diagnostics);
}

type McpDelegatedCredentialPayload = {
  v: 1;
  aud: 'firecrawl-core';
  purpose: 'hosted_mcp_oauth';
  api_key: string;
  iat: number;
  exp: number;
};

function delegationSecret(resource?: string): string {
  const secret = process.env.MCP_DELEGATED_CREDENTIAL_SECRET?.trim();
  if (!secret) {
    throw credentialValidationUnavailable({
      reason: 'delegated_signing_secret_missing',
      resource,
    });
  }
  return secret;
}

/**
 * `resource` is only for the failure record. Outbound signing has no resource in
 * scope, so it is optional rather than threaded through every caller.
 */
export function requireDelegatedCredentialSigning(resource?: string): void {
  delegationSecret(resource);
}

export function setManagedOAuthApiKey<T extends CredentialSession>(
  session: T,
  apiKey: string
): T {
  Object.defineProperty(session, managedOAuthApiKey, {
    configurable: false,
    enumerable: false,
    value: apiKey,
    writable: false,
  });
  return session;
}

export function copyManagedOAuthApiKey(
  source: CredentialSession | undefined,
  target: CredentialSession
): void {
  const apiKey = source?.[managedOAuthApiKey];
  if (apiKey) setManagedOAuthApiKey(target, apiKey);
}

export function hasCredential(session?: CredentialSession): boolean {
  return Boolean(session?.firecrawlApiKey || session?.[managedOAuthApiKey]);
}

export function hasManagedOAuthCredential(
  session?: CredentialSession
): boolean {
  return Boolean(session?.[managedOAuthApiKey]);
}

export function credentialForOutboundRequest(
  session?: CredentialSession
): string | undefined {
  const managedApiKey = session?.[managedOAuthApiKey];
  if (!managedApiKey) return session?.firecrawlApiKey;

  const iat = Math.floor(Date.now() / 1000);
  const payload: McpDelegatedCredentialPayload = {
    v: 1,
    aud: 'firecrawl-core',
    purpose: 'hosted_mcp_oauth',
    api_key: managedApiKey,
    iat,
    exp: iat + 60,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url'
  );
  const signature = createHmac('sha256', delegationSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `fcmcp_${encodedPayload}.${signature}`;
}
