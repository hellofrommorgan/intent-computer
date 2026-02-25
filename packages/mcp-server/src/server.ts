/**
 * server.ts
 *
 * MCP protocol handler. Registers 8 tools with JSON Schema input definitions
 * and routes calls to the LocalMcpAdapter.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalMcpAdapter } from "./local-adapter.js";

const thoughtIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
    { message: "Invalid thought identifier" },
  );

export function createServer(adapter: LocalMcpAdapter): McpServer {
  const server = new McpServer({
    name: "intent-computer",
    version: "0.1.0",
  });

  // ─── vault_context ───────────────────────────────────────────────────────

  server.tool(
    "vault_context",
    "Load vault context: identity, goals, working memory, maintenance signals",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      sessionId: z.string().describe("Current session identifier"),
      includeIdentity: z
        .boolean()
        .optional()
        .describe("Include identity.md content"),
      includeGoals: z
        .boolean()
        .optional()
        .describe("Include goals.md content"),
      includeMaintenance: z
        .boolean()
        .optional()
        .describe("Include maintenance condition signals"),
    },
    async (args) => {
      const result = await adapter.vaultContext({
        vaultId: args.vaultId,
        sessionId: args.sessionId,
        includeIdentity: args.includeIdentity,
        includeGoals: args.includeGoals,
        includeMaintenance: args.includeMaintenance,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── inbox_capture ───────────────────────────────────────────────────────

  server.tool(
    "inbox_capture",
    "Capture raw material into the vault inbox for later processing",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      source: z
        .string()
        .describe(
          "Where this content came from (e.g. conversation, article, voice)",
        ),
      title: z.string().describe("Title for the inbox item"),
      body: z.string().describe("Content body in markdown"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags for categorization"),
    },
    async (args) => {
      const result = await adapter.inboxCapture({
        vaultId: args.vaultId,
        source: args.source,
        title: args.title,
        body: args.body,
        tags: args.tags,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── thought_search ──────────────────────────────────────────────────────

  server.tool(
    "thought_search",
    "Search thoughts by keyword (filesystem scan fallback, semantic search deferred)",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      query: z.string().describe("Search query — keywords to find in thoughts"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of results to return (default: 10)"),
    },
    async (args) => {
      const result = await adapter.thoughtSearch({
        vaultId: args.vaultId,
        query: args.query,
        limit: args.limit,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── thought_get ─────────────────────────────────────────────────────────

  server.tool(
    "thought_get",
    "Retrieve a specific thought by its ID (filename without .md)",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      thoughtId: thoughtIdSchema
        .describe("Thought identifier — the filename without .md extension"),
    },
    async (args) => {
      const result = await adapter.thoughtGet({
        vaultId: args.vaultId,
        thoughtId: args.thoughtId,
      });
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "thought not found" }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── thought_write ───────────────────────────────────────────────────────

  server.tool(
    "thought_write",
    "Write a thought to the vault with YAML frontmatter and auto-commit via git",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      proposition: z
        .object({
          id: z.string().describe("Unique thought ID"),
          vaultId: z.string().describe("Vault ID"),
          title: z
            .string()
            .describe("Prose-as-title: a complete claim as sentence"),
          description: z
            .string()
            .describe(
              "One sentence adding context beyond the title (~150 chars)",
            ),
          topics: z
            .array(z.string())
            .describe("Wiki links to parent maps"),
          confidence: z.number().optional().describe("Confidence score"),
          sourceRefs: z
            .array(z.string())
            .optional()
            .describe("Source references"),
          createdAt: z.string().describe("ISO creation date"),
          updatedAt: z.string().describe("ISO update date"),
        })
        .describe("The proposition metadata for the thought"),
      markdown: z
        .string()
        .describe("The markdown body content of the thought"),
    },
    async (args) => {
      const result = await adapter.thoughtWrite({
        vaultId: args.vaultId,
        proposition: args.proposition,
        markdown: args.markdown,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── link_graph ──────────────────────────────────────────────────────────

  server.tool(
    "link_graph",
    "Parse [[wiki links]] from thoughts to build the knowledge graph",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      thoughtId: thoughtIdSchema
        .optional()
        .describe("Filter to edges involving this thought"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of edges to return (default: 100)"),
    },
    async (args) => {
      const result = await adapter.linkGraph({
        vaultId: args.vaultId,
        thoughtId: args.thoughtId,
        limit: args.limit,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── queue_push ──────────────────────────────────────────────────────────

  server.tool(
    "queue_push",
    "Add a task to the processing pipeline queue",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      target: z
        .string()
        .describe("The target to process (thought title or inbox item)"),
      sourcePath: z
        .string()
        .describe("Filesystem path to the source file"),
      phase: z
        .enum(["surface", "reflect", "revisit", "verify"])
        .describe("Pipeline phase to execute"),
    },
    async (args) => {
      const result = await adapter.queuePush({
        vaultId: args.vaultId,
        target: args.target,
        sourcePath: args.sourcePath,
        phase: args.phase,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── queue_pop ───────────────────────────────────────────────────────────

  server.tool(
    "queue_pop",
    "Pop the next unlocked task from the processing pipeline queue",
    {
      vaultId: z.string().describe("Vault identifier (ignored in local mode)"),
      lockTtlSeconds: z
        .number()
        .optional()
        .describe(
          "If set, lock the task for this many seconds instead of removing it",
        ),
    },
    async (args) => {
      const result = await adapter.queuePop({
        vaultId: args.vaultId,
        lockTtlSeconds: args.lockTtlSeconds,
      });
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ empty: true, message: "queue is empty" }),
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}
