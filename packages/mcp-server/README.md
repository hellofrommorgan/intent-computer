# @intent-computer/mcp-server

Standalone MCP server implementing the storage/retrieval boundary for the intent computer. Exposes a vault (markdown files + YAML frontmatter + wiki links) as a set of structured tools over the Model Context Protocol.

MCP matters here because it decouples the AI host (Claude CLI, OpenCode, etc.) from the vault implementation. The host doesn't read files directly -- it calls tools. The server owns the filesystem layout, search strategy, git commits, and queue semantics.

## Transport

**stdio only.** This is not a network daemon. The host spawns it as a child process and communicates over stdin/stdout. Logs go to stderr.

```jsonc
// Claude CLI MCP config (~/.claude/settings.json)
{
  "mcpServers": {
    "intent-computer": {
      "command": "intent-computer-mcp",
      "args": ["--vault", "/path/to/vault"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `vault_context` | Session bootstrap -- loads identity, goals, working memory, morning brief, and maintenance signals (inbox pressure, orphan count, pending tensions) |
| `inbox_capture` | Drops raw material into `inbox/` with frontmatter (source, tags, timestamp) |
| `thought_search` | Keyword search via qmd BM25 with filesystem scan fallback |
| `context_query` | Semantic search (qmd deep search) + wiki link traversal -- returns the connected cluster with map membership |
| `thought_get` | Retrieves a single thought by ID (filename without `.md`) |
| `thought_write` | Creates/updates a thought with YAML frontmatter and auto-commits via git |
| `link_graph` | Parses `[[wiki links]]` to return edges -- filter by thought ID or get the full graph |
| `queue_push` | Adds a task to the processing pipeline queue (surface/reflect/revisit/verify) |
| `queue_pop` | Pops or locks the next pending task from the queue |

## Architecture

**`LocalMcpAdapter`** (`local-adapter.ts`) implements `IntentComputerMcpApi` against the local filesystem. The vault is the database: `thoughts/` holds markdown files, `inbox/` holds raw captures, `ops/queue.json` holds the task queue. All reads are `readFileSync`; writes are `writeFileSync` + git auto-commit. Path traversal is blocked by validation on thought IDs.

**`qmd-bridge.ts`** shells out to the `qmd` CLI for search. Three modes: BM25 keyword (`qmd search`), vector similarity (`qmd vsearch`), and deep search with query expansion (`qmd query`). Resolves `qmd://` URIs to absolute paths. Falls back gracefully when qmd is unavailable.

**`graph-traversal.ts`** does BFS from seed thoughts, following wiki links up to N hops. Returns the connected cluster (thoughts with depth, directed edges with prose context, and topic map membership). Used by `context_query` to expand semantic search results into their graph neighborhood.

## Configuration

| Method | Detail |
|--------|--------|
| `--vault <path>` | Vault root directory (default: `~/Mind`) |
| `QMD_PATH` env | Override qmd binary location |
| `INTENT_COMPUTER_VAULT` env | Fallback vault path for qmd bridge |

## Dependencies

- `@intent-computer/architecture` -- shared types (`IntentComputerMcpApi`, `Proposition`), frontmatter parsing, queue helpers
- `@modelcontextprotocol/sdk` v1.26.0 -- MCP protocol implementation
- `zod` -- input validation for all tool parameters
