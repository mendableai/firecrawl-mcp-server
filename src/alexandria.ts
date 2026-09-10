import { z } from 'zod';

const catalogueTypes = [
  'alexandria',
  'exchange-providers',
  'exchange',
] as const;
const catalogueFields = {
  type: z.enum(catalogueTypes),
  mode: z.enum(['semantic', 'browse']).optional(),
  categories: z.array(z.string().min(1)).optional(),
  providers: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
  groups: z.array(z.string().min(1)).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  level: z.enum(['categories', 'providers', 'groups', 'tools']).optional(),
  expand: z.array(z.enum(['options', 'response', 'examples'])).optional(),
  languages: z.array(z.enum(['javascript', 'python', 'curl'])).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
};

export const searchSourceSchema = z.union([
  z.enum(['web', 'images', 'news', ...catalogueTypes]),
  z.object({ type: z.enum(['web', 'images', 'news']) }).strict(),
  z.object(catalogueFields).strict(),
]);

export function hasAlexandria(sources: unknown): boolean {
  return (
    Array.isArray(sources) &&
    sources.some((source) =>
      catalogueTypes.includes(
        typeof source === 'string' ? source : source?.type
      )
    )
  );
}

export function normalizeSearchSources(sources: unknown): unknown {
  if (!Array.isArray(sources)) return sources;
  return sources.map((source) =>
    source === 'exchange'
      ? 'alexandria'
      : source?.type === 'exchange'
        ? { ...source, type: 'alexandria' }
        : source
  );
}

export function searchQueryIsValid(args: {
  query?: string;
  sources?: z.infer<typeof searchSourceSchema>[];
  includeDomains?: string[];
  excludeDomains?: string[];
}): boolean {
  if (args.query?.trim()) return true;
  return (
    !!args.sources?.length &&
    !args.includeDomains?.length &&
    !args.excludeDomains?.length &&
    args.sources.every(
      (source) =>
        catalogueTypes.includes(
          (typeof source === 'string'
            ? source
            : source.type) as (typeof catalogueTypes)[number]
        ) &&
        (typeof source === 'string' ||
          !('mode' in source) ||
          source.mode !== 'semantic')
    )
  );
}

export const ALEXANDRIA_INSTRUCTIONS =
  'Use firecrawl_search sources ["alexandria"] for free catalogue discovery, or mix it with web/news/images. Sources also accept objects with mode semantic|browse, categories/providers/domains/groups/capabilities arrays, level categories|providers|groups|tools, expand options/response/examples, languages javascript/python/curl, limit and cursor. Omit query for catalogue-only browsing. data.alexandria contains status, items, total, nextCursor; unavailable is not zero matches. Each item.next is a complete firecrawl_search input for progressive disclosure. Preserve query and filters when paging. Read the options and price before executing. skills:true includes contextual tools for query mentions and result URLs. Discovery is free; web search, scraping and provider execution have their own charges. Access is derived from your authenticated team.';
