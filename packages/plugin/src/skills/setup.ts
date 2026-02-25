/**
 * setup.ts — Phase 6
 *
 * The derivation engine. Generates a complete knowledge vault from a conversation.
 *
 * WHAT /SETUP DOES IN ARS-CONTEXTA
 * ---------------------------------
 * /setup is a 6-phase process:
 *
 *   Phase 1: Platform detection
 *     Detects Claude Code vs opencode, available tools, MCP servers.
 *
 *   Phase 2: Derivation conversation (2-4 turns)
 *     Uses AskUserQuestion to collect:
 *     - What domain are you working in? (research, therapy, management, etc.)
 *     - What's your primary workflow?
 *     - What vocabulary do you want to use?
 *     - Do you want self-space (personal identity notes)?
 *     - Do you want semantic search? (requires qmd)
 *
 *   Phase 3: Dimension derivation
 *     Maps conversation signals to 8 configuration dimensions with confidence scores:
 *     - granularity: atomic | document | mixed
 *     - organization: flat | hierarchical | networked
 *     - linking: explicit | implicit | both
 *     - processing: light | standard | heavy
 *     - navigation: simple | layered | full
 *     - maintenance: loose | standard | tight
 *     - schema: minimal | standard | rich
 *     - automation: none | partial | full
 *
 *   Phase 4: System proposal
 *     Shows user the proposed configuration before generating anything.
 *     Allows adjustments. Gets explicit approval.
 *
 *   Phase 5: File generation (16+ artifacts)
 *     Generates:
 *     - Vault directory structure (thoughts/, inbox/, archive/, self/, ops/)
 *     - ops/config.yaml — live operational settings
 *     - ops/derivation-manifest.md — runtime vocabulary (read by every skill)
 *     - ops/derivation.md — human-readable derivation record
 *     - ops/queue/queue.json — empty processing queue
 *     - .mcp.json — qmd semantic search configuration
 *     - opencode.json — plugin registration including intent-computer
 *     - self/identity.md, self/goals.md, self/working-memory.md
 *     - templates/thought-note.md, templates/map.md, templates/observation.md
 *     - thoughts/index.md — hub map
 *     - .arscontexta — vault marker file (enables vaultguard)
 *     - Generated skills (16 SKILL.md files with domain vocabulary applied)
 *
 *   Phase 6: Validation
 *     Checks generated vault against 15 kernel primitives in reference/kernel.yaml.
 *     Reports any missing components.
 *
 * OPENCODE ADAPTATION
 * -------------------
 * The primary difference from the Claude Code version: no AskUserQuestion tool.
 * The derivation conversation runs as inline chat turns instead of structured forms.
 *
 * This means:
 * - Questions appear as Claude messages in the normal chat flow
 * - User responds in chat (same UX as any other conversation)
 * - Claude must detect when all necessary information has been gathered
 * - Less structured but functionally equivalent
 *
 * The skill instructions (in skill-sources/setup/SKILL.md) handle the conversation
 * logic. This TypeScript file is just the entry point and utility functions.
 *
 * GENERATED opencode.json
 * -----------------------
 * One key difference from the Claude Code version: /setup generates opencode.json
 * instead of writing to .claude/settings.json. The generated file:
 *
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "plugin": ["intent-computer"],
 *     "mcp": {
 *       "qmd": {
 *         "type": "local",
 *         "command": "qmd",
 *         "args": ["mcp"]
 *       }
 *     },
 *     "permission": {
 *       "read": "allow",
 *       "edit": "allow",
 *       "write": "allow"
 *     }
 *   }
 *
 * INVOCATION
 * ----------
 * /setup                    Full setup (recommended for new vaults)
 * /setup --advanced         Expose all 8 dimension controls upfront
 * /arscontexta:setup        Same as /setup (plugin namespace)
 * "set up my knowledge system"   Natural language trigger
 *
 * TODO Phase 6:
 * - Port the full derivation conversation from ars-contexta's setup/SKILL.md
 * - Implement the 15 kernel primitive validation (reference/kernel.yaml)
 * - Generate domain-vocabulary-renamed skills (the vocabulary transform step)
 * - Test with all 3 preset configurations (research, personal, experimental)
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Generate the minimum required vault structure.
 *
 * This is called by the setup skill after the derivation conversation completes.
 * The skill's SKILL.md handles the conversation; this function handles the file I/O.
 *
 * In Phase 6, the actual generation logic (dimension derivation, vocabulary
 * transform, kernel validation) lives in skill-sources/setup/SKILL.md as Claude
 * instructions. This function is the I/O layer that Claude calls via tool use.
 *
 * TODO Phase 6: make this callable as a custom tool so the setup skill can
 * trigger it after derivation. Current implementation is a utility for testing.
 */
export function scaffoldVault(vaultRoot: string, config: VaultConfig): void {
  const dirs = [
    "thoughts",
    "inbox",
    "archive",
    "self",
    "self/memory",
    "ops",
    "ops/queue",
    "ops/queue/temp",
    "ops/sessions",
    "ops/observations",
    "ops/tensions",
    "ops/methodology",
    "ops/scripts",
    "templates",
  ];

  for (const dir of dirs) {
    const fullPath = join(vaultRoot, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // Vault marker
  writeFileSync(join(vaultRoot, ".arscontexta"), "", "utf-8");

  // Minimal queue
  writeFileSync(
    join(vaultRoot, "ops", "queue", "queue.json"),
    JSON.stringify(
      {
        version: 1,
        lastUpdated: new Date().toISOString(),
        tasks: [],
      },
      null,
      2
    ),
    "utf-8"
  );

  // opencode.json
  writeFileSync(
    join(vaultRoot, "opencode.json"),
    JSON.stringify(generateOpencodeConfig(config), null, 2),
    "utf-8"
  );

  // .mcp.json for qmd
  if (config.semanticSearch) {
    writeFileSync(
      join(vaultRoot, ".mcp.json"),
      JSON.stringify(generateMcpConfig(), null, 2),
      "utf-8"
    );
  }
}

export interface VaultConfig {
  domain: string;
  vocabularyMap: Record<string, string>;
  semanticSearch: boolean;
  selfSpace: boolean;
  processingDepth: "light" | "standard" | "heavy";
  automation: "none" | "partial" | "full";
}

function generateOpencodeConfig(config: VaultConfig): Record<string, unknown> {
  const mcpSection: Record<string, unknown> = {};

  if (config.semanticSearch) {
    mcpSection.qmd = {
      type: "local",
      command: "qmd",
      args: ["mcp"],
    };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    plugin: ["intent-computer"],
    ...(Object.keys(mcpSection).length > 0 ? { mcp: mcpSection } : {}),
    permission: {
      read: "allow",
      edit: "allow",
      write: "allow",
    },
  };
}

function generateMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      qmd: {
        command: "qmd",
        args: ["mcp"],
        autoapprove: [
          "mcp__qmd__search",
          "mcp__qmd__vector_search",
          "mcp__qmd__deep_search",
          "mcp__qmd__get",
          "mcp__qmd__multi_get",
          "mcp__qmd__status",
        ],
      },
    },
  };
}
