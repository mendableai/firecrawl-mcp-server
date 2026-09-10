# Integration Tests

Snapshot-based regression tests for the MCP protocol surface. A golden cassette records the `initialize` handshake, all tool schemas via `tools/list`, and error handling. CI verifies that every PR still matches. If a tool is renamed, removed, or has its schema changed, the diff shows exactly what broke.

Uses [mcp-recorder](https://github.com/devhelmhq/mcp-recorder) for recording and verification.

## What's tested

| Cassette | What it guards |
|---|---|
| `protocol_and_errors.json` | Protocol version, capabilities, all tool schemas, error responses |

## Setup

```bash
pip install -r integration/requirements.txt
```

## Verify locally

```bash
pnpm build
FIRECRAWL_API_KEY=test HTTP_STREAMABLE_SERVER=true node dist/index.js &

mcp-recorder verify \
  --cassette integration/cassettes/protocol_and_errors.json \
  --target http://localhost:3000 \
  --verbose
```

All 4 interactions should pass. Kill the server when done.

## Update cassettes after intentional changes

When you've changed a tool schema or added a new tool, update the cassette with one command:

```bash
# Start the server, then:
mcp-recorder verify \
  --cassette integration/cassettes/protocol_and_errors.json \
  --target http://localhost:3000 \
  --update
```

This replays the recorded requests, accepts the new responses, and writes them back to the cassette. Commit the updated cassette with your PR — the diff makes the schema change visible in review.

## Add new test scenarios

Edit `scenarios.yml` and re-record:

```bash
mcp-recorder record-scenarios integration/scenarios.yml \
  --output-dir integration/cassettes
```

See the [mcp-recorder docs](https://github.com/devhelmhq/mcp-recorder) for supported actions.
