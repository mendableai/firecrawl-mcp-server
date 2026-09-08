/**
 * Firecrawl Developer search tool.
 *
 * Thin MCP wrapper over the `/v2/search/developer` endpoint (GitHub issues,
 * merged pull requests, repository READMEs, and curated documentation sites).
 *
 * The installed `@mendable/firecrawl-js` predates a `developer` client, so we
 * call the endpoint directly through the SDK's HTTP layer (auth + retries) via
 * `client.http.get(...)`, mirroring how the research tools reach
 * `/v2/search/research/*`.
 */

import { z } from 'zod';
import type { FastMCP } from 'fastmcp';

interface SessionData {
  firecrawlApiKey?: string;
  [key: string]: unknown;
}

/** Whatever `getClient` returns — we only touch its `http.get`. */
type ClientLike = {
  http: {
    get: <T = unknown>(
      endpoint: string,
      headers?: Record<string, string>
    ) => Promise<{ data: T; status: number }>;
  };
};

// `getClient` returns a FirecrawlApp whose `http` member is private, so we type
// the callback loosely and narrow to `ClientLike` at each call site.
type GetClient = (session?: SessionData) => unknown;

// The other mount, /v2/developer/search, may be withdrawn.
const BASE = '/v2/search/developer';
const ORIGIN_HEADERS = { 'X-Origin': 'mcp-fastmcp' };


interface DeveloperHit {
  /** Stable result id, e.g. `issue:owner/repo#123` or `doc:<hash>`. */
  id?: string;
  url?: string;
  title?: string;
  /** Matched passages in markdown. */
  passages?: { text?: string }[];
}

/**
 * Render developer hits as `## [id] (kind) title` / url / passages blocks.
 * The stable ID prefix supplies the kind. Markdown passages keep newlines.
 */
function fmtDeveloper(
  results?: DeveloperHit[]
): string {
  if (!results || results.length === 0) return '(no results)';
  return results
    .map((r) => {
      const id = r.id ?? '?';
      const kind = r.id?.split(':', 1)[0];
      const kindLabel = kind ? ` (${kind})` : '';
      const lines = [`## [${id}]${kindLabel} ${r.title ?? '(untitled)'}`];
      if (r.url && !id.endsWith(`:${r.url}`) && id !== r.url) lines.push(r.url);
      const body = (r.passages ?? [])
        .map((p) => p.text ?? '')
        .filter((passage) => passage.trim().length > 0)
        .join('\n---\n')
        .trim();
      // Passages are server-shaped (search-side budget is always on); no
      // client-side truncation.
      lines.push(body || '(no content)');
      return lines.join('\n');
    })
    .join('\n\n');
}

export function registerDeveloperTools(
  server: Pick<FastMCP<SessionData>, 'addTool'>,
  getClient: GetClient
): void {
  // --- developer search ---
  server.addTool({
    name: 'firecrawl_developer_search',
    annotations: {
      title: 'Search developer sources',
      readOnlyHint: true, // Semantic search over an indexed developer corpus; returns ranked results only.
      openWorldHint: true, // Searches the Firecrawl developer index of public GitHub and documentation content.
      destructiveHint: false, // Query-only; no writes to external sources or the developer index.
    },
    description: `
For a developer question — code behaviour, a library or framework, an API contract, an error message, or a known bug — search an index built for coding agents. The index covers repositories, GitHub issues, merged pull requests, repository READMEs, and curated documentation sites. Set skills to "only" to limit the search to agent-skill files.

Returns ranked results with an ID, source type, URL, title, and the matched passages in markdown.
`,
    // Frozen argument surface: query, k, skills. GET /v2/search/developer also
    // documents types, repos, sources, passages, language, topic, license,
    // min_stars, max_stars, archived, and fork. Those stay HTTP-only. Widening
    // this list is a contract change and must update
    // tests/developer-search-contract.test.mjs.
    //
    // Property `.describe()` text does not survive tools/list serialization.
    // Anything an agent has to read belongs in the tool description above.
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'Natural-language developer question or search phrase, including the library, error message, or API involved when relevant.'
        ),
      k: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of ranked results to return (default 10).'),
      skills: z
        .enum(['only'])
        .optional()
        .describe('Set to "only" to search only agent-skill files.'),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { query, k, skills } = args as {
        query: string;
        k?: number;
        skills?: 'only';
      };
      const params = new URLSearchParams();
      params.append('query', query);
      if (k != null) params.append('k', String(k));
      if (skills != null) params.append('skills', skills);
      const client = getClient(session) as ClientLike;
      const res = await client.http.get<{
        results?: DeveloperHit[];
      }>(`${BASE}?${params.toString()}`, ORIGIN_HEADERS);
      return fmtDeveloper(res.data?.results);
    },
  });
}
