# Changelog

## [3.25.0] - 2026-09-02

### Added

- Firecrawl Exchange on the v2 shapes. `firecrawl_search` accepts `sources: ["exchange"]` or `sources: [{ "type": "exchange" }]` (both profiles, forwarded verbatim) and passes `data.exchange[]` capability hits and `creditsUsed` through untouched. `firecrawl_scrape` accepts `exchange: [{ provider, capability, options }]` (1-10 items, exactly one of `url` or `exchange`) and posts `POST /v2/scrape` returning `{ success, scrape_id, data: { exchange, creditsCost } }`. New `firecrawl_exchange_discover` tool walks `GET /exchange/discover[/cohort[/provider[/capability]]]` and searches the index route with `q`/`limit`. Exchange error bodies (403 without the team flag, 501 without a semantic index, and the reserved 402/409 billing statuses) are relayed in-band with their `code` (and `chargeId` when present). `firecrawl_exchange_discover` refuses `.`/`..` path segments and `expand` off the cohort route before any request. Keyless and unauthenticated sessions get `Exchange requires an API key on a team with Exchange access` instead of an opaque upstream error, and `firecrawl_exchange_discover` is not advertised to hosted keyless sessions.

## [3.21.4] - 2026-06-23

### Added

- `firecrawl_parse` now works on the remote hosted MCP server (`CLOUD_SERVICE`), not just local mode. Because the hosted server cannot read the caller's filesystem, hosted parse uses a two-call flow: the first call (`filePath`) returns a short-lived signed upload command plus a `nextToolCall` carrying an `uploadRef`; after the bytes are uploaded, the second call (`uploadRef`) parses the file server-side. The generated upload command never includes your Firecrawl API key, and the flow also works on the keyless remote URL.

## [3.20.2] - 2026-06-01

### Added

- Added `redactPII` to scrape, parse, and nested scrape option schemas so MCP callers can request PII redaction with a single flag.

## [3.20.1] - 2026-05-28

### Fixed

- Fix stdio transport regression introduced in 3.18.0 where every tool call
  failed with `Unauthorized: API key is required when not using a self-hosted
  instance` even when `FIRECRAWL_API_KEY` was set. The OAuth refactor in 3.18.0
  made the `authenticate` callback unconditionally read `request.headers`, but
  `firecrawl-fastmcp` invokes `authenticate(undefined)` for stdio (there is no
  HTTP request context). The resulting `TypeError` was swallowed by FastMCP,
  leaving the session unauthenticated. Added a null guard so env-var
  credentials (`FIRECRAWL_API_KEY` / `FIRECRAWL_OAUTH_TOKEN`) are honored on
  stdio again.

## [3.19.1] - 2026-05-27

### Changed

- Refined monitor goal guidance for meaningful-change monitoring.
- Documented `isMeaningful`, `judgment`, and `meaningfulChanges` monitor results.

## [3.19.0] - 2026-05-25

### Added

- Added a simplified `firecrawl_monitor_create` path using `page` or `pages` plus `goal`.
- Added monitor check status filtering to `firecrawl_monitor_checks`.

### Changed

- Updated monitor tool guidance to prefer goal-based meaningful-change monitoring and document `judgment` results.

## [1.7.0] - 2025-03-18

### Fixed

- Critical bugfix for stdio transport hanging issues with Python clients
- Implemented transport-aware logging that directs logs to stderr when using stdio transport
- Resolves issue #22 where Python clients would hang during initialization or tool execution
- Improves compatibility with non-JavaScript MCP clients

## [1.2.4] - 2024-02-05

### Added

- Environment variable support for all configuration options
- Detailed configuration documentation in README

### Changed

- Made retry and credit monitoring settings configurable via environment variables:
  - `FIRECRAWL_RETRY_MAX_ATTEMPTS`
  - `FIRECRAWL_RETRY_INITIAL_DELAY`
  - `FIRECRAWL_RETRY_MAX_DELAY`
  - `FIRECRAWL_RETRY_BACKOFF_FACTOR`
  - `FIRECRAWL_CREDIT_WARNING_THRESHOLD`
  - `FIRECRAWL_CREDIT_CRITICAL_THRESHOLD`
- Enhanced configuration examples with detailed comments and use cases
- Improved documentation for retry behavior and credit monitoring

### Documentation

- Added comprehensive configuration examples for both cloud and self-hosted setups
- Added detailed explanations of retry behavior with timing examples
- Added credit monitoring threshold explanations
- Updated Claude Desktop configuration documentation

## [1.2.3] - 2024-02-05

### Changed

- Removed redundant batch configuration to rely on Firecrawl library's built-in functionality
- Simplified batch processing logic by leveraging library's native implementation
- Optimized parallel processing and rate limiting handling
- Reduced code complexity and potential configuration conflicts

### Technical

- Removed custom `CONFIG.batch` settings (`maxParallelOperations` and `delayBetweenRequests`)
- Simplified batch operation processing to use library's built-in batch handling
- Updated server startup logging to remove batch configuration references
- Maintained credit usage tracking and error handling functionality

## [1.2.2] - 2025-02-05

### Fixed

- Resolved unused interface warnings for ExtractParams and ExtractResponse
- Improved type safety in extract operations
- Fixed type casting issues in API responses

### Changed

- Improved type guards for better type inference
- Enhanced error messages for configuration validation

## [1.2.0] - 2024-01-03

### Added

- Implemented automatic retries with exponential backoff for rate limits
- Added queue system for batch operations with parallel processing
- Integrated credit usage monitoring with warning thresholds
- Enhanced content validation with configurable criteria
- Added comprehensive logging system for operations and errors
- New search tool (`firecrawl_search`) for web search with content extraction
- Support for self-hosted Firecrawl instances via optional API URL configuration
  - New `FIRECRAWL_API_URL` environment variable
  - Automatic fallback to cloud API
  - Improved error messages for self-hosted instances

### Changed

- Improved error handling for HTTP errors including 404s
- Enhanced URL validation before scraping
- Updated configuration with new retry and batch processing options
- Optimized rate limiting with automatic backoff strategy
- Improved documentation with new features and examples
- Added detailed self-hosted configuration guide

### Fixed

- Rate limit handling in batch operations
- Error response formatting
- Type definitions for response handlers
- Test suite mock responses
- Error handling for invalid search queries
- API configuration validation

## [1.0.1] - 2023-12-03

### Added

- Initial release with basic scraping functionality
- Support for batch scraping
- URL discovery and crawling capabilities
- Rate limiting implementation
