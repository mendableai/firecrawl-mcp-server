import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function loadCliCredentials(): void {
  if (
    process.env.FIRECRAWL_USE_CLI_CREDENTIALS !== 'true' ||
    ['CLOUD_SERVICE', 'SSE_LOCAL', 'HTTP_STREAMABLE_SERVER'].some(
      (key) => process.env[key] === 'true'
    ) ||
    process.env.FIRECRAWL_API_KEY?.trim() ||
    process.env.FIRECRAWL_OAUTH_TOKEN?.trim()
  )
    return;
  const base =
    process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'))
        : path.join(homedir(), '.config');
  try {
    const credentials = JSON.parse(
      readFileSync(path.join(base, 'firecrawl-cli', 'credentials.json'), 'utf8')
    );
    if (typeof credentials.apiKey !== 'string' || !credentials.apiKey.trim())
      return;
    process.env.FIRECRAWL_API_KEY = credentials.apiKey.trim();
    if (
      !process.env.FIRECRAWL_API_URL &&
      typeof credentials.apiUrl === 'string' &&
      credentials.apiUrl.trim()
    )
      process.env.FIRECRAWL_API_URL = credentials.apiUrl.trim();
  } catch {
    // Missing or unreadable credentials retain the normal authentication flow.
  }
}
