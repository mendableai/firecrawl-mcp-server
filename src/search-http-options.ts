const SEARCH_TRANSPORT_MARGIN_MS = 5_000;

type SearchHttpTransport = {
  post(
    endpoint: string,
    body: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<{ data?: unknown }>;
};

function searchHttpOptions(timeout?: number) {
  return typeof timeout === 'number'
    ? { timeoutMs: timeout + SEARCH_TRANSPORT_MARGIN_MS }
    : {};
}

export function postSearch(
  http: SearchHttpTransport,
  body: Record<string, unknown>
) {
  const timeout = body.timeout;
  return http.post(
    '/v2/search',
    body,
    searchHttpOptions(typeof timeout === 'number' ? timeout : undefined)
  );
}
