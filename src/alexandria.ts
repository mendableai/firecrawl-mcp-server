import { z } from 'zod';

const catalogueTypes = ['alexandria', 'exchange'] as const;
export const searchSourceSchema = z.union([
  z.enum(['web', 'images', 'news', ...catalogueTypes]),
  z
    .object({ type: z.enum(['web', 'images', 'news', ...catalogueTypes]) })
    .strict(),
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
export function searchQueryIsValid(args: { query?: string }): boolean {
  return !!args.query?.trim();
}

export const findToolsSchema = z
  .object({
    urls: z
      .array(
        z
          .string()
          .url()
          .regex(/^https?:\/\//)
      )
      .max(100)
      .optional(),
    providers: z.array(z.string().min(1)).max(50).optional(),
    categories: z.array(z.string().min(1)).max(50).optional(),
    groups: z.array(z.string().min(1)).max(50).optional(),
    capabilities: z.array(z.string().min(1)).max(50).optional(),
    level: z.enum(['providers', 'groups', 'tools']).optional(),
    expand: z.array(z.enum(['options', 'response', 'examples'])).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ALEXANDRIA_INSTRUCTIONS =
  'Use firecrawl_search with a query and sources ["alexandria"] to find relevant tool contracts, or mix with web/news/images. Contracts are in data.tools, including inputs, response fields, examples, creditsCost, matchedBy and matchedUrls. domainTools:true adds domain-matched tools to the same array. Search always requires a query. Use Find Tools for contextual lookup and progressive disclosure by URL, provider, category, group or capability. Discovery is free; web search and provider execution have their own charges. Access follows the authenticated team policy.';
