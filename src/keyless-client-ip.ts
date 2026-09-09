import net from 'node:net';

/**
 * Accept exactly one syntactically valid source IP from the hosting edge.
 *
 * The hosted nginx proxy preserves the chain sanitized by its trusted ingress,
 * so the application must reject multi-hop/client-crafted values. A single
 * address may legitimately be private in direct or local test topologies;
 * requiring a public address here would make those deployments unavailable.
 */
export function extractSingleTrustedClientIp(
  rawForwardedFor: string | string[] | undefined
): string | undefined {
  if (Array.isArray(rawForwardedFor) && rawForwardedFor.length !== 1) {
    return undefined;
  }
  const raw = Array.isArray(rawForwardedFor)
    ? rawForwardedFor[0]
    : rawForwardedFor;
  if (typeof raw !== 'string') return undefined;

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 1) return undefined;

  const candidate = parts[0].replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return net.isIP(candidate) ? candidate : undefined;
}
