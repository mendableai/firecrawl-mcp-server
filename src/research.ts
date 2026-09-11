/**
 * Firecrawl Research tools (experimental).
 *
 * Thin MCP wrappers over the `/v2/search/research/*` paper endpoints.
 *
 * The installed `@mendable/firecrawl-js` predates the SDK's `research` client,
 * so we call the endpoints directly through the SDK's HTTP layer (auth +
 * retries) via `client.http.get(...)`, mirroring how the search tool reaches
 * `/v2/search`.
 */

import { z } from 'zod';
import { type FastMCP, UserError } from 'fastmcp';

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

const BASE = '/v2/search/research';
const ORIGIN_HEADERS = { 'X-Origin': 'mcp-fastmcp' };

/** Append a value (or repeated array values) to a URLSearchParams instance. */
function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | string[] | undefined
): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (v != null && String(v).length > 0) params.append(key, String(v));
    }
  } else {
    params.append(key, String(value));
  }
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// --- result formatting (ported from research-index-front/src/agent_eval.ts) ---

// Max authors to print per paper (with affiliations); the rest collapse to a
// "+N more" tail so a large collaboration doesn't flood the context.
const MAX_AUTHORS = 15;
// Cap each abstract so a page of hits stays within the MCP output-token limit.
const MAX_ABSTRACT_CHARS = 600;
// Per-affiliation char cap — keeps one long org string (e.g. a full multi-dept
// university address) from bloating the authors line.
const MAX_AFFIL_CHARS = 60;
// Hard ceiling on the whole authors line, as a final guard.
const MAX_AUTHORS_LINE_CHARS = 400;

interface PaperHit {
  paperId?: string;
  primaryId?: string;
  ids?: Record<string, string[]>;
  title?: string;
  abstract?: string;
  // Search/metadata responses give a comma-joined string; some shapes give the
  // structured form — handle both.
  authors?: string | { name: string; affiliation?: string }[];
  categories?: string[];
  createdDate?: string;
  updateDate?: string;
}

/** Display id supplied by the API, already ordered for citation/fetch use. */
function displayId(p: PaperHit): string {
  return p.primaryId ?? 'missing-primary-id';
}

/** Format the authors line, accepting either the string or structured form. */
function fmtAuthors(
  authors?: string | { name: string; affiliation?: string }[]
): string | null {
  if (!authors) return null;
  let shown: string[];
  let total: number;
  if (typeof authors === 'string') {
    const names = authors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return null;
    total = names.length;
    shown = names.slice(0, MAX_AUTHORS);
  } else {
    if (authors.length === 0) return null;
    total = authors.length;
    shown = authors.slice(0, MAX_AUTHORS).map((a) => {
      const aff = a.affiliation?.trim();
      return aff ? `${a.name} (${aff.slice(0, MAX_AFFIL_CHARS)})` : a.name;
    });
  }
  const extra = total > MAX_AUTHORS ? `; +${total - MAX_AUTHORS} more` : '';
  return ('Authors: ' + shown.join('; ') + extra).slice(
    0,
    MAX_AUTHORS_LINE_CHARS
  );
}

/** Render ranked papers as `[id] title` / authors / abstract blocks. */
function fmtHits(results?: PaperHit[]): string {
  if (!results || results.length === 0) return '(no results)';
  return results
    .map((r) => {
      const lines = [`## [${displayId(r)}] ${r.title ?? '(untitled)'}`];
      const authors = fmtAuthors(r.authors);
      if (authors) lines.push(authors);
      lines.push(
        (r.abstract || '(no abstract)')
          .replace(/\s+/g, ' ')
          .slice(0, MAX_ABSTRACT_CHARS)
      );
      return lines.join('\n');
    })
    .join('\n\n');
}

function fmtPaperMetadata(paper?: PaperHit): string {
  if (!paper) return '(paper not found)';
  const lines = [`# ${paper.title ?? '(untitled)'}`];
  lines.push('');
  lines.push(`Paper ID: ${paper.paperId ?? '?'}`);

  const ids = Object.entries(paper.ids ?? {})
    .flatMap(([namespace, values]) =>
      values.map((value) => `${namespace}:${value}`)
    )
    .join(', ');
  if (ids) lines.push(`IDs: ${ids}`);

  const authors = fmtAuthors(paper.authors);
  if (authors) lines.push(authors);

  if (paper.categories?.length) {
    lines.push(`Categories: ${paper.categories.join(', ')}`);
  }

  const dates = [
    paper.createdDate ? `created ${paper.createdDate}` : '',
    paper.updateDate ? `updated ${paper.updateDate}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  if (dates) lines.push(`Dates: ${dates}`);

  lines.push('');
  lines.push('## Abstract');
  lines.push((paper.abstract || '(no abstract)').replace(/\s+/g, ' '));
  return lines.join('\n');
}

function deprecatedGithubPayload() {
  return {
    code: 'DEPRECATED_TOOL',
    message:
      "firecrawl_research_search_github is deprecated and unavailable through MCP. Use firecrawl_developer_search, which searches GitHub issues, pull requests, and READMEs plus curated documentation sites and returns matched passages. It does not carry over this tool's score breakdown or its web fallback results.",
    replacement: {
      name: 'firecrawl_developer_search',
      instructions:
        'Pass the same natural-language query. Optionally set k to control the number of results, or set skills to "only" to search only agent-skill files.',
      example_arguments: {
        query: 'pysam VCF parsing memory leak',
      },
    },
    docs_url: 'https://docs.firecrawl.dev/features/developer',
  };
}

export function registerResearchTools(
  server: Pick<FastMCP<SessionData>, 'addTool'>,
  getClient: GetClient
): void {
  // --- search_papers ---
  server.addTool({
    name: 'firecrawl_research_search_papers',
    annotations: {
      title: 'Search research papers',
      readOnlyHint: true, // Semantic search over indexed paper metadata; returns ranked results only.
      openWorldHint: true, // Searches the Firecrawl research paper index.
      destructiveHint: false, // Query-only; no writes to external sources or the research index.
    },
    description: `
Search paper metadata and abstracts with a natural-language query across the indexed corpus, which spans biomedical, life-science, and clinical literature (PubMed, bioRxiv, medRxiv) alongside arXiv and other scientific sources. Optional author, category, and date filters constrain results.

Several distinct framings of the same question surface different papers than a single query does.

Returns ranked papers with canonical IDs, titles, authors, and abstracts.
`,
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'Natural-language research topic or question, including methods, systems, conditions, ' +
            'populations, interventions, or outcomes when relevant.'
        ),
      k: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Number of ranked papers to return (default 40).'),
      authors: z
        .array(z.string())
        .optional()
        .describe(
          'Author substring filter(s); ALL must match (case-insensitive).'
        ),
      categories: z
        .array(z.string())
        .optional()
        .describe(
          'Paper category filter(s) (e.g. `cs.LG`); ALL provided values must match.'
        ),
      from: z
        .string()
        .optional()
        .describe(
          'Inclusive lower bound on created/updated date (`YYYY-MM-DD`).'
        ),
      to: z
        .string()
        .optional()
        .describe(
          'Inclusive upper bound on created/updated date (`YYYY-MM-DD`).'
        ),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { query, k, authors, categories, from, to } = args as {
        query: string;
        k?: number;
        authors?: string[];
        categories?: string[];
        from?: string;
        to?: string;
      };
      const params = new URLSearchParams();
      appendParam(params, 'query', query);
      appendParam(params, 'k', k);
      appendParam(params, 'authors', authors);
      appendParam(params, 'categories', categories);
      appendParam(params, 'from', from);
      appendParam(params, 'to', to);
      const client = getClient(session) as ClientLike;
      const res = await client.http.get<{ results?: PaperHit[] }>(
        withQuery(`${BASE}/papers`, params),
        ORIGIN_HEADERS
      );
      return fmtHits(res.data?.results);
    },
  });

  // --- inspect_paper ---
  server.addTool({
    name: 'firecrawl_research_inspect_paper',
    annotations: {
      title: 'Inspect a paper',
      readOnlyHint: true, // Fetches canonical metadata (title, abstract, authors) for one paper by ID.
      openWorldHint: true, // Retrieves metadata for papers in public indexes (arXiv, PMC, DOI, etc.).
      destructiveHint: false, // Read-only metadata lookup.
    },
    description: `
Retrieve canonical metadata for one paper ID, such as an arXiv, PMC, PMID, or DOI identifier. Returns the title, abstract, authors, categories, source IDs, and dates as markdown.
`,
    parameters: z.object({
      paperId: z
        .string()
        .min(1)
        .describe(
          'Canonical paperId or primaryId such as `arxiv:1706.03762`, `pmcid:PMC12530322`, `pmid:40953549`, or `doi:10.1016/j.neunet.2025.108095`.'
        ),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { paperId } = args as { paperId: string };
      const client = getClient(session) as ClientLike;
      const res = await client.http.get<{ paper?: PaperHit }>(
        `${BASE}/papers/${encodeURIComponent(paperId)}`,
        ORIGIN_HEADERS
      );
      return fmtPaperMetadata(res.data?.paper);
    },
  });

  // --- related_papers ---
  server.addTool({
    name: 'firecrawl_research_related_papers',
    annotations: {
      title: 'Find related papers via citation graph',
      readOnlyHint: true, // Finds related papers via citation graph expansion; returns candidates only.
      openWorldHint: true, // Traverses relationships across the public research paper corpus.
      destructiveHint: false, // Read-only graph query; no modifications.
    },
    description: `
Find citation-graph candidates from one to ten \`seed_ids\`; the first ID is the primary seed and later IDs are anchors. \`mode\` defaults to \`similar\` (co-citation/bibliographic coupling); \`citers\` returns papers citing a seed and \`references\` papers cited by a seed. \`intent\` ranks candidates.

Returns ranked candidates and the evaluated pool size.
`,
    parameters: z.object({
      seed_ids: z.array(z.string()).min(1).max(10),
      intent: z.string().min(1),
      mode: z.enum(['similar', 'citers', 'references']).optional(),
      k: z.number().int().min(1).max(500).optional(),
      rerank: z
        .boolean()
        .optional()
        .describe('Apply an additional rerank over the fused candidates.'),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { seed_ids, intent, mode, k, rerank } = args as {
        seed_ids: string[];
        intent: string;
        mode?: string;
        k?: number;
        rerank?: boolean;
      };
      // The endpoint takes a single primary seed in the path; any additional
      // seeds ride along as repeated `anchor` params.
      const [primary, ...anchors] = seed_ids;
      const params = new URLSearchParams();
      appendParam(params, 'intent', intent);
      appendParam(params, 'mode', mode);
      appendParam(params, 'k', k);
      if (rerank != null) appendParam(params, 'rerank', rerank);
      appendParam(params, 'anchor', anchors);
      const client = getClient(session) as ClientLike;
      const res = await client.http.get<{
        results?: PaperHit[];
        poolSize?: number;
        note?: string | null;
      }>(
        withQuery(
          `${BASE}/papers/${encodeURIComponent(primary)}/similar`,
          params
        ),
        ORIGIN_HEADERS
      );
      const note = res.data?.note ? `\nnote: ${res.data.note}` : '';
      return `${fmtHits(res.data?.results)}\n(poolSize=${res.data?.poolSize ?? 0})${note}`;
    },
  });

  // --- read_paper ---
  server.addTool({
    name: 'firecrawl_research_read_paper',
    annotations: {
      title: 'Read a paper',
      readOnlyHint: true, // Retrieves relevant full-text passages from a paper; does not modify the paper.
      openWorldHint: true, // Reads from publicly indexed paper full text when available.
      destructiveHint: false, // Read-only passage retrieval.
    },
    description: `
Retrieve in-body passages from one paper that are relevant to a specific question. Full text is available only for indexed papers; \`k\` controls the number of passages.

Returns matching passages or a notice when full text is unavailable.
`,
    parameters: z.object({
      paperId: z
        .string()
        .min(1)
        .describe(
          'Canonical paperId or primaryId such as `arxiv:1706.03762`, `pmcid:PMC12530322`, `pmid:40953549`, or `doi:10.1016/j.neunet.2025.108095`.'
        ),
      question: z.string().min(1),
      k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Number of passages to return (default 4).'),
    }),
    execute: async (args: unknown, { session }): Promise<string> => {
      const { paperId, question, k } = args as {
        paperId: string;
        question: string;
        k?: number;
      };
      const params = new URLSearchParams();
      appendParam(params, 'query', question);
      appendParam(params, 'k', k);
      const client = getClient(session) as ClientLike;
      const res = await client.http.get<{ passages?: { text: string }[] }>(
        withQuery(`${BASE}/papers/${encodeURIComponent(paperId)}`, params),
        ORIGIN_HEADERS
      );
      const passages = res.data?.passages ?? [];
      return passages.length
        ? passages.map((p) => p.text).join('\n---\n')
        : '(no full-text passages available for this paper)';
    },
  });

  // --- search_github: deprecated compatibility entry point ---
  // Hidden from tools/list so new sessions never see it, still callable so a
  // session holding a cached tool list gets a pointer to the replacement
  // instead of an unknown-tool error. Same shape as firecrawl_extract.
  server.addTool({
    name: 'firecrawl_research_search_github',
    annotations: {
      title: 'Search GitHub history',
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
    description: `
Deprecated compatibility entry point. Use firecrawl_developer_search for GitHub issues, pull requests, and READMEs, plus curated documentation sites, returned as matched passages.
`,
    parameters: z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(100).optional(),
    }),
    canList: () => false,
    beforeValidate: () => {
      const payload = deprecatedGithubPayload();
      return {
        content: [{ type: 'text' as const, text: payload.message }],
        isError: true,
        structuredContent: payload,
      };
    },
    execute: async (): Promise<string> => {
      const payload = deprecatedGithubPayload();
      throw new UserError(payload.message, payload);
    },
  });
}
