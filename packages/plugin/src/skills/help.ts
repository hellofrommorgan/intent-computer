/**
 * help.ts — Phase 3
 *
 * Discovery surface for the /intent meta-command.
 *
 * Problem: opencode has no registerCommand() API. Plugins cannot add user-invocable
 * slash commands with autocomplete. Users have no way to discover what skills are
 * available without reading the docs.
 *
 * Solution: intercept `/intent` (and variants) in command.execute.before, then
 * inject a formatted command reference into the system prompt via
 * experimental.chat.system.transform. Claude surfaces this to the user as a
 * formatted help response.
 *
 * The help output reads ops/derivation-manifest.md to show the user their actual
 * domain-renamed commands (e.g., "/claims" not "/reduce" for a research vault).
 * Falls back to canonical names if no manifest exists.
 *
 * Trigger patterns (handled by router.ts):
 *   /intent
 *   /intent help
 *   /help (if not already claimed by opencode)
 *   "what commands are available"
 *   "what can I do"
 *   "show me the skills"
 *
 * Output format (injected into system prompt, Claude formats for user):
 *
 *   === INTENT COMPUTER — AVAILABLE COMMANDS ===
 *
 *   PROCESSING (extract and connect knowledge)
 *     /reduce [file]       Extract insights from a source file
 *     /reflect [thought]   Find connections, update maps
 *     /reweave [thought]   Update older thoughts with new connections
 *     /verify [thought]    Quality check (schema + description + links)
 *     /validate            Batch schema check across vault
 *
 *   ORCHESTRATION (queue-first execution)
 *     /seed [file]         Queue a source file for processing
 *     /process [N]         Process N queue tasks
 *     /tasks               View and manage the queue
 *
 *   NAVIGATION (vault status and analysis)
 *     /stats               Vault metrics and health summary
 *     /graph               Graph analysis queries
 *     /next                Recommend highest-value next action
 *
 *   GROWTH (research and learning)
 *     /learn [topic]       Research a topic and grow the graph
 *     /remember [note]     Capture friction, mine sessions (--mine-sessions)
 *     /rethink             Review accumulated observations and tensions
 *     /refactor            Restructure vault organization
 *
 *   SYSTEM (meta and setup)
 *     /setup               Generate a new vault (first-time setup)
 *     /intent              Show this help
 *
 *   PLUGIN SKILLS (arscontexta namespace)
 *     /arscontexta:help, :ask, :health, :architect, :recommend,
 *     :tutorial, :reseed, :upgrade, :add-domain
 *
 *   === END COMMANDS ===
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface CommandEntry {
  canonical: string;
  alias: string; // domain-renamed, falls back to canonical
  description: string;
  argHint: string;
  tier: "processing" | "orchestration" | "navigation" | "growth" | "system" | "plugin";
}

const COMMAND_REGISTRY: Omit<CommandEntry, "alias">[] = [
  // Processing
  { canonical: "reduce", description: "Extract structured insights from a source file", argHint: "[file]", tier: "processing" },
  { canonical: "reflect", description: "Find connections between thoughts, update maps", argHint: "[thought]", tier: "processing" },
  { canonical: "reweave", description: "Update older thoughts with new backward connections", argHint: "[thought]", tier: "processing" },
  { canonical: "verify", description: "Quality check — schema, description, and links", argHint: "[thought]", tier: "processing" },
  { canonical: "validate", description: "Batch schema compliance check across vault", argHint: "", tier: "processing" },
  // Orchestration
  { canonical: "seed", description: "Queue a source file for pipeline processing", argHint: "[file]", tier: "orchestration" },
  { canonical: "process", description: "Process N queue tasks from the orchestration queue", argHint: "[N]", tier: "orchestration" },
  { canonical: "tasks", description: "View and manage the processing queue", argHint: "", tier: "orchestration" },
  // Navigation
  { canonical: "stats", description: "Vault metrics, link density, orphan count", argHint: "", tier: "navigation" },
  { canonical: "graph", description: "Graph analysis — orphans, synthesis opportunities", argHint: "", tier: "navigation" },
  { canonical: "next", description: "Recommend highest-value next action", argHint: "", tier: "navigation" },
  // Growth
  { canonical: "learn", description: "Research a topic and grow the knowledge graph", argHint: "[topic]", tier: "growth" },
  { canonical: "remember", description: "Capture friction and methodology learnings", argHint: "[note]", tier: "growth" },
  { canonical: "rethink", description: "Review accumulated observations and tensions", argHint: "", tier: "growth" },
  { canonical: "refactor", description: "Restructure vault organization", argHint: "", tier: "growth" },
  // System
  { canonical: "setup", description: "Generate a new knowledge vault (first-time setup)", argHint: "", tier: "system" },
  { canonical: "intent", description: "Show available commands (this)", argHint: "", tier: "system" },
];

export async function buildHelpText(vaultRoot: string): Promise<string> {
  const aliases = await loadAliases(vaultRoot);

  const commands: CommandEntry[] = COMMAND_REGISTRY.map((cmd) => ({
    ...cmd,
    alias: aliases[cmd.canonical] ?? cmd.canonical,
  }));

  const byTier = (tier: CommandEntry["tier"]) =>
    commands.filter((c) => c.tier === tier);

  const formatRow = (c: CommandEntry) => {
    const cmd = `/${c.alias}${c.argHint ? " " + c.argHint : ""}`;
    const pad = Math.max(0, 22 - cmd.length);
    return `  ${cmd}${" ".repeat(pad)} ${c.description}`;
  };

  const section = (title: string, tier: CommandEntry["tier"]) => {
    const rows = byTier(tier).map(formatRow).join("\n");
    return rows ? `${title}\n${rows}` : "";
  };

  const parts = [
    "=== INTENT COMPUTER — AVAILABLE COMMANDS ===",
    "",
    section("PROCESSING (extract and connect knowledge)", "processing"),
    "",
    section("ORCHESTRATION (queue-first execution)", "orchestration"),
    "",
    section("NAVIGATION (vault status and analysis)", "navigation"),
    "",
    section("GROWTH (research and learning)", "growth"),
    "",
    section("SYSTEM", "system"),
    "",
    "PLUGIN SKILLS (arscontexta namespace)",
    "  /arscontexta:help     Contextual guidance and command discovery",
    "  /arscontexta:ask      Query the methodology research knowledge base",
    "  /arscontexta:health   Vault diagnostics (orphans, links, schema)",
    "  /arscontexta:architect  Research-backed evolution advice",
    "  /arscontexta:recommend  Architecture recommendations for your use case",
    "  /arscontexta:tutorial   Interactive walkthrough",
    "  /arscontexta:reseed   Re-derive system from first principles",
    "  /arscontexta:upgrade  Apply knowledge base updates",
    "  /arscontexta:add-domain  Add a new knowledge domain",
    "",
    "=== END COMMANDS ===",
  ].filter((s) => s !== undefined);

  return parts.join("\n");
}

async function loadAliases(vaultRoot: string): Promise<Record<string, string>> {
  const manifestPath = join(vaultRoot, "ops", "derivation-manifest.md");
  if (!existsSync(manifestPath)) return {};

  const content = readFileSync(manifestPath, "utf-8");
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
  if (!frontmatterMatch) return {};

  const aliases: Record<string, string> = {};
  const matches = frontmatterMatch[1].matchAll(/cmd_(\w+):\s*(.+)/g);
  for (const m of matches) {
    aliases[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return aliases;
}
