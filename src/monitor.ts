/**
 * Firecrawl Monitor tools.
 *
 * Monitors run recurring scrapes/crawls and diff each result against the last
 * retained snapshot. The SDK exposes monitor methods, but its HttpClient
 * injects a top-level `origin` field into every POST/PATCH body and
 * /v2/monitor rejects that with "Unrecognized key in body". Until the SDK
 * strips `origin` for monitor requests, we hit /v2/monitor directly via fetch
 * — same pattern the CLI uses.
 */

import { z } from 'zod';
import type { FastMCP } from 'fastmcp';
import { mcpJsonObject, mcpJsonObjectOptional } from './mcp-json-schemas';
import {
  CoreHttpError,
  credentialForOutboundRequest,
  type CredentialSession,
} from './session-credential';

interface SessionData extends CredentialSession {
  [key: string]: unknown;
}

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

interface MonitorRequestInit {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

function resolveAuth(session?: SessionData): {
  apiKey?: string;
  baseUrl: string;
} {
  // A request-scoped session is authoritative. In particular, managed OAuth
  // credentials must become short-lived delegated assertions and must never
  // fall through to a process-wide API key.
  const apiKey =
    session === undefined
      ? process.env.FIRECRAWL_API_KEY
      : credentialForOutboundRequest(session);
  const baseUrl = (process.env.FIRECRAWL_API_URL ?? DEFAULT_API_URL).replace(
    /\/$/,
    ''
  );
  return { apiKey, baseUrl };
}

async function monitorRequest(
  session: SessionData | undefined,
  path: string,
  init: MonitorRequestInit = {}
): Promise<unknown> {
  const { apiKey, baseUrl } = resolveAuth(session);
  if (!apiKey && !process.env.FIRECRAWL_API_URL) {
    throw new Error('Unauthorized: API key is required for monitor requests');
  }

  let url = `${baseUrl}/v2${path}`;
  if (init.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers: Record<string, string> = { 'X-Origin': 'mcp-fastmcp' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const payload = (await response.json().catch(() => ({}))) as any;

  if (!response.ok || payload?.success === false) {
    const message =
      payload?.error ||
      `HTTP ${response.status}: ${response.statusText || 'Request failed'}`;
    throw new CoreHttpError(message, response.status);
  }

  return payload;
}

function asText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const pageStatusSchema = z.enum(['same', 'new', 'changed', 'removed', 'error']);
const checkStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'partial',
  'skipped_overlap',
]);

function splitPages(page?: string, pages?: string[]): string[] {
  return [page, ...(pages ?? [])]
    .filter((url): url is string => typeof url === 'string')
    .map((url) => url.trim())
    .filter(Boolean);
}

function buildMonitorCreateBody(
  args: Record<string, unknown>
): Record<string, unknown> {
  if (args.body && typeof args.body === 'object' && !Array.isArray(args.body)) {
    return args.body as Record<string, unknown>;
  }

  const urls = splitPages(
    args.page as string | undefined,
    args.pages as string[] | undefined
  );
  const queries = Array.isArray(args.queries)
    ? (args.queries as unknown[])
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.trim())
        .filter(Boolean)
    : [];
  const isSearch = queries.length > 0;

  if (urls.length === 0 && !isSearch) {
    throw new Error(
      'firecrawl_monitor_create requires either `body`, `page`/`pages`, or `queries`.'
    );
  }

  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!goal) {
    throw new Error(
      'firecrawl_monitor_create shorthand requires `goal`. Use `body` for advanced requests without a goal.'
    );
  }

  // Build the target: search when `queries` are given, otherwise a scrape.
  let target: Record<string, unknown>;
  if (isSearch) {
    const includeDomains = Array.isArray(args.includeDomains)
      ? (args.includeDomains as unknown[]).filter(
          (d): d is string => typeof d === 'string'
        )
      : undefined;
    const excludeDomains = Array.isArray(args.excludeDomains)
      ? (args.excludeDomains as unknown[]).filter(
          (d): d is string => typeof d === 'string'
        )
      : undefined;
    target = {
      type: 'search',
      queries,
      ...(typeof args.searchWindow === 'string' && args.searchWindow.trim()
        ? { searchWindow: args.searchWindow.trim() }
        : {}),
      ...(typeof args.maxResults === 'number'
        ? { maxResults: args.maxResults }
        : {}),
      ...(includeDomains && includeDomains.length > 0 ? { includeDomains } : {}),
      ...(excludeDomains && excludeDomains.length > 0 ? { excludeDomains } : {}),
    };
  } else {
    target = { type: 'scrape', urls };
  }

  const webhookUrl =
    typeof args.webhookUrl === 'string' ? args.webhookUrl.trim() : '';
  const email =
    typeof args.email === 'string' && args.email.trim()
      ? {
          email: {
            enabled: true,
            recipients: [args.email.trim()],
            includeDiffs: Boolean(args.includeDiffs),
          },
        }
      : undefined;

  return {
    name:
      typeof args.name === 'string' && args.name.trim()
        ? args.name.trim()
        : isSearch
          ? `Monitor ${queries[0]}`
          : `Monitor ${urls[0]}`,
    schedule: {
      text:
        typeof args.scheduleText === 'string' && args.scheduleText.trim()
          ? args.scheduleText.trim()
          : 'every 30 minutes',
      timezone:
        typeof args.timezone === 'string' && args.timezone.trim()
          ? args.timezone.trim()
          : 'UTC',
    },
    goal,
    targets: [target],
    ...(email ? { notification: email } : {}),
    ...(webhookUrl
      ? {
          webhook: {
            url: webhookUrl,
            events: ['monitor.page', 'monitor.check.completed'],
          },
        }
      : {}),
  };
}

export function registerMonitorTools(server: FastMCP<SessionData>): void {
  server.addTool({
    name: 'firecrawl_monitor_create',
    annotations: {
      title: 'Create monitor',
      readOnlyHint: false, // Creates a new recurring monitor configuration on the Firecrawl API.
      openWorldHint: true, // Monitors user-specified URLs on the public web on a recurring schedule.
      destructiveHint: false, // Additive; creates a new monitor without deleting existing monitors or external content.
    },
    description: `
Create a recurring scrape, crawl, or search monitor that compares each check with its retained predecessor. The simple form accepts \`page\`/\`pages\` or \`queries\` plus a plain-language \`goal\`; the advanced \`body\` form controls targets, schedule, change-tracking formats, judging, retention, webhook, and notifications.

In the simple form, a \`goal\` is required. If \`queries\` contains one or more non-empty values and is supplied with \`page\`/\`pages\`, \`queries\` create the search target and page targets are ignored. A monitor schedules future network checks and can send configured email or webhook notifications. Returns the created monitor.
`,
    parameters: z.object({
      body: mcpJsonObjectOptional,
      page: z.string().optional(),
      pages: z.array(z.string()).optional(),
      queries: z.array(z.string()).optional(),
      searchWindow: z.enum(['5m', '15m', '1h', '6h', '24h', '7d']).optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
      includeDomains: z.array(z.string()).optional(),
      excludeDomains: z.array(z.string()).optional(),
      goal: z.string().optional(),
      name: z.string().optional(),
      scheduleText: z.string().optional(),
      timezone: z.string().optional(),
      email: z.string().optional(),
      includeDiffs: z.boolean().optional(),
      webhookUrl: z.string().optional(),
    }),
    execute: async (args: unknown, { session, log }): Promise<string> => {
      const body = buildMonitorCreateBody(args as Record<string, unknown>);
      log.info('Creating monitor', { name: String(body.name) });
      const res = await monitorRequest(session, '/monitor', {
        method: 'POST',
        body,
      });
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_list',
    annotations: {
      title: 'List monitors',
      readOnlyHint: true, // Lists monitors for the authenticated account; no mutations.
      openWorldHint: false, // Returns only the user's Firecrawl monitor records, not arbitrary web content.
      destructiveHint: false, // Read-only listing.
    },
    description: `
List monitors for the authenticated account with optional pagination controls. Returns one page of monitor records and pagination metadata.
`,
    parameters: z.object({
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { limit, offset } = args as { limit?: number; offset?: number };
      const res = await monitorRequest(session, '/monitor', {
        query: { limit, offset },
      });
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_get',
    annotations: {
      title: 'Get monitor',
      readOnlyHint: true, // Fetches a single monitor by ID; no mutations.
      openWorldHint: false, // Reads a specific monitor resource in the user's Firecrawl account.
      destructiveHint: false, // Read-only retrieval.
    },
    description: `
Retrieve one monitor by ID, including its configuration and current state. This does not run or modify the monitor.
`,
    parameters: z.object({ id: z.string() }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { id } = args as { id: string };
      const res = await monitorRequest(
        session,
        `/monitor/${encodeURIComponent(id)}`
      );
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_update',
    annotations: {
      title: 'Update monitor',
      readOnlyHint: false, // PATCHes an existing monitor (status, schedule, targets, webhooks, etc.).
      openWorldHint: true, // Can change which external URLs are monitored and how recurring scrapes run.
      destructiveHint: true, // Can pause, replace, or remove monitor configuration; changes overwrite prior settings.
    },
    description: `
Patch an existing monitor by ID. The body can change its name, active/paused status, schedule, targets, goal, judging, webhook, notifications, or retention; these changes affect future scheduled checks.

Returns the updated monitor.
`,
    parameters: z.object({
      id: z.string(),
      body: mcpJsonObject,
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { id, body } = args as {
        id: string;
        body: Record<string, unknown>;
      };
      const res = await monitorRequest(
        session,
        `/monitor/${encodeURIComponent(id)}`,
        { method: 'PATCH', body }
      );
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_delete',
    annotations: {
      title: 'Delete monitor',
      readOnlyHint: false, // Permanently deletes a monitor via DELETE on the API.
      openWorldHint: true, // Deletes a monitor that tracked open-web URLs.
      destructiveHint: true, // Irreversibly removes the monitor and stops its schedule.
    },
    description: `
Permanently delete a monitor by ID and stop its future schedule. This operation cannot be undone and returns deletion status.
`,
    parameters: z.object({ id: z.string() }),
    execute: async (args: unknown, { session, log }): Promise<string> => {
      const { id } = args as { id: string };
      log.info('Deleting monitor', { id });
      const res = await monitorRequest(
        session,
        `/monitor/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_run',
    annotations: {
      title: 'Run monitor now',
      readOnlyHint: false, // Triggers an immediate monitor check, queueing a new scrape/diff run.
      openWorldHint: true, // The triggered check scrapes external URLs configured on the monitor.
      destructiveHint: false, // Starts a read-only check job; does not delete the monitor or external sites.
    },
    description: `
Queue an immediate check for a monitor outside its normal schedule. This starts network work for the monitor's configured targets and returns the queued check.
`,
    parameters: z.object({ id: z.string() }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { id } = args as { id: string };
      const res = await monitorRequest(
        session,
        `/monitor/${encodeURIComponent(id)}/run`,
        { method: 'POST' }
      );
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_checks',
    annotations: {
      title: 'List monitor checks',
      readOnlyHint: true, // Lists historical check runs for a monitor; no mutations.
      openWorldHint: false, // Returns check history for a known monitor ID within the user's account.
      destructiveHint: false, // Read-only listing.
    },
    description: `
List historical checks for a monitor, optionally filtered by status and bounded by a result limit. Returns one page of check summaries and pagination metadata.
`,
    parameters: z.object({
      id: z.string(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      status: checkStatusSchema.optional(),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { id, limit, offset, status } = args as {
        id: string;
        limit?: number;
        offset?: number;
        status?: z.infer<typeof checkStatusSchema>;
      };
      const res = await monitorRequest(
        session,
        `/monitor/${encodeURIComponent(id)}/checks`,
        { query: { limit, offset, status } }
      );
      return asText(res);
    },
  });

  server.addTool({
    name: 'firecrawl_monitor_check',
    annotations: {
      title: 'Get monitor check',
      readOnlyHint: true, // Retrieves a single check run with page-level diff results; no mutations.
      openWorldHint: false, // Reads stored check results for a known monitor/check ID in the user's account.
      destructiveHint: false, // Read-only retrieval of diff snapshots and judgments.
    },
    description: `
Retrieve one monitor check and its page-level results, optionally filtered by page status. Pages report \`same\`, \`new\`, \`changed\`, \`removed\`, or \`error\`; configured goal judging can add a meaningful-change decision.

Markdown tracking returns a unified text diff, JSON tracking returns field paths with previous/current values and a current snapshot, and mixed tracking returns both. Returns one page of results plus a \`next\` URL when more pages exist.
`,
    parameters: z.object({
      id: z.string(),
      checkId: z.string(),
      limit: z.number().int().positive().optional(),
      skip: z.number().int().nonnegative().optional(),
      pageStatus: pageStatusSchema.optional(),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { id, checkId, limit, skip, pageStatus } = args as {
        id: string;
        checkId: string;
        limit?: number;
        skip?: number;
        pageStatus?: z.infer<typeof pageStatusSchema>;
      };
      const res = await monitorRequest(
        session,
        `/monitor/${encodeURIComponent(id)}/checks/${encodeURIComponent(checkId)}`,
        { query: { limit, skip, status: pageStatus } }
      );
      return asText(res);
    },
  });
}
