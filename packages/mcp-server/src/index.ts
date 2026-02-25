#!/usr/bin/env node
/**
 * @intent-computer/mcp-server
 *
 * Standalone MCP server implementing the intent computer storage/retrieval boundary.
 * 8 tools: vault_context, inbox_capture, thought_search, thought_get,
 *          thought_write, link_graph, queue_push, queue_pop.
 *
 * Usage: intent-computer-mcp [--vault <path>]
 *   --vault <path>  Path to the vault directory (default: ~/Mind)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalMcpAdapter } from "./local-adapter.js";
import { createServer } from "./server.js";
import { homedir } from "os";
import { resolve } from "path";

// Re-export types for library consumers
export { INTENT_COMPUTER_MCP_TOOLS } from "@intent-computer/architecture";
export type { IntentComputerMcpApi } from "@intent-computer/architecture";
export { LocalMcpAdapter } from "./local-adapter.js";
export { createServer } from "./server.js";

// ─── CLI entry point ─────────────────────────────────────────────────────────

function parseArgs(): { vault: string } {
  const args = process.argv.slice(2);
  let vault = resolve(homedir(), "Mind");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      vault = resolve(args[i + 1]);
      i++;
    }
  }

  return { vault };
}

async function main() {
  const { vault } = parseArgs();

  const adapter = new LocalMcpAdapter(vault);
  const mcpServer = createServer(adapter);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Log to stderr so it doesn't interfere with MCP stdio protocol on stdout
  process.stderr.write(
    `intent-computer-mcp: serving vault at ${vault}\n`,
  );
}

// Only run main when this file is executed directly (not imported as library)
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("intent-computer-mcp"));

if (isDirectExecution) {
  main().catch((err) => {
    process.stderr.write(`intent-computer-mcp: fatal error: ${err}\n`);
    process.exit(1);
  });
}
