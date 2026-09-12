<div align="center">
  <a name="readme-top"></a>
  <img
    src="https://raw.githubusercontent.com/firecrawl/firecrawl-mcp-server/main/img/fire.png"
    height="140"
  >
</div>

# Firecrawl MCP Server

A Model Context Protocol (MCP) server that brings [Firecrawl](https://github.com/firecrawl/firecrawl) to MCP-compatible AI agents — search, scrape, and interact with the live web for clean, agent-ready context.

> Big thanks to [@vrknetha](https://github.com/vrknetha), [@knacklabs](https://www.knacklabs.ai) for the initial implementation!

## Features

- Search the web and get full page content
- Search an index built for coding agents: GitHub issues, merged pull requests, READMEs, and docs
- Scrape any URL into clean, structured data
- Interact with pages — click, navigate, and operate
- Deep research with autonomous agent
- Automatic retries and rate limiting
- Cloud and self-hosted support
- SSE support

> Play around with [our MCP Server on MCP.so's playground](https://mcp.so/playground?server=firecrawl-mcp-server) or on [Klavis AI](https://www.klavis.ai/mcp-servers).

## When to Use This Server

- Use `firecrawl_scrape` when you have a known URL and want its content as markdown or as JSON matching a schema you supply.
- Use `firecrawl_map` when you need to discover URLs on a site without fetching their content.
- Use `firecrawl_crawl` when you need content from many pages under a site; set `limit`, `includePaths`/`excludePaths`, or `maxDiscoveryDepth` to bound it.
- Use `firecrawl_search` when you're starting from a query rather than a URL and want ranked web results; add `scrapeOptions` if you also want page content fetched in the same call (the search-only endpoint never fetches content).
- Use `firecrawl_interact` when a page needs a click, type, or navigate action before you can read it — pass a `url` for a fresh page or a `scrapeId` to continue on one you already scraped.
- Use the `firecrawl_monitor_*` tools when the same page needs to be checked on a recurring schedule with diffs and change alerts, rather than fetched once.
- Consider something else when you need to hold a browser session open across many of your own steps with your own retry and termination logic: each `firecrawl_interact` call runs one `prompt` or `code` turn to completion and returns control — the session can persist across calls via `scrapeId` and ends with `firecrawl_interact_stop`, but you cannot drive it interactively step-by-step from the client side within a single call.

This server lists 25 tools when the full profile registers with default settings (feedback tools included, not running in local-keyless mode). Setting `FIRECRAWL_NO_SEARCH_FEEDBACK=1` and/or `FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` removes the corresponding authenticated feedback tools and reduces this count, as does local keyless startup. For clients with a tool-slot limit: the hosted keyless endpoint (`https://mcp.firecrawl.dev/v2/mcp`, no API key) exposes 4 tools: `firecrawl_scrape`, `firecrawl_search`, `firecrawl_parse`, and `firecrawl_feedback`. The dedicated [search-only endpoint](#search-only-endpoint) (`https://mcp.firecrawl.dev/v2/mcp-search`) exposes a fixed 6 read-only tools.

## Installation

### Hosted MCP (keyless free tier)

Connect to the remote hosted server with no setup:

```
https://mcp.firecrawl.dev/v2/mcp
```

On the keyless free tier, `scrape`, `search`, and `parse` work without an API key (rate-limited). Other tools such as `crawl`, `map`, and `agent` still need a key.

Prefer OAuth or an API key whenever the human can sign up. It unlocks the full tool set and higher limits.

For an interactive account connection, configure your MCP client to use this server URL. This is an MCP endpoint, **not a browser page**; use the client's account-connection flow and do not add a second Firecrawl server entry when reconnecting:

```
https://mcp.firecrawl.dev/v2/mcp-oauth
```

For an API-key connection (for example, an unattended integration), keep the server URL as:

```
https://mcp.firecrawl.dev/v2/mcp
```

Then configure the client's secure header or secret setting with:

```
Authorization: Bearer <FIRECRAWL_API_KEY>
```

Never put an API key in the server URL. Never put an API key in an agent chat. Configure it directly in the client or secret manager. See the [hosted MCP setup guide](https://docs.firecrawl.dev/mcp-server) and the [agent onboarding guide](https://www.firecrawl.dev/agent-onboarding/SKILL.md) for client-specific instructions.

#### Search-only endpoint

A read-only, search-only surface is also hosted at:

```
https://mcp.firecrawl.dev/v2/mcp-search
```

It exposes a fixed set of six read-only tools: `firecrawl_search`, `firecrawl_developer_search`, and the four `firecrawl_research_*` tools. It performs no page-content fetching and has its own OAuth identity; the full endpoint above is unchanged. See [docs/search-profile.md](docs/search-profile.md) for the full contract.

### Running with npx

```bash
env FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

### Manual Installation

```bash
npm install -g firecrawl-mcp
```

### Running on Cursor

Configuring Cursor 🖥️
Note: Requires Cursor version 0.45.6+
For the most up-to-date configuration instructions, please refer to the official Cursor documentation on configuring MCP servers:
[Cursor MCP Server Configuration Guide](https://docs.cursor.com/context/model-context-protocol#configuring-mcp-servers)

To configure Firecrawl MCP in Cursor **v0.48.6**

1. Open Cursor Settings
2. Go to Features > MCP Servers
3. Click "+ Add new global MCP server"
4. Enter the following code:
   ```json
   {
     "mcpServers": {
       "firecrawl-mcp": {
         "command": "npx",
         "args": ["-y", "firecrawl-mcp"],
         "env": {
           "FIRECRAWL_API_KEY": "YOUR-API-KEY"
         }
       }
     }
   }
   ```

To configure Firecrawl MCP in Cursor **v0.45.6**

1. Open Cursor Settings
2. Go to Features > MCP Servers
3. Click "+ Add New MCP Server"
4. Enter the following:
   - Name: "firecrawl-mcp" (or your preferred name)
   - Type: "command"
   - Command: `env FIRECRAWL_API_KEY=your-api-key npx -y firecrawl-mcp`

> If you are using Windows and are running into issues, try `cmd /c "set FIRECRAWL_API_KEY=your-api-key && npx -y firecrawl-mcp"`

Replace `your-api-key` with your Firecrawl API key. If you don't have one yet, you can create an account and get it from https://www.firecrawl.dev/app/api-keys

After adding, refresh the MCP server list to see the new tools. The Composer Agent will automatically use Firecrawl MCP when appropriate, but you can explicitly request it by describing your web scraping needs. Access the Composer via Command+L (Mac), select "Agent" next to the submit button, and enter your query.

### Running on Windsurf

Add this to your `./codeium/windsurf/model_config.json`:

```json
{
  "mcpServers": {
    "mcp-server-firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Running with Streamable HTTP Local Mode

To run the server using Streamable HTTP locally instead of the default stdio transport:

```bash
env HTTP_STREAMABLE_SERVER=true FIRECRAWL_API_KEY=fc-YOUR_API_KEY npx -y firecrawl-mcp
```

Use the url: http://localhost:3000/mcp

### Installing via Smithery (Legacy)

To install Firecrawl for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@mendableai/mcp-server-firecrawl):

```bash
npx -y @smithery/cli install @mendableai/mcp-server-firecrawl --client claude
```

### Running on VS Code

For one-click installation, click one of the install buttons below...

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=firecrawl&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Firecrawl%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22firecrawl-mcp%22%5D%2C%22env%22%3A%7B%22FIRECRAWL_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=firecrawl&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Firecrawl%20API%20Key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22firecrawl-mcp%22%5D%2C%22env%22%3A%7B%22FIRECRAWL_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D&quality=insiders)

For manual installation, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open User Settings (JSON)`.

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "apiKey",
        "description": "Firecrawl API Key",
        "password": true
      }
    ],
    "servers": {
      "firecrawl": {
        "command": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env": {
          "FIRECRAWL_API_KEY": "${input:apiKey}"
        }
      }
    }
  }
}
```

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace. This will allow you to share the configuration with others:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "apiKey",
      "description": "Firecrawl API Key",
      "password": true
    }
  ],
  "servers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "${input:apiKey}"
      }
    }
  }
}
```

## Configuration

### Environment Variables

#### Required for Cloud API

- `FIRECRAWL_API_KEY`: Your Firecrawl API key
  - Required when using cloud API (default)
  - Optional when using self-hosted instance with `FIRECRAWL_API_URL`
- `FIRECRAWL_API_URL` (Optional): Custom API endpoint for self-hosted instances
  - Example: `https://firecrawl.your-domain.com`
  - If not provided, the cloud API will be used (requires API key)

#### MCP OAuth (Bearer access tokens)

Hosted Firecrawl can issue OAuth **access tokens** (`fco_…`) via the authorization server on [firecrawl.dev](https://firecrawl.dev). This MCP server forwards whichever credential it resolves to the Firecrawl API as `Authorization: Bearer …`.

- **HTTP stream transports** (`CLOUD_SERVICE=true`, `HTTP_STREAMABLE_SERVER=true`, or `SSE_LOCAL=true`): Clients should send `Authorization: Bearer <fco_access_token>` on MCP requests. An OAuth bearer token takes precedence over `x-firecrawl-api-key` / `x-api-key` when both are present.
- **stdio:** Use `FIRECRAWL_OAUTH_TOKEN` for a static access token, or keep using `FIRECRAWL_API_KEY` for an API key.

Use **access** tokens (`fco_…`) only. Refresh tokens (`fcr_…`) must be exchanged at the token endpoint, not passed to the scrape/search API.

#### Search-only surface (hosted)

In hosted mode (`CLOUD_SERVICE=true`) a second in-process instance serves the [search-only endpoint](#search-only-endpoint). The bundled service has a fixed deployment contract: nginx routes `/v2/mcp-search` to the instance on local port `3001`, and the OAuth protected-resource identifier is `https://mcp.firecrawl.dev/v2/mcp-search`.

`FIRECRAWL_MCP_SEARCH_ENABLED` (default `true`) is the supported operational toggle; set it to `false` to prevent the search instance from starting. The Node process also accepts `FIRECRAWL_MCP_SEARCH_PORT`, `FIRECRAWL_MCP_SEARCH_ENDPOINT`, and `FIRECRAWL_MCP_SEARCH_RESOURCE_URL` for isolated tests. Those overrides do not reconfigure the bundled nginx routes or the authorization server allowlist and must not be used independently in the hosted deployment.

The search instance requires authentication for every request (including `tools/list`) and rejects OAuth tokens whose audience does not match its own resource.

### Configuration Examples

For cloud API usage:

```bash
export FIRECRAWL_API_KEY=your-api-key
```

For self-hosted instance:

```bash
# Required for self-hosted
export FIRECRAWL_API_URL=https://firecrawl.your-domain.com

# Optional authentication for self-hosted
export FIRECRAWL_API_KEY=your-api-key  # If your instance requires auth
```

### Usage with Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-server-firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

## How to Choose a Tool

Use this guide to select the right tool for your task:

- **If you know the exact URL you want:** use **scrape** (with JSON format for structured data)
- **If you have multiple known URLs:** call **scrape** for each URL. If you specifically need one bulk API operation, use the Firecrawl API batch endpoint outside MCP.
- **If you need to discover URLs on a site:** use **map**
- **If you want to search the web for info:** use **search**
- **If you have a programming question** (a library, an API contract, an error message, a known bug): use **developer search**
- **If you need scientific papers** (biomedical, life-science, clinical, or arXiv literature): use **research tools** — they search paper abstracts and full text. `search` with `categories: ["research"]` is a different thing: a website filter over ordinary web results.
- **If you need multi-source research that returns structured data, do not know the URLs, or the answer spans several sites** (an entity plus its fields, a list, a dataset): use **agent**
- **If you want to analyze a whole site or section:** use **crawl** (with limits!)
- **If you need interactive browser automation** (click, type, navigate): use **interact** with a URL for a fresh page, or **scrape** + **interact** when you already scraped the page or need tighter scrape control

### Quick Reference Table

| Tool         | Best for                                       | Returns                        |
| ------------ | ---------------------------------------------- | ------------------------------ |
| scrape       | Single page content                            | JSON (preferred) or markdown   |
| interact     | Interact with a URL or scraped page            | Execution result + scrapeId for URL mode |
| map          | Discovering URLs on a site                     | URL[]                          |
| crawl        | Multi-page extraction (with limits)            | final crawl status/data after internal polling |
| parse        | Files and hosted upload refs                   | markdown, JSON, or document output |
| search       | Web search for info                            | results[]                      |
| developer    | Programming questions over developer sources   | results[] with passages        |
| agent        | Multi-source research, unknown or many sites   | JSON (structured data)         |
| monitor      | Recurring page checks                          | monitor/check metadata and diffs |
| research     | Paper and GitHub repository research           | research results and repo matches |

### Format Selection Guide

When using `scrape`, choose the right format:

- **JSON format (recommended for most cases):** Use when you need specific data from a page. Define a schema based on what you need to extract. This keeps responses small and avoids context window overflow.
- **Markdown format (use sparingly):** Only when you genuinely need the full page content, such as reading an entire article for summarization or analyzing page structure.

## Available Tools

### 1. Scrape Tool (`firecrawl_scrape`)

Scrape content from a single URL with advanced options.

**Best for:**

- Single page content extraction, when you know exactly which page contains the information.

**Not recommended for:**

- Extracting content from multiple pages (use repeated scrape calls for known URLs, or map + scrape to discover URLs first, or crawl for full page content)
- When you're unsure which page contains the information (use search)

**Common mistakes:**

- Passing a list of URLs to one scrape call. Call scrape once per URL in MCP. If you specifically need one bulk API operation, use the Firecrawl API batch endpoint outside MCP.
- Using markdown format by default (use JSON format to extract only what you need).

**Choosing the right format:**

- **JSON format (preferred):** For most use cases, use JSON format with a schema to extract only the specific data needed. This keeps responses focused and prevents context window overflow.
- **Markdown format:** Only when the task genuinely requires full page content (e.g., summarizing an entire article, analyzing page structure).

**Prompt Example:**

> "Get the product details from https://example.com/product."

**Usage Example (JSON format - preferred):**

```json
{
  "name": "firecrawl_scrape",
  "arguments": {
    "url": "https://example.com/product",
    "formats": [
      {
        "type": "json",
        "prompt": "Extract the product information",
        "schema": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "price": { "type": "number" },
            "description": { "type": "string" }
          },
          "required": ["name", "price"]
        }
      }
    ]
  }
}
```

**Usage Example (markdown format - when full content needed):**

```json
{
  "name": "firecrawl_scrape",
  "arguments": {
    "url": "https://example.com/article",
    "formats": ["markdown"],
    "onlyMainContent": true
  }
}
```

**Usage Example (branding format - extract brand identity):**

```json
{
  "name": "firecrawl_scrape",
  "arguments": {
    "url": "https://example.com",
    "formats": ["branding"]
  }
}
```

**Branding format:** Extracts comprehensive brand identity (colors, fonts, typography, spacing, logo, UI components) for design analysis or style replication.
**Privacy:** Set `redactPII: true` to return content with personally identifiable information redacted.

**Returns:**

- JSON structured data, markdown, branding profile, or other formats as specified.

### 2. Map Tool (`firecrawl_map`)

Map a website to discover all indexed URLs on the site.

**Best for:**

- Discovering URLs on a website before deciding what to scrape
- Finding specific sections of a website

**Not recommended for:**

- When you already know which specific URL you need (use scrape)
- When you need the content of the pages (use scrape after mapping)

**Common mistakes:**

- Using crawl to discover URLs instead of map

**Prompt Example:**

> "List all URLs on example.com."

**Usage Example:**

```json
{
  "name": "firecrawl_map",
  "arguments": {
    "url": "https://example.com"
  }
}
```

**Returns:**

- Array of URLs found on the site

### 3. Search Tool (`firecrawl_search`)

Search the web and optionally extract content from search results.

**Best for:**

- Finding specific information across multiple websites, when you don't know which website has the information.
- When you need the most relevant content for a query

**Not recommended for:**

- When you already know which website to scrape (use scrape)
- When you need comprehensive coverage of a single website (use map or crawl)

**Common mistakes:**

- Using crawl or map for open-ended questions (use search instead)

**Usage Example:**

```json
{
  "name": "firecrawl_search",
  "arguments": {
    "query": "remote work stipend policies at tech companies",
    "highlights": true,
    "limit": 5,
    "lang": "en",
    "country": "us",
    "scrapeOptions": {
      "formats": ["markdown"],
      "onlyMainContent": true,
      "redactPII": true
    }
  }
}
```

Set `highlights` to `true` to request query-relevant highlights or `false` to keep the original search snippets. Omit it to use the API's default behavior.

For scientific papers, see [Research Tools](#12-research-tools-firecrawl_research_): they search paper abstracts and full text, while `categories: ["research"]` here filters ordinary web results to research-affiliated websites.

**Returns:**

- Array of search results with optional scraped content, plus an `id` field. Keyless callers can use the returned job reference and optional invitation with `firecrawl_feedback`. Authenticated callers can continue using `firecrawl_search_feedback` with its existing fields and policy.

**Prompt Example:**

> "Compare remote work stipend policies across tech companies."

### 3b. Search Feedback Tool (`firecrawl_search_feedback`)

This authenticated tool sends structured feedback on a previous `firecrawl_search` result. Its request fields, eligibility, and refund policy are unchanged. It is idempotent per search ID. Keyless callers must use `firecrawl_feedback`; this legacy tool does not accept keyless jobs.

Feedback is optional. If submitting, use only observations already available after processing the results; no user interview or additional investigation is required.

**Opt out:** set `FIRECRAWL_NO_SEARCH_FEEDBACK=1` (or `FIRECRAWL_DISABLE_SEARCH_FEEDBACK=1`) in the environment when starting the MCP server. The `firecrawl_search_feedback` tool will not be registered, so agents can't call it. Team admins can also disable feedback server-side; in that case the tool is registered but always returns `feedbackErrorCode: "TEAM_OPTED_OUT"`.

**Most important field:** `missingContent`. It's an array of specific pieces of content the agent expected to find but did not. One entry per missing topic — these aggregate across teams and tell us what to index next.

**Daily refund cap (per team, per UTC day, default 100 credits).** Once a team's `creditsRefundedToday` reaches `dailyRefundCap`, further submissions still record feedback but no longer refund credits. The response sets `dailyCapReached: true`. Agents should stop calling this tool for the rest of the UTC day when they see that flag.

**Usage Example:**

```json
{
  "name": "firecrawl_search_feedback",
  "arguments": {
    "searchId": "0193f6c5-1234-7890-abcd-1234567890ab",
    "rating": "good",
    "valuableSources": [
      {
        "url": "https://docs.firecrawl.dev/features/search",
        "reason": "Most up-to-date description of /search."
      }
    ],
    "missingContent": [
      {
        "topic": "Pricing for the search endpoint",
        "description": "No pricing tier table for /search specifically."
      },
      { "topic": "Per-team rate limits" }
    ],
    "querySuggestions": "Boost docs.firecrawl.dev for queries that mention 'firecrawl'"
  }
}
```

**Returns:**

- `{ success, feedbackId, creditsRefunded, alreadySubmitted? }` JSON.

### 3c. Generic Feedback Tool (`firecrawl_feedback`)

Sends optional evidence through `/v2/feedback`. Keyless Search, Scrape, and Parse
jobs require `endpoint`, `jobId`, `rating`, `task`, `assessment`, and 1-20
`observations`. Each observation has `kind`, `detail`, and `basis`: `output`,
`source_comparison`, or `expectation`. Source comparisons also require
`comparison: {reference, detail}`.

For Search, report useful or irrelevant results by source group and one-based
position, or missing information with a topic and any already-known source URLs.
For Scrape, report correct, missing, incorrect, or failed output. For Parse,
report correct output or text, table, layout, or completeness issues. The tool
description lists the complete fields. Use only available evidence and keep
unverified expectations distinct from source comparisons.

Keyless submissions are limited to one per identity per UTC day across Search,
Scrape, Parse, and all clients, with references valid for 24 hours. Feedback remains
available after operation allowance is exhausted and does not consume or restore
that allowance.

Authenticated callers retain the existing issue/note fields for Search, Scrape,
Parse, and Map. For authenticated Search-specific feedback, continue using
`firecrawl_search_feedback`. Choose the contract that matches the originating
job's authentication; adding credentials does not convert a keyless job.

Keep feedback concise: use issue codes, tags, short notes, URLs, page numbers,
and small metadata objects. Do not include raw scrape/parse outputs.

**Authenticated feedback preference:** set `FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` (or `FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK=1`) to hide `firecrawl_feedback` from authenticated sessions. Keyless sessions retain the tool and server-issued invitations regardless of these flags. The API controls invitation frequency and eligibility. Submitting feedback remains optional and is never required for continued keyless access.

**Authenticated usage example:**

```json
{
  "name": "firecrawl_feedback",
  "arguments": {
    "endpoint": "scrape",
    "jobId": "0193f6c5-1234-7890-abcd-1234567890ab",
    "rating": "partial",
    "issues": ["missing_markdown"],
    "tags": ["docs"],
    "note": "The pricing table was missing from the markdown output.",
    "url": "https://example.com/pricing",
    "pageNumbers": [1],
    "metadata": {
      "format": "markdown"
    }
  }
}
```

**Returns:**

- `{ success, feedbackId, creditsRefunded, creditsRefundedToday?, dailyRefundCap?, dailyCapReached?, alreadySubmitted?, warning? }` JSON.

### 4. Crawl Tool (`firecrawl_crawl`)

Starts a crawl job, polls until it reaches a terminal state, and returns the final crawl status/data.

**Best for:**

- Extracting content from multiple related pages, when you need comprehensive coverage.

**Not recommended for:**

- Extracting content from a single page (use scrape)
- When token limits are a concern (use map + scrape for tighter control)
- When you need fast results (crawling can be slow)

**Warning:** Crawl responses can be very large and may exceed token limits. Limit the crawl depth and number of pages, or use map + scrape for tighter control.

**Common mistakes:**

- Setting limit or maxDiscoveryDepth too high (causes token overflow)
- Using crawl for a single page (use scrape instead)

**Prompt Example:**

> "Get all blog posts from the first two levels of example.com/blog."

**Usage Example:**

```json
{
  "name": "firecrawl_crawl",
  "arguments": {
    "url": "https://example.com/blog/*",
    "maxDiscoveryDepth": 2,
    "limit": 100,
    "allowExternalLinks": false,
    "deduplicateSimilarURLs": true
  }
}
```


**Returns:**

- Final crawl status and data after internal polling, including `id`, `status`, `completed`, `total`, `creditsUsed`, `expiresAt`, `next`, and `data`. Use the returned `id` with `firecrawl_check_crawl_status` if you need to re-check the job later.

### 5. Check Crawl Status (`firecrawl_check_crawl_status`)

Check the status and results of an existing crawl job by ID.

```json
{
  "name": "firecrawl_check_crawl_status",
  "arguments": {
    "id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:**

- Response includes the status of the crawl job:

### 6. Parse Tool (`firecrawl_parse`)

Parse local files or hosted upload references with Firecrawl's `/v2/parse` endpoint.

**Best for:** PDFs, Word documents, spreadsheets, HTML files, and other documents that need markdown or structured JSON output. Hosted MCP supports a two-step upload-ref flow; local MCP requires an explicit API URL before reading and uploading the requested file.

**Not recommended for:** Remote URLs (use scrape), multiple files in one call (call parse once per file), or browser-only actions such as screenshots and clicks.

**Hosted MCP flow:** Hosted MCP cannot read the caller's filesystem directly. Call `firecrawl_parse` with `filePath` to receive a short-lived upload command and `nextToolCall`, upload the file locally, then call `firecrawl_parse` again with the returned `uploadRef`. Minting the hosted upload URL requires Firecrawl auth or keyless eligibility. In local `npx firecrawl-mcp` mode, `FIRECRAWL_API_URL` must be explicitly configured before the server reads or uploads `filePath`. There is no default upload destination for local Parse. Both authenticated and eligible keyless calls are supported by the selected API. Running MCP locally does not perform parsing on the local machine. This configuration requirement selects the destination; it does not restrict which files the process can read.

**Usage Example:**

```json
{
  "name": "firecrawl_parse",
  "arguments": {
    "filePath": "/absolute/path/to/document.pdf",
    "formats": ["markdown"],
    "parsers": ["pdf"],
    "zeroDataRetention": true
  }
}
```

**Returns:** Parsed document content or hosted upload instructions with a `nextToolCall`.

### 7. Structured data with Scrape JSON

For structured data from a known page, call `firecrawl_scrape` once per URL with `formats: ["json"]`. Put the extraction prompt and JSON schema in `jsonOptions`.

```json
{
  "name": "firecrawl_scrape",
  "arguments": {
    "url": "https://example.com/product",
    "formats": ["json"],
    "jsonOptions": {
      "prompt": "Extract the product name, price, and description.",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "price": { "type": "number" },
          "description": { "type": "string" }
        },
        "required": ["name", "price"]
      }
    }
  }
}
```

When the URLs are not known or the data spans several sites, use `firecrawl_agent` for multi-source research.

### 8. Agent Tool (`firecrawl_agent`)

Autonomous web research agent that returns structured data when you do not know the URLs or the answer spans several sites. Describe the fields you need, optionally pass a JSON schema and seed URLs, and the agent searches, navigates, reads pages, and returns JSON assembled across sources. Use it for an entity plus its fields, for lists and datasets, and for pages that need navigation to reach the data. For one known URL use `firecrawl_scrape` with JSON format instead.

**How it works:**

The agent performs web searches, follows links, reads pages, and gathers data autonomously. This runs **asynchronously** - it returns a job ID immediately, and you poll `firecrawl_agent_status` to check when complete and retrieve results.

**Async workflow:**

1. Call `firecrawl_agent` with your prompt/schema → returns job ID
2. Do other work while the agent researches (can take minutes for complex queries)
3. Poll `firecrawl_agent_status` with the job ID to check progress
4. When status is "completed", the response includes the extracted data

**Best for:**

- Complex research tasks where you don't know the exact URLs
- Multi-source data gathering
- Finding information scattered across the web
- Tasks where you can do other work while waiting for results

**Not recommended for:**

- Simple single-page scraping where you know the URL (use scrape with JSON format - faster and cheaper)

**Arguments:**

- `prompt`: Natural language description of the data you want (required, max 10,000 characters)
- `urls`: Optional array of URLs to focus the agent on specific pages
- `schema`: Optional JSON schema for structured output

**Prompt Example:**

> "Find the founders of Firecrawl and their backgrounds"

**Usage Example (start agent, then poll for results):**

```json
{
  "name": "firecrawl_agent",
  "arguments": {
    "prompt": "Find the top 5 AI startups founded in 2024 and their funding amounts",
    "schema": {
      "type": "object",
      "properties": {
        "startups": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": { "type": "string" },
              "funding": { "type": "string" },
              "founded": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

Then poll with `firecrawl_agent_status` using the returned job ID.

**Usage Example (with URLs - agent focuses on specific pages):**

```json
{
  "name": "firecrawl_agent",
  "arguments": {
    "urls": ["https://docs.firecrawl.dev", "https://firecrawl.dev/pricing"],
    "prompt": "Compare the features and pricing information from these pages"
  }
}
```

**Returns:**

- Job ID for status checking. Use `firecrawl_agent_status` to poll for results.

### 9. Check Agent Status (`firecrawl_agent_status`)

Check the status of an agent job and retrieve results when complete. Use this to poll for results after starting an agent.

**Polling pattern:** Agent research can take minutes for complex queries. Poll this endpoint periodically (e.g., every 10-30 seconds) until status is "completed" or "failed".

```json
{
  "name": "firecrawl_agent_status",
  "arguments": {
    "id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Possible statuses:**

- `processing`: Agent is still researching - check back later
- `completed`: Research finished - response includes the extracted data
- `failed`: An error occurred

### 10. Interact Tool (`firecrawl_interact`)

Interact with a fresh URL or with a page that was already opened by `firecrawl_scrape`.

**Best for:** Clicking, typing, navigating, and extracting state from dynamic pages without restoring the deprecated browser tools.

**Usage options:**

- Pass `url` to scrape and open a page for interaction in one MCP call.
- Pass `scrapeId` to continue interacting with an existing scraped page.
- Pass exactly one of `url` or `scrapeId`, plus either `prompt` or `code`.

**Usage Example:**

```json
{
  "name": "firecrawl_interact",
  "arguments": {
    "url": "https://example.com",
    "prompt": "Click the pricing link and summarize the visible plans"
  }
}
```

**Returns:** Interaction result and, for URL mode, the derived `scrapeId` for follow-up or cleanup.

### 11. Stop Interact Tool (`firecrawl_interact_stop`)

Stop an interact session for a scraped page when you are done interacting.

```json
{
  "name": "firecrawl_interact_stop",
  "arguments": {
    "scrapeId": "scrape-id-here"
  }
}
```

### 12. Research Tools (`firecrawl_research_*`)

Search and inspect papers and GitHub repositories through the research MCP tools.

**Covers:** paper abstracts and full text across biomedical, life-science, and clinical literature (PubMed, bioRxiv, medRxiv) alongside arXiv and other scientific sources.

**Available research tools:**

- `firecrawl_research_search_papers`: search paper metadata and abstracts with a natural-language query, with optional author, category, and date filters.
- `firecrawl_research_inspect_paper`: retrieve canonical metadata for one paper ID (arXiv, PMC, PMID, or DOI).
- `firecrawl_research_related_papers`: expand from one or more anchor papers through the citation graph.
- `firecrawl_research_read_paper`: read full-text passages from a specific paper.

**Best for:** Literature review, paper lookup, and repository discovery workflows where the agent needs a focused research surface instead of general web scraping.

`firecrawl_search` with `categories: ["research"]` is a different surface: it filters ordinary web results to research-affiliated websites and returns page snippets, not paper records. Use these tools when the question is about the literature itself, and pass several distinct framings of the same question — they surface different papers than a single query does.

### 13. Monitor Tools (`firecrawl_monitor_*`)

Create and manage recurring page monitors. Monitors run scheduled scrapes or crawls, diff each result against the last retained snapshot, and can notify by webhook or email.

**Best for:**

- Watching one page or a few pages over time
- Alerting on meaningful changes using a plain-English goal
- Tracking check history and page-level diffs

**Recommended create pattern:**

Use `page` or `pages` plus `goal`. The MCP server builds the monitor request with a 30-minute schedule and the API enables meaningful-change judging automatically.

Meaningful-change judging runs automatically when `goal` is set. Page webhooks expose `isMeaningful` and `judgment` on `monitor.page` events.

Write goals as concise 2-3 sentence monitor instructions. Say what should trigger an alert, preserve any scope the user gave, and include intent-specific exclusions only when obvious from the request. Generic noise such as whitespace, formatting-only changes, request IDs, tracking params, generic metadata, and unrelated page chrome is already handled by the judge, so do not repeat it in every goal. If the user is vague, keep the goal broad; if they ask for broad monitoring or "any change", preserve that. If the user says they do not care about something, include that explicitly.

```json
{
  "name": "firecrawl_monitor_create",
  "arguments": {
    "page": "https://example.com/pricing",
    "goal": "Alert when pricing, packaging, or launch messaging changes."
  }
}
```

**Multiple pages with webhooks:**

```json
{
  "name": "firecrawl_monitor_create",
  "arguments": {
    "pages": ["https://example.com/pricing", "https://example.com/changelog"],
    "goal": "Alert when pricing, packaging, or launch messaging changes.",
    "webhookUrl": "https://example.com/webhooks/firecrawl"
  }
}
```

**Advanced create requests:**

Pass `body` when you need crawl targets, JSON change tracking, custom retention, or explicit `judgeEnabled` control.

```json
{
  "name": "firecrawl_monitor_create",
  "arguments": {
    "body": {
      "name": "Docs monitor",
      "schedule": { "text": "hourly", "timezone": "UTC" },
      "goal": "Alert when docs pages add, remove, or materially change API behavior.",
      "targets": [{ "type": "crawl", "url": "https://example.com/docs" }]
    }
  }
}
```

**Other monitor tools:**

- `firecrawl_monitor_list`: list monitors.
- `firecrawl_monitor_get`: get one monitor.
- `firecrawl_monitor_update`: update fields including `goal`, `judgeEnabled`, `webhook`, and `notification`.
- `firecrawl_monitor_run`: trigger a check now.
- `firecrawl_monitor_delete`: delete a monitor (destructive; only call when the user intends to remove it).
- `firecrawl_monitor_checks`: list checks, optionally filtered by status.
- `firecrawl_monitor_check`: get page-level results, including `diff`, `snapshot`, `judgment.meaningful`, and `judgment.meaningfulChanges`.

### 14. Developer Search Tool (`firecrawl_developer_search`)

Search an index built for coding agents. The index covers GitHub issues, merged pull requests, repository READMEs, and curated documentation sites.

**Best for:** A programming question — code behaviour, a library or framework, an API contract, an error message, or a known bug.

**Arguments:**

```json
{
  "name": "firecrawl_developer_search",
  "arguments": {
    "query": "how do I configure retries",
    "k": 10,
    "skills": "only"
  }
}
```

- `query` (required): the developer question or search phrase.
- `k`: number of ranked results. The default is 10 and the maximum is 100.
- `skills`: set to `"only"` to search agent-skill files alone.

**Returns:** Ranked results. Each result carries an ID, a source type (`issue`, `pull_request`, `readme`, or `doc`), a URL, a title, and the matched passages in markdown.

`firecrawl_search` with `categories: ["developer"]` searches the same index beside the web results. Use this tool instead when you want the matched passages, the `skills` filter, or no web results in the response. The search-only endpoint exposes both tools, and the same choice applies there.

## Logging System

The server includes comprehensive logging:

- Operation status and progress
- Performance metrics
- Rate limit tracking
- Error conditions

Example log messages:

```
[INFO] Firecrawl MCP Server initialized successfully
[INFO] Starting scrape for URL: https://example.com
[ERROR] Rate limit exceeded
```

## Error Handling

The server provides robust error handling:

- API rate-limit errors surfaced to the MCP client
- Detailed error messages
- Network resilience

Example error response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: Rate limit exceeded"
    }
  ],
  "isError": true
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

### Contributing

1. Fork the repository
2. Create your feature branch
3. Run tests: `npm test`
4. Submit a pull request

### Thanks to contributors

Thanks to [@vrknetha](https://github.com/vrknetha), [@cawstudios](https://caw.tech) for the initial implementation!

Thanks to MCP.so and Klavis AI for hosting and [@gstarwd](https://github.com/gstarwd), [@xiangkaiz](https://github.com/xiangkaiz) and [@zihaolin96](https://github.com/zihaolin96) for integrating our server.

## License

MIT License - see LICENSE file for details
