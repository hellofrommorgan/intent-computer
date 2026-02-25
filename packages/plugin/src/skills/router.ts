/**
 * router.ts
 *
 * Command detection and dispatch. Identifies which skill is being invoked
 * from slash commands, natural language trigger phrases, or mixed input.
 *
 * Reads ops/derivation-manifest.md to get domain-renamed command vocabulary.
 * Falls back to ars-contexta defaults if no manifest found.
 *
 * State management: the router holds activeSkill between
 * command.execute.before and experimental.chat.system.transform hooks.
 * Cleared after injection.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadVocabulary as parseVocabulary } from "@intent-computer/architecture";

// Skill registry: canonical name → trigger patterns
// Patterns are checked in order — more specific first
const SKILL_PATTERNS: Record<string, RegExp[]> = {
  setup: [
    /^\/setup\b/i,
    /\bset up (my |a )?knowledge system\b/i,
    /\bcreate (my |a )?vault\b/i,
    /^\/arscontexta:setup\b/i,
  ],
  help: [
    /^\/help\b/i,
    /^\/intent\b/i,
    /^\/arscontexta:help\b/i,
    /\bshow (me )?(available )?commands\b/i,
    /\bwhat can (i|you) do\b/i,
  ],
  reduce: [
    /^\/reduce\b/i,
    /^\/surface\b/i,
    /\bextract insights?\b/i,
    /\bmine (this|the file)\b/i,
    /\bprocess this\b/i,
    /\bsurface (this|insights?)\b/i,
  ],
  reflect: [
    /^\/reflect\b/i,
    /\bfind connections?\b/i,
    /\bupdate (maps?|mocs?)\b/i,
    /\bconnect (these|the) thoughts?\b/i,
  ],
  reanalyze: [
    /^\/reanalyze\s+--stale\b/i,
    /^\/reanalyze\s+--weak\b/i,
    /^\/reanalyze\s+--cascade\b/i,
    /^\/reanalyze\b/i,
  ],
  reweave: [
    /^\/reweave\b/i,
    /^\/revisit\b/i,
    /\bupdate old thoughts?\b/i,
    /\bbackward connections?\b/i,
    /\brevisit thoughts?\b/i,
  ],
  verify: [
    /^\/verify\b/i,
    /\bverify thought quality\b/i,
    /\bcheck thought health\b/i,
  ],
  validate: [
    /^\/validate\b/i,
    /\bcheck schema\b/i,
    /\bvalidate (thought|all|schema)\b/i,
  ],
  seed: [
    /^\/seed\b/i,
    /\bqueue (this|for processing)\b/i,
    /\badd (to )?queue\b/i,
  ],
  process: [
    /^\/process\b/i,
    /\bprocess queue\b/i,
    /\brun pipeline tasks?\b/i,
  ],
  tasks: [
    /^\/tasks\b/i,
    /\bshow tasks?\b/i,
    /\bwhat'?s pending\b/i,
    /\btask (list|queue)\b/i,
    /\bqueue status\b/i,
  ],
  stats: [
    /^\/stats\b/i,
    /\bvault stats?\b/i,
    /\bshow metrics?\b/i,
    /\bhow big is (my )?vault\b/i,
  ],
  graph: [
    /^\/graph\b/i,
    /\bfind synthesis opportunities\b/i,
    /\bgraph analysis\b/i,
  ],
  next: [
    /^\/next\b/i,
    /\bwhat should i do\b/i,
    /\bwhat'?s next\b/i,
  ],
  learn: [
    /^\/learn\b/i,
    /\bresearch (this|about)\b/i,
    /\bfind out about\b/i,
  ],
  remember: [
    /^\/remember\b/i,
    /\bcapture friction\b/i,
    /\bcapture (this )?methodology\b/i,
    /\bmine.?sessions?\b/i,
  ],
  rethink: [
    /^\/rethink\b/i,
    /\breview (accumulated )?observations?\b/i,
    /\bchallenge assumptions?\b/i,
  ],
  refactor: [
    /^\/refactor\b/i,
    /\brestructure vault\b/i,
  ],
  health: [
    /^\/arscontexta:health\b/i,
    /^\/health\b/i,
    /\bcheck vault health\b/i,
    /\bmaintenance report\b/i,
  ],
  ask: [
    /^\/arscontexta:ask\b/i,
    /^\/ask\b/i,
    /\bwhy does (my system|this)\b/i,
    /\bhow should i (structure|organize)\b/i,
  ],
  architect: [
    /^\/arscontexta:architect\b/i,
  ],
  recommend: [
    /^\/arscontexta:recommend\b/i,
  ],
  reseed: [
    /^\/arscontexta:reseed\b/i,
  ],
  upgrade: [
    /^\/arscontexta:upgrade\b/i,
  ],
  "add-domain": [
    /^\/arscontexta:add-domain\b/i,
    /\badd (a )?new (knowledge )?domain\b/i,
  ],
  tutorial: [
    /^\/arscontexta:tutorial\b/i,
    /\/tutorial\b/i,
    /\bwalk me through\b/i,
    /\bhow do i use (this|the system)\b/i,
  ],
};

export interface Router {
  detect(input: string): string | null;
  setActive(skill: string, rawInput?: string): void;
  getActive(): string | null;
  getActiveArgs(): string;
  clearActive(): void;
  vocabulary: Record<string, string>;
}

export async function createRouter(vaultRoot: string): Promise<Router> {
  const vocabulary = await loadVocabulary(vaultRoot);
  const deprecatedVocabularyKeys = new Set(["ralph", "pipeline"]);
  let activeSkill: string | null = null;
  let activeArgs: string = "";

  return {
    vocabulary,

    detect(input: string): string | null {
      // Check domain vocabulary aliases first (from derivation-manifest)
      for (const [canonical, alias] of Object.entries(vocabulary)) {
        if (deprecatedVocabularyKeys.has(canonical)) continue;
        if (alias && input.toLowerCase().startsWith(`/${alias.toLowerCase()}`)) {
          return canonical;
        }
      }

      // Check canonical patterns
      for (const [skill, patterns] of Object.entries(SKILL_PATTERNS)) {
        for (const pattern of patterns) {
          if (pattern.test(input)) {
            return skill;
          }
        }
      }

      return null;
    },

    setActive(skill: string, rawInput?: string): void {
      activeSkill = skill;
      activeArgs = rawInput ?? "";
    },

    getActive(): string | null {
      return activeSkill;
    },

    getActiveArgs(): string {
      return activeArgs;
    },

    clearActive(): void {
      activeSkill = null;
      activeArgs = "";
    },
  };
}

async function loadVocabulary(vaultRoot: string): Promise<Record<string, string>> {
  const manifestPaths = [
    join(vaultRoot, "ops", "derivation-manifest.md"),
  ];

  for (const p of manifestPaths) {
    if (!existsSync(p)) continue;

    const content = readFileSync(p, "utf-8");
    const vocab = parseVocabulary(content);
    const commandAliases: Record<string, string> = {};
    for (const [key, value] of Object.entries(vocab)) {
      if (!key.startsWith("cmd_")) continue;
      commandAliases[key.slice(4)] = value;
    }
    return commandAliases;
  }

  return {}; // No manifest — use canonical names only
}
